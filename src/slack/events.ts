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
  };
}

export interface SlackUserMessageEvent {
  channel: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  text?: string;
}

export function parseSlackEventEnvelope(raw: string): SlackEventEnvelope {
  return JSON.parse(raw) as SlackEventEnvelope;
}

export function slackUrlVerification(body: SlackEventEnvelope): { challenge?: string } | null {
  return body.type === 'url_verification' ? { challenge: body.challenge } : null;
}

// Ignore non-user messages, bot echoes, and all subtypes. Dropping subtypes also drops
// `thread_broadcast`; intentional until Slack needs that path to keep a thread alive.
export function slackUserMessageEvent(body: SlackEventEnvelope): SlackUserMessageEvent | null {
  const ev = body.event;
  if (!ev || ev.type !== 'message' || ev.bot_id || ev.subtype || !ev.channel || !ev.ts) {
    return null;
  }

  return {
    channel: ev.channel,
    ts: ev.ts,
    thread_ts: ev.thread_ts,
    user: ev.user,
    text: ev.text,
  };
}

export function slackEventId(body: SlackEventEnvelope, ev: SlackUserMessageEvent): string {
  return body.event_id ?? `${ev.channel}:${ev.ts}`;
}
