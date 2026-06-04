// Slack working acknowledgement invariants — run: npx tsx src/slack/ack.test.ts

import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { postWorkingAck, WORKING_ACK } from './ack';

const { test, run } = createTestRunner();

test('postWorkingAck: posts the default ack and returns its ts (for later edit-in-place)', async () => {
  const calls: Array<{ token: string; channel: string; text: string; threadTs?: string }> = [];

  const ts = await postWorkingAck(
    { token: 'xoxb-test', channel: 'C1', threadTs: '111.222' },
    {
      postMessage: async (token, channel, text, threadTs) => {
        calls.push({ token, channel, text, threadTs });
        return '333.444';
      },
    },
  );

  assert.equal(ts, '333.444');
  assert.deepEqual(calls, [{ token: 'xoxb-test', channel: 'C1', text: WORKING_ACK, threadTs: '111.222' }]);
});

test('postWorkingAck: returns undefined and posts nothing when no token is available', async () => {
  let called = 0;

  const ts = await postWorkingAck(
    { channel: 'C1', threadTs: '111.222' },
    {
      postMessage: async () => {
        called++;
        return 'x';
      },
    },
  );

  assert.equal(ts, undefined);
  assert.equal(called, 0);
});

test('postWorkingAck: times out and returns undefined so a hung Slack never blocks dispatch', async () => {
  const logs: string[] = [];

  const ts = await postWorkingAck(
    { token: 'xoxb-test', channel: 'C1', threadTs: '111.222' },
    {
      postMessage: () => new Promise<string>(() => {}), // never resolves
      log: (message) => logs.push(message),
      timeoutMs: 10,
    },
  );

  assert.equal(ts, undefined);
  assert.ok(logs.some((l) => l.includes('timed out')));
});

test('postWorkingAck: swallows send failures, logs, and returns undefined (turn never blocks)', async () => {
  const logs: string[] = [];

  const ts = await postWorkingAck(
    { token: 'xoxb-test', channel: 'C1', threadTs: '111.222' },
    {
      postMessage: async () => {
        throw new Error('Slack down');
      },
      log: (message) => logs.push(message),
    },
  );

  assert.equal(ts, undefined);
  assert.deepEqual(logs, ['[ack] working-ack failed to post: Slack down']);
});

await run();
