// Slack Events API envelope invariants — run: npx tsx src/slack/events.test.ts

import assert from 'node:assert/strict';
import { createTestRunner } from '../test-utils';
import {
  parseSlackEventEnvelope,
  slackEventId,
  slackUrlVerification,
  slackUserMessageEvent,
  type SlackEventEnvelope,
} from './events';

const { test, run } = createTestRunner();

test('parseSlackEventEnvelope: parses the raw Slack body', async () => {
  const body = parseSlackEventEnvelope('{"type":"event_callback","team_id":"T1"}');
  assert.equal(body.type, 'event_callback');
  assert.equal(body.team_id, 'T1');
});

test('slackUrlVerification: identifies Slack endpoint challenges', async () => {
  assert.deepEqual(slackUrlVerification({ type: 'url_verification', challenge: 'abc' }), { challenge: 'abc' });
  assert.equal(slackUrlVerification({ type: 'event_callback' }), null);
});

test('slackUserMessageEvent: accepts plain user messages with required routing fields', async () => {
  const event = slackUserMessageEvent({
    type: 'event_callback',
    event: {
      type: 'message',
      channel: 'C1',
      ts: '111.222',
      thread_ts: '100.000',
      user: 'U1',
      text: '<@Ubot> hi',
    },
  });

  assert.deepEqual(event, {
    channel: 'C1',
    ts: '111.222',
    thread_ts: '100.000',
    user: 'U1',
    text: '<@Ubot> hi',
  });
});

test('slackUserMessageEvent: ignores non-user messages and incomplete messages', async () => {
  const ignored: SlackEventEnvelope[] = [
    {},
    { event: { type: 'reaction_added', channel: 'C1', ts: '111.222' } },
    { event: { type: 'message', bot_id: 'B1', channel: 'C1', ts: '111.222' } },
    { event: { type: 'message', subtype: 'thread_broadcast', channel: 'C1', ts: '111.222' } },
    { event: { type: 'message', ts: '111.222' } },
    { event: { type: 'message', channel: 'C1' } },
  ];

  for (const body of ignored) {
    assert.equal(slackUserMessageEvent(body), null);
  }
});

test('slackEventId: uses Slack event_id and falls back to channel timestamp', async () => {
  const event = { channel: 'C1', ts: '111.222' };
  assert.equal(slackEventId({ event_id: 'Ev1' }, event), 'Ev1');
  assert.equal(slackEventId({}, event), 'C1:111.222');
});

await run();
