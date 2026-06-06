// Linear reply helpers for agent-run callbacks. Posts a minimal comment on pr_opened and failed
// events. Best-effort only — callers must wrap postLinearComment in try/catch and never let a
// Linear failure alter the callback response.

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

/** Post a comment on a Linear issue via the GraphQL API.
 *  Throws on network errors, non-2xx responses, or a GraphQL `errors` array.
 *  The token is NEVER included in any thrown message.
 *  The caller is responsible for wrapping this in try/catch (best-effort semantics). */
export async function postLinearComment(args: {
  issueId: string;
  body: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { issueId, body, token, fetchImpl = fetch } = args;
  const res = await fetchImpl(LINEAR_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: 'mutation($input: CommentCreateInput!){ commentCreate(input:$input){ success } }',
      variables: { input: { issueId, body } },
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Linear comment post failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Linear comment post returned non-JSON response (HTTP ${res.status})`);
  }
  const errors = (json as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0];
    const msg = typeof first === 'object' && first !== null && 'message' in first
      ? String((first as { message: unknown }).message)
      : 'GraphQL error';
    throw new Error(`Linear comment post GraphQL error: ${msg}`);
  }
}
