// Linear reply helpers for agent-run callbacks. Posts a minimal comment on pr_opened and failed
// events, and (on pr_opened) advances the issue to a configured workflow state. Best-effort only —
// callers must wrap these in try/catch and never let a Linear failure alter the callback response.

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
const ERROR_TRUNCATE_LEN = 300;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}

/** Pure text factory. Returns null when the type is unrecognised or required context is absent. */
export function replyTextForCallback(
  type: string,
  opts: { prUrl?: string | null; error?: string | null },
): string | null {
  if (type === 'pr_opened') {
    if (!opts.prUrl) return null;
    return `🤖 PR opened: ${opts.prUrl}`;
  }
  if (type === 'failed') {
    return `🤖 Run failed: ${truncate(opts.error ?? 'unknown error', ERROR_TRUNCATE_LEN)}`;
  }
  return null;
}

/** POST a GraphQL operation to Linear. Throws on network errors, non-2xx, non-JSON, or a GraphQL
 *  `errors` array. The token is NEVER included in any thrown message. Returns the parsed JSON. */
async function linearGraphql<T = unknown>(
  fetchImpl: typeof fetch,
  token: string,
  payload: { query: string; variables: Record<string, unknown> },
): Promise<{ data?: T; errors?: unknown }> {
  const res = await fetchImpl(LINEAR_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Linear GraphQL request failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Linear GraphQL returned non-JSON response (HTTP ${res.status})`);
  }
  const errors = (json as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0];
    const msg = typeof first === 'object' && first !== null && 'message' in first
      ? String((first as { message: unknown }).message)
      : 'GraphQL error';
    throw new Error(`Linear GraphQL error: ${msg}`);
  }
  return json as { data?: T; errors?: unknown };
}

/** Post a comment on a Linear issue. Best-effort: the caller wraps this in try/catch.
 *  Requires the token to hold `comments:create` (or `write`). Token NEVER in a thrown message. */
export async function postLinearComment(args: {
  issueId: string;
  body: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { issueId, body, token, fetchImpl = fetch } = args;
  await linearGraphql(fetchImpl, token, {
    query: 'mutation($input: CommentCreateInput!){ commentCreate(input:$input){ success } }',
    variables: { input: { issueId, body } },
  });
}

/** Advance a Linear issue to the workflow state named `stateName` (case-insensitive) within the
 *  issue's team. Requires the token to hold `write` scope (stricter than commenting). Best-effort:
 *  the caller wraps this in try/catch. Returns `{ moved: false, reason }` (no throw) when the team
 *  has no state by that name — a misconfigured name is a no-op note, not a crash. Throws on
 *  network/HTTP/GraphQL errors (e.g. insufficient scope) so the caller can log them. Token NEVER
 *  in a thrown message. */
export async function moveLinearIssueState(args: {
  issueId: string;
  stateName: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<{ moved: boolean; reason?: string }> {
  const { issueId, stateName, token, fetchImpl = fetch } = args;

  // 1. Resolve the state id for `stateName` within the issue's team.
  const lookup = await linearGraphql<{ issue?: { team?: { states?: { nodes?: Array<{ id?: string; name?: string }> } } } }>(
    fetchImpl,
    token,
    {
      query: 'query($id: String!){ issue(id: $id){ team { states { nodes { id name } } } } }',
      variables: { id: issueId },
    },
  );
  const nodes = lookup.data?.issue?.team?.states?.nodes ?? [];
  const want = stateName.trim().toLowerCase();
  const match = nodes.find((n) => typeof n?.id === 'string' && (n.name ?? '').trim().toLowerCase() === want);
  if (!match?.id) {
    return { moved: false, reason: `no workflow state named "${stateName}" on the issue's team` };
  }

  // 2. Move the issue to that state.
  const updated = await linearGraphql<{ issueUpdate?: { success?: boolean } }>(fetchImpl, token, {
    query: 'mutation($id: String!, $stateId: String!){ issueUpdate(id: $id, input: { stateId: $stateId }){ success } }',
    variables: { id: issueId, stateId: match.id },
  });
  return { moved: Boolean(updated.data?.issueUpdate?.success) };
}
