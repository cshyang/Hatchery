// Provider-neutral inbound message shape. Today there is exactly one provider
// (Slack), so this is a *type* that documents the normalization seam — NOT an
// adapter framework (see docs/decisions/0001: keep the type, skip the framework
// until provider #2 earns it).

import type { Binding } from './bindings';

export interface CanonicalMessage {
  provider: 'slack';
  providerEventId: string;
  externalAccountId: string; // provider account / workspace (Slack: team id)
  projectId: string;
  externalSpaceId: string; // the space / room (Slack: channel id)
  conversationId: string; // the conversation / thread (Slack: thread_ts, or the message ts)
  senderId: string;
  text: string;
}

interface SlackMessageEvent {
  channel: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  text?: string;
}

export function normalizeSlackMessage(
  eventId: string,
  teamId: string,
  ev: SlackMessageEvent,
  binding: Binding,
): CanonicalMessage {
  return {
    provider: 'slack',
    providerEventId: eventId,
    externalAccountId: teamId,
    projectId: binding.projectId,
    externalSpaceId: ev.channel,
    conversationId: ev.thread_ts ?? ev.ts,
    senderId: ev.user ?? 'unknown',
    text: ev.text ?? '',
  };
}
