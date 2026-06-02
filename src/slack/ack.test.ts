// Slack working acknowledgement invariants — run: npx tsx src/slack/ack.test.ts

import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { queueWorkingAck, WORKING_ACK } from './ack';

const { test, run } = createTestRunner();

test('queueWorkingAck: posts the default ack through waitUntil', async () => {
  const waits: Promise<unknown>[] = [];
  const calls: Array<{ token: string; channel: string; text: string; threadTs?: string }> = [];

  queueWorkingAck(
    {
      executionCtx: { waitUntil: (promise) => waits.push(promise) },
      token: 'xoxb-test',
      channel: 'C1',
      threadTs: '111.222',
    },
    {
      postMessage: async (token, channel, text, threadTs) => {
        calls.push({ token, channel, text, threadTs });
      },
    },
  );

  assert.equal(waits.length, 1);
  await waits[0];
  assert.deepEqual(calls, [{ token: 'xoxb-test', channel: 'C1', text: WORKING_ACK, threadTs: '111.222' }]);
});

test('queueWorkingAck: skips when no token is available', async () => {
  let waitUntilCalls = 0;

  queueWorkingAck({
    executionCtx: {
      waitUntil: () => {
        waitUntilCalls++;
      },
    },
    channel: 'C1',
    threadTs: '111.222',
  });

  assert.equal(waitUntilCalls, 0);
});

test('queueWorkingAck: logs send failures without throwing', async () => {
  const waits: Promise<unknown>[] = [];
  const logs: string[] = [];

  queueWorkingAck(
    {
      executionCtx: { waitUntil: (promise) => waits.push(promise) },
      token: 'xoxb-test',
      channel: 'C1',
      threadTs: '111.222',
    },
    {
      postMessage: async () => {
        throw new Error('Slack down');
      },
      log: (message) => logs.push(message),
    },
  );

  assert.equal(waits.length, 1);
  await waits[0];
  assert.deepEqual(logs, ['[ack] working-ack failed to post: Slack down']);
});

await run();
