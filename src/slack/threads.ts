// "Is the bot already participating in this thread?" — the signal that an
// un-addressed (no @mention) reply should still be answered, so a conversation
// flows in-thread without re-mentioning the bot every turn.
//
// One conversations.replies call (needs `channels:history`). Only invoked for
// threaded, non-mention messages — mentions engage without a lookup, top-level
// chatter is ignored without a lookup. Bounded cost.

interface RepliesResponse {
  ok: boolean;
  error?: string;
  messages?: Array<{ user?: string; bot_id?: string }>;
}

export async function botInThread(
  token: string,
  channel: string,
  threadTs: string,
  botUserId: string,
): Promise<boolean> {
  const url =
    `https://slack.com/api/conversations.replies` +
    `?channel=${encodeURIComponent(channel)}&ts=${encodeURIComponent(threadTs)}&limit=200`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const data = (await res.json()) as RepliesResponse;
  if (!data.ok || !data.messages) return false;
  return data.messages.some((m) => m.user === botUserId);
}
