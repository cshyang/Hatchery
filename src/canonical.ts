// Provider-neutral inbound message shape. Today there is exactly one provider
// (Slack), so this is a *type* that documents the normalization seam — NOT an
// adapter framework (see docs/decisions/0001: keep the type, skip the framework
// until provider #2 earns it).

import type { Binding } from './bindings';

export interface CanonicalMessage {
  provider: 'slack';
  providerEventId: string;
  externalTeamId: string;
  projectId: string;
  channelId: string;
  threadTs: string;
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
    externalTeamId: teamId,
    projectId: binding.projectId,
    channelId: ev.channel,
    threadTs: ev.thread_ts ?? ev.ts,
    senderId: ev.user ?? 'unknown',
    text: ev.text ?? '',
  };
}
