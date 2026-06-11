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
  /** Per-message display identity (persona). Needs the chat:write.customize scope; when the scope
   *  is missing the post retries once without it. chat.update has no identity fields — edits
   *  inherit whatever the message was posted as, so the ack→reply chain keeps the persona. */
  username?: string;
  iconEmoji?: string;
  iconUrl?: string;
}

async function slackCall(method: 'chat.postMessage' | 'chat.update', token: string, body: Record<string, unknown>): Promise<SlackApiResponse> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return (await res.json()) as SlackApiResponse;
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
  const body: Record<string, unknown> = {
    channel,
    text: formatted,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    ...(options.blocks ? { blocks: options.blocks } : {}),
    ...(options.username ? { username: options.username } : {}),
    ...(options.iconEmoji ? { icon_emoji: options.iconEmoji } : {}),
    ...(options.iconUrl ? { icon_url: options.iconUrl } : {}),
  };
  let data = await slackCall('chat.postMessage', token, body);
  // Persona identity is best-effort: an app without chat:write.customize must still reply.
  if (!data.ok && data.error === 'missing_scope' && (body.username || body.icon_emoji || body.icon_url)) {
    console.log('[post] chat:write.customize scope missing — posting without persona identity');
    delete body.username;
    delete body.icon_emoji;
    delete body.icon_url;
    data = await slackCall('chat.postMessage', token, body);
  }
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
  const data = await slackCall('chat.update', token, {
    channel,
    ts,
    text: formatted,
    ...(options.blocks ? { blocks: options.blocks } : {}),
  });
  if (!data.ok) throw new Error(`slack chat.update failed: ${data.error ?? 'unknown_error'}`);
}
