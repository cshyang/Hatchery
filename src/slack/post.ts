// Minimal Slack chat.postMessage wrapper. Used only by the guarded reply tool,
// which supplies channel + token from trusted config — never from the model.

interface SlackApiResponse {
  ok: boolean;
  error?: string;
}

export async function postMessage(
  token: string,
  channel: string,
  text: string,
  threadTs?: string,
): Promise<void> {
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
}
