// WorkspaceProvider — local clone implementation for M0.
// Runs inside the Trigger.dev Node container (not workerd): child_process, fs, os, crypto all available.
import { execFile as execFileCb } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface Workspace {
  dir: string;
  cleanup(): Promise<void>;
}

export interface WorkspaceProvider {
  // M0: always fresh-clones (targetBranch ?? baseBranch).
  // policy is accepted now but only 'fresh' is honoured; 'reuse_if_head_matches' is deferred to M0d.
  acquire(opts: {
    repo: string;
    baseBranch: string;
    targetBranch: string | null;
    githubToken: string;
    policy: 'fresh' | 'reuse_if_head_matches';
  }): Promise<Workspace>;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Build the HTTPS clone URL with an embedded token for GitHub.
 * Only handles https://github.com/... inputs — throws a clear error on anything else.
 *
 * Token-in-URL is acceptable for M0's ephemeral, single-tenant container; the later
 * hardening path is to use `git -c http.extraheader="Authorization: token <TOKEN>"` instead.
 */
export function authenticatedCloneUrl(repo: string, token: string): string {
  if (!repo.startsWith('https://github.com/')) {
    throw new Error(
      `authenticatedCloneUrl: only https://github.com/ repos are supported in M0, got: ${repo}`,
    );
  }
  // Normalise: strip trailing .git (if any), then always append exactly one.
  const base = repo.endsWith('.git') ? repo.slice(0, -4) : repo;
  // Inject the token as userinfo — standard GitHub HTTPS token form.
  // e.g. https://x-access-token:<token>@github.com/owner/repo.git
  const withoutScheme = base.slice('https://'.length);
  return `https://x-access-token:${token}@${withoutScheme}.git`;
}

/** Returns targetBranch when set, baseBranch when targetBranch is null. */
export function branchToClone(targetBranch: string | null, baseBranch: string): string {
  return targetBranch ?? baseBranch;
}

// ---------------------------------------------------------------------------
// Local implementation
// ---------------------------------------------------------------------------

export const localWorkspace: WorkspaceProvider = {
  async acquire({ repo, baseBranch, targetBranch, githubToken, policy }) {
    // M0: 'reuse_if_head_matches' behaves as fresh — reuse logic is deferred to M0d.
    void policy;

    const branch = branchToClone(targetBranch, baseBranch);
    const cloneUrl = authenticatedCloneUrl(repo, githubToken);

    // mkdtemp guarantees uniqueness; no need for an extra randomUUID.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'morehands-ws-'));

    try {
      // Args as an array — avoids shell injection and keeps the token out of shell history.
      await execFile('git', ['clone', '--depth', '1', '--single-branch', '--branch', branch, cloneUrl, dir]);
    } catch (raw) {
      // Never surface the authenticated URL or token in the error message.
      // The raw git error may echo the clone URL (git's redaction is version-dependent).
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw new Error(`git clone failed for ${repo} @ ${branch}: see process stderr for details`);
    }

    // Safe to log: repo name and branch only — token never appears here.
    console.log(`[workspace] cloned ${repo} @ ${branch} → ${dir}`);

    return {
      dir,
      cleanup: () => fs.rm(dir, { recursive: true, force: true }),
    };
  },
};
