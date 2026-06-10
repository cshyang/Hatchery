export interface SlackEventEnvelope {
  type?: string;
  challenge?: string;
  team_id?: string;
  event_id?: string;
  event?: {
    type?: string;
    subtype?: string;
    bot_id?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
    user?: string;
    text?: string;
    files?: Array<{ id?: string; name?: string; mimetype?: string; size?: number }>;
  };
}

// Safe subset of Slack file metadata. No url_private — downloads go through
// files.info with the bot token at tool time, never through model context.
export interface SlackFileMeta {
  id: string;
  name: string | null;
  mimetype: string | null;
  size: number | null;
}

export interface SlackUserMessageEvent {
  channel: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  text?: string;
  files?: SlackFileMeta[];
}

export function parseSlackEventEnvelope(raw: string): SlackEventEnvelope {
  return JSON.parse(raw) as SlackEventEnvelope;
}

export function slackUrlVerification(body: SlackEventEnvelope): { challenge?: string } | null {
  return body.type === 'url_verification' ? { challenge: body.challenge } : null;
}

// Ignore non-user messages, bot echoes, and all subtypes EXCEPT `file_share` — a user message
// with attached files arrives as that subtype, so dropping it would silently eat every upload.
// Dropping the rest also drops `thread_broadcast`; intentional until Slack needs that path to
// keep a thread alive.
export function slackUserMessageEvent(body: SlackEventEnvelope): SlackUserMessageEvent | null {
  const ev = body.event;
  if (!ev || ev.type !== 'message' || ev.bot_id || !ev.channel || !ev.ts) {
    return null;
  }
  if (ev.subtype && ev.subtype !== 'file_share') return null;

  const files = (ev.files ?? [])
    .filter((f) => typeof f?.id === 'string' && f.id.length > 0)
    .map((f) => ({
      id: f.id as string,
      name: typeof f.name === 'string' ? f.name : null,
      mimetype: typeof f.mimetype === 'string' ? f.mimetype : null,
      size: typeof f.size === 'number' && Number.isFinite(f.size) ? f.size : null,
    }));

  return {
    channel: ev.channel,
    ts: ev.ts,
    thread_ts: ev.thread_ts,
    user: ev.user,
    text: ev.text,
    ...(files.length ? { files } : {}),
  };
}

export function slackEventId(body: SlackEventEnvelope, ev: SlackUserMessageEvent): string {
  return body.event_id ?? `${ev.channel}:${ev.ts}`;
}
