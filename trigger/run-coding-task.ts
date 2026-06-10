import { spawn, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, access, mkdir, cp, appendFile } from 'node:fs/promises';
import * as path from 'node:path';
import { task } from '@trigger.dev/sdk';
import * as v from 'valibot';
import { RunnerDispatchSchema, RUNNER_CONTRACT_VERSION, type RunnerDispatch, type RunnerCallback } from '../src/agent-runs/runner-contract';
import { localWorkspace, type Workspace } from './workspace/provider';
import { parseOwnerRepo, pushBranch, openOrUpdatePullRequest } from './github';
import { PiRpcClient, parsePiStream, type PiOutcome } from './pi-rpc-client';

// parsePiStream lives in pi-rpc-client (shared by both runtimes); re-export keeps existing importers working.
export { parsePiStream };

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

/** Issue id used for delivery-kit paths and the branch — sanitized, case preserved (FRD-12 stays FRD-12). */
export function deliveryIssueId(d: Pick<RunnerDispatch, 'issue' | 'runId'>): string {
  return (d.issue?.identifier ?? d.runId).replace(/[^A-Za-z0-9._-]+/g, '-');
}

/**
 * Deterministic issue-scoped branch for the delivery kit: `harness/<identifier|runId>`.
 * Same issue → same branch on every dispatch — the resume/HITL/crash re-dispatch story
 * (handoff cursor + committed artifacts) depends on the branch being computable from the
 * issue alone, unlike coding-default's run-scoped `hatchery/<slug>-<uuid8>`.
 */
export function deliveryBranchName(d: Pick<RunnerDispatch, 'targetBranch' | 'issue' | 'runId'>): string {
  if (d.targetBranch) return d.targetBranch;
  return `harness/${deliveryIssueId(d)}`;
}

/** Strip a leading YAML frontmatter block — pi agent files carry one; a --system-prompt file must not. */
export function stripFrontmatter(src: string): string {
  const m = src.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? src.slice(m[0].length) : src;
}

/** The conductor's own model id from defaults.yaml's `models: conductor:` line (no provider prefix). */
export function conductorModelFromDefaults(yamlText: string): string | undefined {
  const m = yamlText.match(/^\s*conductor:\s*([^\s#]+)/m);
  return m ? m[1] : undefined;
}

// ---------------------------------------------------------------------------
// Capability extensions
// ---------------------------------------------------------------------------

/**
 * pi packages loaded into the runner (bundled at deploy via trigger.config additionalPackages).
 * ask-user is intentionally absent: it blocks on human input and would hang a `pi -p` run.
 * web-access/mcp-adapter need network — runPi no longer sets PI_OFFLINE.
 */
const RUNNER_PI_EXTENSIONS = ['pi-subagents', 'pi-web-access', 'pi-mcp-adapter', '@jerryan/pi-todo-lite'] as const;

/** Absolute extension entry paths declared by a package manifest's `pi.extensions`. */
export function extensionEntriesFromManifest(pkgDir: string, pi: { extensions?: string[] } | undefined): string[] {
  return (pi?.extensions ?? []).map((rel) => path.resolve(pkgDir, rel));
}

/** Turn resolved extension entry paths into pi `-e <path>` CLI args. */
export function extensionFlags(entryPaths: string[]): string[] {
  return entryPaths.flatMap((p) => ['-e', p]);
}

/**
 * Resolve `-e` flags for the bundled extensions from the container's `node_modules` (where
 * additionalPackages installs them — same root the spawn PATH already assumes). Unresolvable
 * packages are skipped with a warning: under `trigger dev` additionalPackages is ignored, so the
 * dev-machine pi falls back to its own ~/.pi settings.json packages instead.
 */
async function resolveExtensionFlags(): Promise<string[]> {
  const root = path.join(process.cwd(), 'node_modules');
  const entries: string[] = [];
  for (const pkg of RUNNER_PI_EXTENSIONS) {
    try {
      const pkgDir = path.join(root, pkg);
      const manifest = JSON.parse(await readFile(path.join(pkgDir, 'package.json'), 'utf8')) as {
        pi?: { extensions?: string[] };
      };
      entries.push(...extensionEntriesFromManifest(pkgDir, manifest.pi));
    } catch {
      console.warn(`[runner] extension ${pkg} not resolvable under ${root} (expected with \`trigger dev\`); skipping -e`);
    }
  }
  return extensionFlags(entries);
}

/**
 * Make the kit's subagents discoverable by pi-subagents. Discovery is project-scoped from pi's cwd
 * (the clone) → `<clone>/.pi/agents`. Since the runner does `git add -A`, `.pi/` is added to the
 * clone's local git exclude so the kit never leaks into the PR (the repo's tracked .gitignore is untouched).
 */
async function installKitAgents(wsDir: string, kitDir: string): Promise<void> {
  const agentsSrc = path.join(kitDir, 'agents');
  if (!(await fileExists(agentsSrc))) {
    console.warn(`[runner] kit has no agents/ dir at ${agentsSrc}; subagent delegation will use builtins only`);
    return;
  }
  await mkdir(path.join(wsDir, '.pi'), { recursive: true });
  await cp(agentsSrc, path.join(wsDir, '.pi', 'agents'), { recursive: true });
  await appendFile(
    path.join(wsDir, '.git', 'info', 'exclude'),
    '\n# Hatchery runner kit — not part of the change\n.pi/\n',
  );
}

/**
 * Install the delivery kit into the clone: agents + skills + extensions under `.pi/`
 * (pi auto-discovers all three from cwd — including `gated_dispatch`), and the kit's
 * `defaults.yaml` → `.harness/defaults.yaml` unless the target repo ships its own.
 * `.pi/` and the runner-provided config/scratch are git-excluded; the artifact ledger
 * (`.harness/issues/`) stays committable — it IS the work envelope.
 */
async function installDeliveryKit(wsDir: string, kitDir: string): Promise<void> {
  await mkdir(path.join(wsDir, '.pi'), { recursive: true });
  for (const part of ['agents', 'skills', 'extensions'] as const) {
    await cp(path.join(kitDir, part), path.join(wsDir, '.pi', part), { recursive: true });
  }
  const defaultsDst = path.join(wsDir, '.harness', 'defaults.yaml');
  if (!(await fileExists(defaultsDst))) {
    await mkdir(path.join(wsDir, '.harness'), { recursive: true });
    await cp(path.join(kitDir, 'defaults.yaml'), defaultsDst);
  }
  await appendFile(
    path.join(wsDir, '.git', 'info', 'exclude'),
    '\n# Hatchery delivery kit + scratch — not part of the change\n.pi/\n.harness/defaults.yaml\n.harness/runs/\n.harness/worktrees/\n',
  );
}

/** The conductor's continuation cursor, if a prior dispatch committed one. Absence is fine — state derives from the tree. */
async function readCursor(wsDir: string, issueId: string): Promise<{ next?: string | null; done?: string[]; parked_question?: string | null; pr_url?: string; last_comment_id?: string } | undefined> {
  try {
    return JSON.parse(await readFile(path.join(wsDir, '.harness', 'issues', issueId, 'handoff.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// pi invocation
// ---------------------------------------------------------------------------

/**
 * Env overrides shared by both runtimes (CLI spawn + RPC client).
 * - PATH: deploy installs pi via additionalPackages into the bundle's node_modules/.bin, not guaranteed
 *   on PATH; prepend it. (Local `trigger dev` falls through to the global pi.)
 * - Offline is intentionally NOT set: web-access/mcp-adapter need the network. This widens the runner's
 *   network surface (SSRF/exfil from untrusted repo content) — see threat-model TODO.
 */
function piEnvOverrides(): Record<string, string> {
  return {
    PATH: `${path.join(process.cwd(), 'node_modules/.bin')}:${process.env.PATH ?? ''}`,
    PI_SKIP_VERSION_CHECK: '1',
  };
}

/**
 * Run `pi -p` as a child process. Prompt is written to stdin (ending stdin avoids a no-input login hang).
 * Resolves with stdout/stderr/code; the caller decides what a non-zero code means.
 */
function runPi(opts: { args: string[]; cwd: string; prompt: string }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('pi', opts.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...piEnvOverrides() },
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

// ---------------------------------------------------------------------------
// Runtime selection: CLI (-p, default, prod-proven) vs RPC (opt-in, being proven in-container)
// ---------------------------------------------------------------------------

export type PiRuntime = 'cli' | 'rpc';

/**
 * Which pi runtime to drive. Default 'cli' (the prod-proven path); set HATCHERY_PI_RUNTIME=rpc to A/B
 * the RPC client on real runs before promoting it. Env-based so it flips per deploy without a contract change.
 */
export function piRuntime(env: NodeJS.ProcessEnv = process.env): PiRuntime {
  return env.HATCHERY_PI_RUNTIME === 'rpc' ? 'rpc' : 'cli';
}

export interface AgentRun {
  outcome: PiOutcome;
  exitCode: number; // CLI exit code; 0 for RPC (death/timeout reject inside runPrompt instead)
  stderr: string;
}

export interface AgentRunOpts {
  cwd: string;
  prompt: string;
  provider: string;
  model: string;
  /** Shared startup flags after provider/model: --thinking, --no-session, -e <ext>, --skill, --append-system-prompt. */
  commonArgs: string[];
  timeoutMs: number;
}

/** CLI path: one-shot `pi -p --mode json`; outcome parsed from the buffered JSON stream. */
async function runAgentViaCli(o: AgentRunOpts): Promise<AgentRun> {
  const args = ['-p', '--mode', 'json', '--provider', o.provider, '--model', o.model, ...o.commonArgs];
  const r = await runPi({ args, cwd: o.cwd, prompt: o.prompt });
  return { outcome: parsePiStream(r.stdout), exitCode: r.code, stderr: r.stderr };
}

/** RPC path: long-lived `pi --mode rpc` session; runPrompt rejects on process death/timeout. */
async function runAgentViaRpc(o: AgentRunOpts): Promise<AgentRun> {
  const client = new PiRpcClient({
    command: 'pi',
    cwd: o.cwd,
    env: piEnvOverrides(),
    provider: o.provider,
    model: o.model,
    args: o.commonArgs,
  });
  await client.start();
  try {
    const outcome = await client.runPrompt(o.prompt, { timeoutMs: o.timeoutMs });
    return { outcome, exitCode: 0, stderr: client.getStderr() };
  } finally {
    await client.stop().catch(() => {});
  }
}

/** Run the coding agent via the selected runtime. */
export function runAgent(runtime: PiRuntime, opts: AgentRunOpts): Promise<AgentRun> {
  return runtime === 'rpc' ? runAgentViaRpc(opts) : runAgentViaCli(opts);
}

// ---------------------------------------------------------------------------
// Delivery-kit path (kit === 'delivery'): conductor-as-parent, gated pipeline
// ---------------------------------------------------------------------------

/**
 * Run one issue through the delivery kit. Ownership split (v1, deliberate):
 * - CONDUCTOR owns: pipeline, all gates, commits to the issue branch (code + artifact ledger + cursor).
 * - RUNNER owns: clone, deterministic branch, kit install, push + PR (keeps the GitHub token
 *   out of the agent's env — full git-ownership flip is a later hardening decision), callbacks.
 * Trust gate at exit: clean worktree required (a live Step-1 run reported success with the fix
 * uncommitted — this check exists because of that run), cursor read for park routing.
 */
async function runDelivery(d: RunnerDispatch): Promise<{ ok: boolean; prUrl?: string }> {
  let ws: Workspace | undefined;
  try {
    // --- Kit resolution (fail fast) ---
    const KIT_ROOT = process.env.KIT_ROOT ?? process.cwd();
    const kitDir = path.resolve(KIT_ROOT, 'agent-kits/delivery');
    for (const p of [
      path.join(kitDir, 'agents/conductor.md'),
      path.join(kitDir, 'skills/reviewing/SKILL.md'),
      path.join(kitDir, 'extensions/gated-dispatch.ts'),
      path.join(kitDir, 'defaults.yaml'),
    ]) {
      if (!(await fileExists(p))) throw new Error(`delivery kit not found at ${p} — set KIT_ROOT`);
    }

    // --- Workspace + deterministic branch ---
    ws = await localWorkspace.acquire({
      repo: d.targetRepo,
      baseBranch: d.baseBranch,
      targetBranch: d.targetBranch,
      githubToken: d.githubToken,
      policy: d.workspacePolicy,
    });
    const issueId = deliveryIssueId(d);
    const branch = deliveryBranchName(d);
    if (!d.targetBranch) {
      // The branch may already exist remotely (crashed prior run the control plane doesn't know
      // about). Resume it instead of recreating from base — committed artifacts ARE the state.
      const { stdout: remoteRef } = await execFile('git', ['-C', ws.dir, 'ls-remote', 'origin', `refs/heads/${branch}`]);
      if (remoteRef.trim() !== '') {
        await execFile('git', ['-C', ws.dir, 'fetch', 'origin', branch]);
        await execFile('git', ['-C', ws.dir, 'checkout', '-B', branch, 'FETCH_HEAD']);
      } else {
        await execFile('git', ['-C', ws.dir, 'checkout', '-b', branch]);
      }
    }
    // Conductor commits under this identity (cloud container has none).
    await execFile('git', ['-C', ws.dir, 'config', 'user.email', 'runner@hatchery.dev']);
    await execFile('git', ['-C', ws.dir, 'config', 'user.name', 'Hatchery Runner']);

    // --- Kit install + conductor boot material ---
    await installDeliveryKit(ws.dir, kitDir);
    const defaultsText = await readFile(path.join(ws.dir, '.harness', 'defaults.yaml'), 'utf8');
    const conductorTier = conductorModelFromDefaults(defaultsText);
    if (!conductorTier) throw new Error('delivery defaults.yaml has no models.conductor tier — runner cannot pick the parent model');
    const systemPromptPath = path.join(ws.dir, '.pi', 'conductor-system.md'); // inside the git-excluded .pi/
    await writeFile(systemPromptPath, stripFrontmatter(await readFile(path.join(kitDir, 'agents/conductor.md'), 'utf8')));

    // --- Prompt: command + Runner Handoff envelope + binding environment contract ---
    const cursor = await readCursor(ws.dir, issueId);
    const handoff = {
      source: 'the runner',
      contractVersion: RUNNER_CONTRACT_VERSION,
      runId: d.runId,
      issueId,
      issue: d.issue, // title/description/url inline — the conductor has no tracker access here
      repo: d.targetRepo,
      baseBranch: d.baseBranch,
      branch,
      trigger: d.targetBranch
        ? { reason: 'continuation', state: 'human-reply-or-retry' }
        : { reason: 'initial', state: 'run-agent' },
      allowedOutcomes: ['in_review', 'needs_attention', 'decomposed'],
    };
    const continuation = d.feedback || cursor?.parked_question
      ? `\n\n## Human reply (continuation)\n${d.feedback ?? '(none — re-dispatch/retry)'}\n` +
        (cursor?.parked_question ? `\n## You previously parked with this question (verbatim)\n${cursor.parked_question}\n` : '')
      : '';
    const prompt = `deliver ${issueId} --unattended --auto

Runner Handoff: ${JSON.stringify(handoff, null, 2)}

Runner environment contract (binding):
- The workspace IS the issue worktree: you are already on branch ${branch} at the repository root. Do not create .harness/worktrees/ entries; work in place.
- Commit the artifact ledger (.harness/issues/${issueId}/) and code changes to this branch as steps complete. Do NOT push, do NOT open a PR, do NOT post to any tracker — the runner owns push + PR; your committed state and the handoff.json cursor are the handoff.
- Never report a terminal state with uncommitted changes: \`git status --porcelain\` must be empty when you finish.
- The issue body is inline in the Runner Handoff above; there is no tracker access in this environment.
- Provider is OpenRouter; read tier models from .harness/defaults.yaml per your model-selection rules.${continuation}`;

    // --- Run the conductor as pi parent ---
    const run = await runAgent(piRuntime(), {
      cwd: ws.dir,
      prompt,
      provider: 'openrouter',
      model: conductorTier,
      commonArgs: [
        '--thinking', 'high',
        '--no-session',
        ...(await resolveExtensionFlags()),
        '--system-prompt', systemPromptPath,
      ],
      timeoutMs: 2_400_000, // 40 min — the gated pipeline is long; still under maxDuration
    });
    if (run.exitCode !== 0 || !run.outcome.completed || run.outcome.errored) {
      const detail = run.outcome.errorMessage ?? run.outcome.finalText ?? run.stderr.slice(-500);
      throw new Error(`conductor run failed (exit=${run.exitCode}, completed=${run.outcome.completed}, errored=${run.outcome.errored}): ${detail}`.slice(0, 800));
    }

    // --- Outcome-trust gate ---
    const { stdout: dirty } = await execFile('git', ['-C', ws.dir, 'status', '--porcelain']);
    if (dirty.trim() !== '') {
      throw new Error(`delivery contract violation: conductor finished with uncommitted changes:\n${dirty.slice(0, 300)}`);
    }
    const after = await readCursor(ws.dir, issueId);
    const { stdout: shaOut } = await execFile('git', ['-C', ws.dir, 'rev-parse', 'HEAD']);
    const commitSha = shaOut.trim();
    // "Did the conductor produce anything?" — ledger presence, not commit counting (clone
    // reflogs are unreliable and a continuation starts with prior commits already on the branch).
    const ledgerExists = await fileExists(path.join(ws.dir, '.harness', 'issues', issueId));
    if (!ledgerExists) {
      // Capability halt before any analysis — nothing to push, nothing to review.
      await callback(d, { contractVersion: RUNNER_CONTRACT_VERSION, runId: d.runId, status: 'completed', summary: `conductor halted before producing artifacts: ${(run.outcome.finalText ?? '').slice(0, 300)}` });
      return { ok: true };
    }

    // --- Push + draft PR (runner-owned; PR body = the conductor's outcome announcement) ---
    await pushBranch(ws.dir, branch);
    const { owner, repo } = parseOwnerRepo(d.targetRepo);
    const parked = Boolean(after?.parked_question);
    const pr = await openOrUpdatePullRequest({
      owner,
      repo,
      head: branch,
      base: d.baseBranch,
      title: `${parked ? '[Blocked] ' : ''}${d.issue?.identifier ? `${d.issue.identifier}: ` : ''}${d.issue?.title ?? `Hatchery delivery ${d.runId}`}`,
      body: (run.outcome.finalText ?? `Delivery run ${d.runId}`).slice(0, 60_000),
      token: d.githubToken,
      draft: true,
    });
    await callback(d, { contractVersion: RUNNER_CONTRACT_VERSION, runId: d.runId, status: 'pr_opened', branch, commitSha, prUrl: pr.url });
    await callback(d, {
      contractVersion: RUNNER_CONTRACT_VERSION,
      runId: d.runId,
      status: 'completed',
      summary: parked
        ? `needs_attention: ${(after?.parked_question ?? '').slice(0, 300)}`
        : `${pr.created ? 'opened' : 'updated'} draft PR ${pr.url} (next: ${after?.next ?? 'terminal'})`,
    });
    return { ok: true, prUrl: pr.url };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const sanitized = message.split(d.githubToken).join('***');
    await callback(d, { contractVersion: RUNNER_CONTRACT_VERSION, runId: d.runId, status: 'failed', error: sanitized.slice(0, 500) });
    throw e;
  } finally {
    await ws?.cleanup().catch(() => {});
  }
}

export const runCodingTask = task({
  id: 'run-coding-task',
  // pi/GLM coding runs OOM the default small-1x (0.5GB) — confirmed TASK_PROCESS_OOM_KILLED on a
  // blogpost task. Trying small-2x (1GB); bump to medium-2x (4GB) if a real task still OOMs.
  machine: 'small-2x',
  maxDuration: 2700, // matches the config default; a maxDuration kill skips cleanup — Hatchery's reaper closes the run.
  run: async (raw) => {
    const d = v.parse(RunnerDispatchSchema, raw);                 // consumer↔contract assertion
    await callback(d, { contractVersion: RUNNER_CONTRACT_VERSION, runId: d.runId, status: 'running' });

    // Delivery kit = its own path (conductor-as-parent, gated pipeline, conductor-owned commits).
    // Everything below this line is the prod-proven coding-default path, untouched.
    if (d.kit === 'delivery') return runDelivery(d);

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

      // --- Kit subagents (project-scope discovery from pi's cwd; excluded from the commit) ---
      await installKitAgents(ws.dir, kitDir);

      // --- Prompt ---
      const prompt = d.targetBranch
        ? (d.feedback ?? '')
        : `${d.issue?.title ?? ''}\n\n${d.issue?.description ?? ''}`.trim();

      // --- Run the agent via the selected runtime (single pass: extensions + skills + policy + prompt) ---
      const runtime = piRuntime();
      const run = await runAgent(runtime, {
        cwd: ws.dir,
        prompt,
        // Unified on OpenRouter (one provider, one key — any model reachable). Same model as
        // before (GLM-5.1), now routed via OpenRouter as `z-ai/glm-5.1`, so coding-default's
        // behavior is unchanged while the provider stack is consolidated. Requires
        // OPENROUTER_API_KEY in the Trigger env (replaces the zai key). The delivery kit's
        // controller selects per-tier models through OpenRouter via .harness/defaults.yaml.
        provider: 'openrouter',
        model: 'z-ai/glm-5.1',
        commonArgs: [
          '--thinking', 'high',
          '--no-session',
          ...(await resolveExtensionFlags()),
          '--skill', testEvidenceSkill,
          '--skill', prSummarySkill,
          '--append-system-prompt', policyText,
        ],
        timeoutMs: 1_500_000, // 25 min, under the task maxDuration so a stuck RPC run fails cleanly
      });
      // Exit code is not trustworthy — pi exits 0 even when the model call errored (verified: a bad
      // model id returns HTTP 400, stopReason "error", exit 0). Require positive evidence of a clean
      // finish: a terminal agent_end whose final assistant turn did not stop with an error.
      if (run.exitCode !== 0 || !run.outcome.completed || run.outcome.errored) {
        const detail = run.outcome.errorMessage ?? run.outcome.finalText ?? run.stderr.slice(-500);
        throw new Error(
          `pi run failed (runtime=${runtime}, exit=${run.exitCode}, completed=${run.outcome.completed}, errored=${run.outcome.errored}): ${detail}`.slice(0, 800),
        );
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

      // The cloud container has no git identity (local `trigger dev` inherits ~/.gitconfig), so set a
      // deterministic one on the clone — otherwise `git commit` fails with "Please tell me who you are".
      await execFile('git', ['-C', ws.dir, 'config', 'user.email', 'runner@hatchery.dev']);
      await execFile('git', ['-C', ws.dir, 'config', 'user.name', 'Hatchery Runner']);
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
