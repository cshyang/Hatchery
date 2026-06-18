// Provider-neutral inbound message shape. Today there is exactly one provider
// (Slack), so this is a *type* that documents the normalization seam — NOT an
// adapter framework (see docs/decisions/0001: keep the type, skip the framework
// until provider #2 earns it).

import type { Binding } from '../project/bindings';

export interface CanonicalMessage {
  provider: 'slack';
  providerEventId: string;
  externalAccountId: string; // provider account / workspace (Slack: team id)
  projectId: string;
  externalSpaceId: string; // the space / room (Slack: channel id)
  conversationId: string; // MoreHands-stable id: provider/account/space/native conversation
  externalConversationId: string; // provider-native conversation/thread id (Slack: thread_ts, or message ts)
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
  const externalConversationId = ev.thread_ts ?? ev.ts;
  return {
    provider: 'slack',
    providerEventId: eventId,
    externalAccountId: teamId,
    projectId: binding.projectId,
    externalSpaceId: ev.channel,
    conversationId: `slack:${teamId}:${ev.channel}:${externalConversationId}`,
    externalConversationId,
    senderId: ev.user ? `slack:${teamId}:${ev.user}` : 'unknown',
    text: ev.text ?? '',
  };
}
