import { spawn, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile, access } from 'node:fs/promises';
import * as path from 'node:path';
import { task } from '@trigger.dev/sdk';
import * as v from 'valibot';
import { RunnerDispatchSchema, RUNNER_CONTRACT_VERSION, type RunnerDispatch, type RunnerCallback } from '../src/agent-runs/runner-contract';
import { localWorkspace, type Workspace } from './workspace/provider';
import { parseOwnerRepo, pushBranch, openOrUpdatePullRequest } from './github';

const execFile = promisify(execFileCb);

async function callback(d: { callback: { url: string; token: string } }, body: RunnerCallback) {
  await fetch(d.callback.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hatchery-agent-runner-token': d.callback.token },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Slugify for a git branch segment: lowercase, non-alphanumerics → '-', collapse/trim hyphens. */
function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Branch the run should use.
 * - continuation (targetBranch set): the clone is already on it → return it as-is.
 * - initial: `hatchery/<slug(issue.identifier ?? runId)>-<short>`.
 * Pure so it can be unit-tested; `short` is supplied by the caller.
 */
export function runBranchName(d: Pick<RunnerDispatch, 'targetBranch' | 'issue' | 'runId'>, short: string): string {
  if (d.targetBranch) return d.targetBranch;
  return `hatchery/${slug(d.issue?.identifier ?? d.runId)}-${short}`;
}

// ---------------------------------------------------------------------------
// pi invocation
// ---------------------------------------------------------------------------

/**
 * Run `pi -p` as a child process. Prompt is written to stdin (ending stdin avoids a no-input login hang).
 * Resolves with stdout/stderr/code; the caller decides what a non-zero code means.
 */
function runPi(opts: { args: string[]; cwd: string; prompt: string }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('pi', opts.args, {
      cwd: opts.cwd,
      env: { ...process.env, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });

    // ENOENT here = pi binary not installed → clear, actionable message.
    child.on('error', (err) => reject(new Error(`failed to spawn pi: ${err.message}`)));
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));

    // If pi exits before draining stdin, the write/end below can emit EPIPE as an unhandled
    // stream 'error' — an async throw that would bypass the task's catch→failed callback. The
    // 'close' handler above still drives the outcome via exit code, so swallow stdin errors.
    child.stdin.on('error', () => {});

    // End stdin after writing the prompt — this is what prevents the no-input hang.
    child.stdin.write(opts.prompt);
    child.stdin.end();
  });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export const runCodingTask = task({
  id: 'run-coding-task',
  maxDuration: 2700, // matches the config default; a maxDuration kill skips cleanup — Hatchery's reaper closes the run.
  run: async (raw) => {
    const d = v.parse(RunnerDispatchSchema, raw);                 // consumer↔contract assertion
    await callback(d, { contractVersion: RUNNER_CONTRACT_VERSION, runId: d.runId, status: 'running' });

    let ws: Workspace | undefined;
    try {
      // --- Kit resolution + existence assertion (fail fast, before a wasted clone) ---
      // LIVE-UNVERIFIED (kit path): pi runs with cwd = the cloned target repo, so --skill/policy
      // paths must be ABSOLUTE. In `trigger dev` the task cwd is the runner repo root, so this works;
      // bundling the kit for `deploy` is a deferred concern.
      const KIT_ROOT = process.env.KIT_ROOT ?? process.cwd();
      const kitDir = path.resolve(KIT_ROOT, 'agent-kits/coding-default');
      const policyPath = path.join(kitDir, 'policy.md');
      const testEvidenceSkill = path.join(kitDir, 'skills/test-evidence.md');
      const prSummarySkill = path.join(kitDir, 'skills/pr-summary.md');
      for (const p of [kitDir, policyPath, testEvidenceSkill, prSummarySkill]) {
        if (!(await fileExists(p))) {
          throw new Error(`kit not found at ${p} — set KIT_ROOT`);
        }
      }
      const policyText = await readFile(policyPath, 'utf8');

      // --- Acquire workspace (clone) ---
      ws = await localWorkspace.acquire({
        repo: d.targetRepo,
        baseBranch: d.baseBranch,
        targetBranch: d.targetBranch,
        githubToken: d.githubToken,
        policy: d.workspacePolicy,
      });

      // --- Branch ---
      const short = randomUUID().slice(0, 8);
      const branch = runBranchName(d, short);
      if (!d.targetBranch) {
        // initial: the clone is on baseBranch; create the new run branch.
        await execFile('git', ['-C', ws.dir, 'checkout', '-b', branch]);
      }
      // continuation: the clone is already on d.targetBranch — nothing to do.

      // --- Prompt ---
      const prompt = d.targetBranch
        ? (d.feedback ?? '')
        : `${d.issue?.title ?? ''}\n\n${d.issue?.description ?? ''}`.trim();

      // --- Run pi (single pass: policy + the two skills + the task prompt) ---
      const piArgs = [
        '-p',
        '--mode', 'json',
        '--provider', 'zai',
        '--model', 'glm-5.1',
        '--thinking', 'high',
        '--no-session',
        '--skill', testEvidenceSkill,
        '--skill', prSummarySkill,
        '--append-system-prompt', policyText,
      ];
      const piResult = await runPi({ args: piArgs, cwd: ws.dir, prompt });
      if (piResult.code !== 0) {
        // LIVE-UNVERIFIED: relies on pi -p exiting non-zero on failure; if it exits 0 on error,
        // switch to parsing the --mode json event stream.
        throw new Error(`pi exited with code ${piResult.code}: ${piResult.stderr.slice(-500)}`);
      }

      // --- Commit ---
      await execFile('git', ['-C', ws.dir, 'add', '-A']);
      const { stdout: statusOut } = await execFile('git', ['-C', ws.dir, 'status', '--porcelain']);
      if (statusOut.trim() === '') {
        // pi made no edits — no PR. Cleanup still runs in finally.
        await callback(d, {
          contractVersion: RUNNER_CONTRACT_VERSION,
          runId: d.runId,
          status: 'completed',
          summary: 'pi made no changes; no PR opened',
        });
        return { ok: true };
      }

      const commitMsg = d.issue?.title ?? ('Hatchery run ' + d.runId);
      await execFile('git', ['-C', ws.dir, 'commit', '-m', commitMsg]);
      const { stdout: shaOut } = await execFile('git', ['-C', ws.dir, 'rev-parse', 'HEAD']);
      const commitSha = shaOut.trim();

      // --- Push ---
      await pushBranch(ws.dir, branch);

      // --- PR ---
      const { owner, repo } = parseOwnerRepo(d.targetRepo);
      const pr = await openOrUpdatePullRequest({
        owner,
        repo,
        head: branch,
        base: d.baseBranch,
        title: d.issue?.title ?? ('Hatchery run ' + d.runId),
        body: 'Automated run by Hatchery (pi/glm-5.1). Run: ' + d.runId,
        token: d.githubToken,
      });

      await callback(d, {
        contractVersion: RUNNER_CONTRACT_VERSION,
        runId: d.runId,
        status: 'pr_opened',
        branch,
        commitSha,
        prUrl: pr.url,
      });
      await callback(d, {
        contractVersion: RUNNER_CONTRACT_VERSION,
        runId: d.runId,
        status: 'completed',
        summary: (pr.created ? 'opened' : 'updated') + ' PR ' + pr.url,
      });

      return { ok: true, prUrl: pr.url };
    } catch (e) {
      // Sanitize the FULL message before slicing — slicing first could bisect a redaction window
      // and leak a token fragment. The message may come from git, pi, or fetch — redact regardless.
      const message = e instanceof Error ? e.message : String(e);
      const sanitized = message.split(d.githubToken).join('***');
      await callback(d, {
        contractVersion: RUNNER_CONTRACT_VERSION,
        runId: d.runId,
        status: 'failed',
        error: sanitized.slice(0, 500),
      });
      throw e; // re-throw so Trigger marks the run failed too
    } finally {
      await ws?.cleanup().catch(() => {});
    }
  },
});
