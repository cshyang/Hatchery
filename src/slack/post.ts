// Minimal Slack chat.postMessage / chat.update wrappers. Used only by the guarded reply tool,
// which supplies channel + token from trusted config — never from the model.

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  ts?: string;
}

// Returns the posted message's ts, so the caller can later edit it in place (chat.update).
export async function postMessage(
  token: string,
  channel: string,
  text: string,
  threadTs?: string,
): Promise<string | undefined> {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) }),
  });
  const data = (await res.json()) as SlackApiResponse;
  if (!data.ok) throw new Error(`slack chat.postMessage failed: ${data.error ?? 'unknown_error'}`);
  return data.ts;
}

// Edit an existing message in place. Used to turn the "On it…" ack into the real reply, so a
// turn shows as one evolving message instead of stacking ack + answer.
export async function editMessage(
  token: string,
  channel: string,
  ts: string,
  text: string,
): Promise<void> {
  const res = await fetch('https://slack.com/api/chat.update', {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ channel, ts, text }),
  });
  const data = (await res.json()) as SlackApiResponse;
  if (!data.ok) throw new Error(`slack chat.update failed: ${data.error ?? 'unknown_error'}`);
}
