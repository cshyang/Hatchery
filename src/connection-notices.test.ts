// Connection notice invariants — run: npx tsx src/connection-notices.test.ts

import assert from 'node:assert/strict';
import type { Binding } from './bindings';
import { postConnectionNotice } from './connection-notices';
import type { ConversationTarget } from './conversations';
import type { D1Like } from './skills';
import { createTestRunner } from './test-utils';

const { test, run } = createTestRunner();

const db = {} as D1Like;
const binding: Binding = {
  provider: 'slack',
  externalAccountId: 'T1',
  externalSpaceId: 'C1',
  transportBotId: 'Ubot',
  projectId: 'demo',
  sandboxMode: 'virtual',
  transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
  status: 'active',
};

test('postConnectionNotice: posts a top-level project notice when a binding exists', async () => {
  const sent: Array<{ env: Record<string, unknown>; target: ConversationTarget; text: string }> = [];

  await postConnectionNotice(
    { db, env: { SLACK_BOT_TOKEN_DEFAULT: 'xoxb-test' }, projectId: 'demo', text: 'connected' },
    {
      bindingByProject: async (projectId, passedDb) => {
        assert.equal(projectId, 'demo');
        assert.equal(passedDb, db);
        return binding;
      },
      sendToConversationTarget: async (env, target, text) => {
        sent.push({ env, target, text });
      },
    },
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'connected');
  assert.equal(sent[0].target.conversationId, '');
  assert.equal(sent[0].target.externalConversationId, null);
  assert.equal(sent[0].target.externalSpaceId, 'C1');
  assert.equal(sent[0].target.transportTokenRef, 'SLACK_BOT_TOKEN_DEFAULT');
});

test('postConnectionNotice: skips silently when no binding exists', async () => {
  let sends = 0;

  await postConnectionNotice(
    { db, env: {}, projectId: 'missing', text: 'connected' },
    {
      bindingByProject: async () => undefined,
      sendToConversationTarget: async () => {
        sends++;
      },
    },
  );

  assert.equal(sends, 0);
});

test('postConnectionNotice: treats binding lookup failures like a missing binding', async () => {
  let sends = 0;

  await postConnectionNotice(
    { db, env: {}, projectId: 'demo', text: 'connected' },
    {
      bindingByProject: async () => {
        throw new Error('D1 unavailable');
      },
      sendToConversationTarget: async () => {
        sends++;
      },
    },
  );

  assert.equal(sends, 0);
});

test('postConnectionNotice: logs send failures without throwing', async () => {
  const logs: string[] = [];

  await postConnectionNotice(
    { db, env: {}, projectId: 'demo', text: 'connected' },
    {
      bindingByProject: async () => binding,
      sendToConversationTarget: async () => {
        throw new Error('Slack down');
      },
      log: (message) => logs.push(message),
    },
  );

  assert.deepEqual(logs, ['[nango] channel notice failed to post: Slack down']);
});

await run();
