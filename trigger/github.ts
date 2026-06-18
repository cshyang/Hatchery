import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// parseOwnerRepo
// ---------------------------------------------------------------------------

export function parseOwnerRepo(repoUrl: string): { owner: string; repo: string } {
  if (!repoUrl.startsWith('https://github.com/')) {
    throw new Error(`parseOwnerRepo: expected an https://github.com/ URL, got: ${repoUrl}`);
  }
  const path = repoUrl.slice('https://github.com/'.length).replace(/\.git$/, '');
  const slash = path.indexOf('/');
  if (slash < 1 || slash === path.length - 1) {
    throw new Error(`parseOwnerRepo: could not extract owner/repo from: ${repoUrl}`);
  }
  return { owner: path.slice(0, slash), repo: path.slice(slash + 1) };
}

// ---------------------------------------------------------------------------
// pushBranch
// ---------------------------------------------------------------------------

export async function pushBranch(dir: string, branch: string): Promise<void> {
  try {
    await execFileAsync('git', ['-C', dir, 'push', 'origin', branch]);
  } catch {
    // Never re-throw the original error: the remote URL contains the token.
    throw new Error(`push failed for ${branch}`);
  }
}

// ---------------------------------------------------------------------------
// openOrUpdatePullRequest
// ---------------------------------------------------------------------------

export interface OpenOrUpdatePullRequestOpts {
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
  token: string;
  /** Open as a draft PR (harness-kit work envelopes are drafts). Existing PRs keep their state. */
  draft?: boolean;
  fetchImpl?: typeof fetch;
}

export interface PullRequestResult {
  url: string;
  number: number;
  created: boolean;
}

export async function openOrUpdatePullRequest(opts: OpenOrUpdatePullRequestOpts): Promise<PullRequestResult> {
  const { owner, repo, head, base, title, body, token, draft = false, fetchImpl = fetch } = opts;

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'morehands-runner',
    'Content-Type': 'application/json',
  };

  // Check for an existing open PR for this head branch.
  const listUrl = `https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${head}&base=${base}&state=open`;
  const listRes = await fetchImpl(listUrl, { method: 'GET', headers });

  if (!listRes.ok) {
    const errBody = await listRes.json().catch(() => ({})) as { message?: string };
    throw new Error(`GitHub API error ${listRes.status}: ${errBody.message ?? 'unknown error'}`);
  }

  const existing = await listRes.json() as Array<{ html_url: string; number: number }>;

  if (existing.length > 0) {
    const pr = existing[0];
    return { url: pr.html_url, number: pr.number, created: false };
  }

  // No existing PR — open one.
  const createUrl = `https://api.github.com/repos/${owner}/${repo}/pulls`;
  const createRes = await fetchImpl(createUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title, head, base, body, draft }),
  });

  if (!createRes.ok) {
    const errBody = await createRes.json().catch(() => ({})) as { message?: string };
    throw new Error(`GitHub API error ${createRes.status}: ${errBody.message ?? 'unknown error'}`);
  }

  const created = await createRes.json() as { html_url: string; number: number };
  return { url: created.html_url, number: created.number, created: true };
}
