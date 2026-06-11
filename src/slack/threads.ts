// Slack thread fetch + backscroll rendering for context hydration.
//
// One `conversations.replies` call (needs `channels:history`) returns the thread's messages; the
// gateway reuses that single fetch for BOTH the "is the bot already participating?" engage check
// (`.some(m => m.user === botUserId)`) and the backscroll it hands the agent so a threaded turn
// isn't context-blind. `renderThreadBackscroll` formats those messages for the prompt.

export interface ThreadMessage {
  user?: string;
  bot_id?: string;
  text: string;
  ts: string;
}

const BACKSCROLL_MAX_CHARS = 6000;

/** Render a Slack thread's prior messages as a compact context block for the agent's turn.
 *  The bot's own past messages are marked so the model knows what it already said. The triggering
 *  message (excludeTs) is omitted — it arrives separately as input.message. Capped to the most
 *  recent maxChars (oldest dropped first) so a long thread can't blow the context window. */
export function renderThreadBackscroll(
  messages: ThreadMessage[],
  botUserId: string,
  opts: { excludeTs?: string; maxChars?: number } = {},
): string {
  const max = opts.maxChars ?? BACKSCROLL_MAX_CHARS;
  const lines = messages
    .filter((m) => m.ts !== opts.excludeTs && m.text.trim().length > 0)
    .map((m) => {
      const who = m.bot_id || m.user === botUserId ? 'you (earlier)' : m.user ?? 'someone';
      return `${who}: ${m.text.trim()}`;
    });
  if (!lines.length) return '';
  const kept: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    total += lines[i].length + 1;
    if (total > max) break;
    kept.unshift(lines[i]);
  }
  return kept.join('\n');
}

interface RepliesApiResponse {
  ok: boolean;
  error?: string;
  messages?: Array<{ user?: string; bot_id?: string; text?: string; ts?: string }>;
}

/** Fetch a thread's messages (one conversations.replies call; needs `channels:history`).
 *  fetchImpl is injectable for tests. Returns [] on any non-ok response — a missing thread must
 *  degrade to "no backscroll", never throw into the gateway. */
export async function fetchThreadReplies(
  token: string,
  channel: string,
  threadTs: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<ThreadMessage[]> {
  const f = opts.fetchImpl ?? fetch;
  const url =
    `https://slack.com/api/conversations.replies` +
    `?channel=${encodeURIComponent(channel)}&ts=${encodeURIComponent(threadTs)}&limit=200`;
  const res = await f(url, { headers: { authorization: `Bearer ${token}` } });
  const data = (await res.json()) as RepliesApiResponse;
  if (!data.ok || !data.messages) return [];
  return data.messages.map((m) => ({ user: m.user, bot_id: m.bot_id, text: m.text ?? '', ts: m.ts ?? '' }));
}

/** Fetch a channel's recent top-level history (one conversations.history call; same
 *  `channels:history` scope as the thread fetch). Slack returns newest-first; this reverses to
 *  chronological so it renders like a transcript. Includes messages from before the bot joined —
 *  the room's REAL history, not just turns the bot saw. Same degrade-to-[] contract as
 *  fetchThreadReplies: a failure means "no backscroll", never a thrown gateway error. */
export async function fetchChannelHistory(
  token: string,
  channel: string,
  opts: { fetchImpl?: typeof fetch; limit?: number } = {},
): Promise<ThreadMessage[]> {
  const f = opts.fetchImpl ?? fetch;
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200);
  const url =
    `https://slack.com/api/conversations.history` +
    `?channel=${encodeURIComponent(channel)}&limit=${limit}`;
  const res = await f(url, { headers: { authorization: `Bearer ${token}` } });
  const data = (await res.json()) as RepliesApiResponse;
  if (!data.ok || !data.messages) return [];
  return data.messages
    .map((m) => ({ user: m.user, bot_id: m.bot_id, text: m.text ?? '', ts: m.ts ?? '' }))
    .reverse();
}
