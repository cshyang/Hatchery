// GitHub adapter (ADR 0003). REST-FIRST: read tools call the GitHub REST API directly
// (stateless, at execute-time — nothing held across a DO turn). The official remote MCP is a
// deferred swap, gated on the MCP-lifetime spike; not built here.
//
// The CREATE (write) is NOT a model-callable tool — it's `executeCreateIssue`, run only by the
// post-approval executor in the gateway (ADR D4). The agent's create tool merely *proposes*
// (see connections.ts → connectionTools), so the model never reaches a write directly.

import { defineTool, Type, type ToolDefinition } from '@flue/runtime';

const API = 'https://api.github.com';
const UA = 'hatchery-agent'; // GitHub requires a User-Agent or returns 403.

function ghHeaders(pat: string): Record<string, string> {
  return {
    authorization: `Bearer ${pat}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': UA,
  };
}

async function ghGet(pat: string, path: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, { headers: ghHeaders(pat) });
  const text = await res.text();
  if (!res.ok) {
    // Surface a sanitized error to the model — status + GitHub's message, never the PAT.
    let msg = text.slice(0, 200);
    try {
      msg = (JSON.parse(text) as { message?: string }).message ?? msg;
    } catch {
      /* keep raw slice */
    }
    throw new Error(`GitHub ${res.status}: ${msg}`);
  }
  return text ? JSON.parse(text) : null;
}

// Trim GitHub's enormous objects to what's useful in chat (keeps tool results small).
function slimIssue(i: Record<string, unknown>): Record<string, unknown> {
  return {
    number: i.number,
    title: i.title,
    state: i.state,
    user: (i.user as { login?: string } | null)?.login,
    labels: ((i.labels as { name?: string }[]) ?? []).map((l) => l.name),
    comments: i.comments,
    url: i.html_url,
    updated_at: i.updated_at,
  };
}

/** Read-only GitHub tools, scoped to a repo via the connection's config (config.repo = "owner/name").
 *  Pass the decrypted PAT — these run at execute-time, so the PAT is used only when a tool fires. */
export function githubReadTools(pat: string, repo: string | undefined): ToolDefinition[] {
  const repoHint = repo ? ` Defaults to the connected repo (${repo}) when owner/name are omitted.` : '';
  const resolveRepo = (owner?: string, name?: string): { owner: string; name: string } => {
    if (owner && name) return { owner, name };
    if (repo && repo.includes('/')) {
      const [o, n] = repo.split('/');
      return { owner: o, name: n };
    }
    throw new Error('No repo specified and no default repo configured for this connection.');
  };

  const listIssues = defineTool({
    name: 'github_list_issues',
    description: `List open issues in a GitHub repo (most-recently-updated first).${repoHint}`,
    parameters: Type.Object({
      owner: Type.Optional(Type.String({ description: 'Repo owner/org.' })),
      repo: Type.Optional(Type.String({ description: 'Repo name.' })),
      state: Type.Optional(Type.String({ description: '"open" (default), "closed", or "all".' })),
    }),
    async execute({ owner, repo: r, state }) {
      const { owner: o, name: n } = resolveRepo(owner as string | undefined, r as string | undefined);
      const st = ['open', 'closed', 'all'].includes(String(state)) ? String(state) : 'open';
      const data = (await ghGet(pat, `/repos/${o}/${n}/issues?state=${st}&sort=updated&per_page=20`)) as Record<
        string,
        unknown
      >[];
      // /issues returns PRs too; drop them (PRs have a pull_request field).
      const issues = data.filter((i) => !i.pull_request).map(slimIssue);
      return JSON.stringify(issues, null, 2);
    },
  });

  const getIssue = defineTool({
    name: 'github_get_issue',
    description: `Get one GitHub issue by number, with its body.${repoHint}`,
    parameters: Type.Object({
      number: Type.Integer({ description: 'Issue number.' }),
      owner: Type.Optional(Type.String({ description: 'Repo owner/org.' })),
      repo: Type.Optional(Type.String({ description: 'Repo name.' })),
    }),
    async execute({ number, owner, repo: r }) {
      const { owner: o, name: n } = resolveRepo(owner as string | undefined, r as string | undefined);
      const i = (await ghGet(pat, `/repos/${o}/${n}/issues/${Number(number)}`)) as Record<string, unknown>;
      return JSON.stringify({ ...slimIssue(i), body: i.body }, null, 2);
    },
  });

  const searchIssues = defineTool({
    name: 'github_search_issues',
    description:
      'Search GitHub issues/PRs with the GitHub search syntax (e.g. "repo:owner/name is:issue is:open label:bug").',
    parameters: Type.Object({ q: Type.String({ description: 'GitHub issue-search query.' }) }),
    async execute({ q }) {
      const data = (await ghGet(pat, `/search/issues?q=${encodeURIComponent(String(q))}&per_page=20`)) as {
        total_count: number;
        items: Record<string, unknown>[];
      };
      return JSON.stringify({ total: data.total_count, items: data.items.map(slimIssue) }, null, 2);
    },
  });

  const searchCode = defineTool({
    name: 'github_search_code',
    description: 'Search code with the GitHub code-search syntax (e.g. "repo:owner/name connectMcpServer").',
    parameters: Type.Object({ q: Type.String({ description: 'GitHub code-search query.' }) }),
    async execute({ q }) {
      const data = (await ghGet(pat, `/search/code?q=${encodeURIComponent(String(q))}&per_page=20`)) as {
        total_count: number;
        items: { path?: string; repository?: { full_name?: string }; html_url?: string }[];
      };
      const items = data.items.map((i) => ({ repo: i.repository?.full_name, path: i.path, url: i.html_url }));
      return JSON.stringify({ total: data.total_count, items }, null, 2);
    },
  });

  const getFile = defineTool({
    name: 'github_get_file_contents',
    description: `Read a file's text from a GitHub repo at a path (optionally a ref/branch).${repoHint}`,
    parameters: Type.Object({
      path: Type.String({ description: 'File path in the repo.' }),
      owner: Type.Optional(Type.String({ description: 'Repo owner/org.' })),
      repo: Type.Optional(Type.String({ description: 'Repo name.' })),
      ref: Type.Optional(Type.String({ description: 'Branch, tag, or commit SHA.' })),
    }),
    async execute({ path, owner, repo: r, ref }) {
      const { owner: o, name: n } = resolveRepo(owner as string | undefined, r as string | undefined);
      const q = ref ? `?ref=${encodeURIComponent(String(ref))}` : '';
      const data = (await ghGet(pat, `/repos/${o}/${n}/contents/${String(path)}${q}`)) as {
        content?: string;
        encoding?: string;
        size?: number;
      };
      if (data.encoding === 'base64' && data.content) {
        const decoded = atob(data.content.replace(/\n/g, ''));
        return decoded.length > 8000 ? decoded.slice(0, 8000) + '\n…(truncated)' : decoded;
      }
      return JSON.stringify(data);
    },
  });

  return [listIssues, getIssue, searchIssues, searchCode, getFile];
}

export const GITHUB_READ_TOOL_NAMES = [
  'github_list_issues',
  'github_get_issue',
  'github_search_issues',
  'github_search_code',
  'github_get_file_contents',
] as const;

// "Bet on intelligence" (ADR 0003, the 10-star reframe). ONE generic tool: the model composes the
// GitHub REST call itself from what it knows, the broker injects the PAT at the network boundary.
// If this works reliably, the hand-written read tools above (and any vendor's bundled tools) are
// unnecessary. GET-only here — writes (POST/PATCH/DELETE) are the sharp edge and go through the
// v2b approval gate, never a blind model-issued call. The method param exists so the shape is the
// real generic one; non-GET is refused with a pointer to the gate, not silently dropped.
export const GITHUB_CALL_API_TOOL_NAME = 'github_call_api';

export function githubCallApiTool(pat: string, repo: string | undefined): ToolDefinition {
  const repoHint = repo ? ` The connected repo is ${repo} (use it as owner/name unless told otherwise).` : '';
  return defineTool({
    name: GITHUB_CALL_API_TOOL_NAME,
    description:
      'Call the GitHub REST API directly. You compose the request from your knowledge of the API. ' +
      'Read-only for now: only method "GET" is allowed (writes need human approval and are not wired yet). ' +
      'path is the API path after https://api.github.com, e.g. "/repos/owner/name/issues?state=open&per_page=20" ' +
      'or "/repos/owner/name/contents/README.md". Authentication is handled for you — never include tokens.' +
      repoHint,
    parameters: Type.Object({
      method: Type.String({ description: 'HTTP method. Only "GET" is permitted right now.' }),
      path: Type.String({ description: 'API path beginning with "/", including any query string.' }),
    }),
    async execute({ method, path }) {
      const m = String(method).toUpperCase();
      if (m !== 'GET') {
        throw new Error(`Only GET is allowed via github_call_api; "${m}" is a write and needs approval (not wired yet).`);
      }
      const p = String(path).startsWith('/') ? String(path) : `/${String(path)}`;
      const data = await ghGet(pat, p);
      const out = JSON.stringify(data, null, 2);
      return out.length > 8000 ? out.slice(0, 8000) + '\n…(truncated)' : out;
    },
  });
}

/** The post-approval write executor (ADR D4). Stateless — called by the gateway after the
 *  operator approves, reading args from the stored pending_actions row. Never model-callable. */
export async function executeCreateIssue(
  pat: string,
  repo: string,
  args: { title: string; body?: string },
): Promise<{ number: number; url: string }> {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`bad repo "${repo}" (want owner/name).`);
  const res = await fetch(`${API}/repos/${owner}/${name}/issues`, {
    method: 'POST',
    headers: { ...ghHeaders(pat), 'content-type': 'application/json' },
    body: JSON.stringify({ title: args.title, body: args.body ?? '' }),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try {
      msg = (JSON.parse(text) as { message?: string }).message ?? msg;
    } catch {
      /* keep */
    }
    throw new Error(`GitHub create issue ${res.status}: ${msg}`);
  }
  const created = JSON.parse(text) as { number: number; html_url: string };
  return { number: created.number, url: created.html_url };
}
