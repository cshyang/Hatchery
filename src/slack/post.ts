// Minimal Slack chat.postMessage / chat.update wrappers. Used only by the guarded reply tool,
// which supplies channel + token from trusted config — never from the model.

import { formatSlackText } from './format';
import type { SlackBlock } from './blocks';

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  ts?: string;
}

export interface SlackPostOptions {
  blocks?: SlackBlock[];
  format?: boolean;
}

// Returns the posted message's ts, so the caller can later edit it in place (chat.update).
export async function postMessage(
  token: string,
  channel: string,
  text: string,
  threadTs?: string,
  options: SlackPostOptions = {},
): Promise<string | undefined> {
  const formatted = options.format === false ? text : formatSlackText(text);
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      channel,
      text: formatted,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      ...(options.blocks ? { blocks: options.blocks } : {}),
    }),
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
  options: SlackPostOptions = {},
): Promise<void> {
  const formatted = options.format === false ? text : formatSlackText(text);
  const res = await fetch('https://slack.com/api/chat.update', {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      channel,
      ts,
      text: formatted,
      ...(options.blocks ? { blocks: options.blocks } : {}),
    }),
  });
  const data = (await res.json()) as SlackApiResponse;
  if (!data.ok) throw new Error(`slack chat.update failed: ${data.error ?? 'unknown_error'}`);
}
