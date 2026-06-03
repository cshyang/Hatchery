// Slack dispatch fallback invariants — run: npx tsx src/slack/dispatch.test.ts

import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { claimEvent, type KVLike } from '../shared/idempotency';
import { SETUP_FAILURE_FALLBACK } from './ack';
import { dispatchSlackTurnWithFallback } from './dispatch';

const { test, run } = createTestRunner();

test('dispatchSlackTurnWithFallback posts one safe failure message after dispatch throws', async () => {
  const waits: Promise<unknown>[] = [];
  const posts: Array<{ token: string; channel: string; text: string; threadTs?: string }> = [];
  const logs: string[] = [];

  const result = await dispatchSlackTurnWithFallback(
    { agent: 'project', id: 'project:project_1:agent:default', input: { message: 'setup' } },
    {
      executionCtx: { waitUntil: (promise) => waits.push(promise) },
      token: 'xoxb-test',
      channel: 'C1',
      threadTs: '111.222',
    },
    {
      dispatch: async () => {
        throw new Error('dispatch failed');
      },
      postMessage: async (token, channel, text, threadTs) => {
        posts.push({ token, channel, text, threadTs });
      },
      log: (message) => logs.push(message),
    },
  );

  assert.equal(result.dispatched, false);
  assert.equal(waits.length, 1);
  await waits[0];
  assert.deepEqual(posts, [{ token: 'xoxb-test', channel: 'C1', text: SETUP_FAILURE_FALLBACK, threadTs: '111.222' }]);
  assert.deepEqual(logs, ['[slack] agent dispatch failed after working ack: dispatch failed']);
});

test('Slack idempotency keeps the setup failure fallback from double-posting on retry', async () => {
  const seen = new Set<string>();
  const kv: KVLike = {
    async get(key) {
      return seen.has(key) ? '1' : null;
    },
    async put(key) {
      seen.add(key);
    },
  };
  const waits: Promise<unknown>[] = [];
  let posts = 0;

  for (let i = 0; i < 2; i++) {
    if (!(await claimEvent(kv, 'Ev123'))) continue;
    await dispatchSlackTurnWithFallback(
      { agent: 'project', id: 'project:project_1:agent:default', input: { message: 'setup' } },
      {
        executionCtx: { waitUntil: (promise) => waits.push(promise) },
        token: 'xoxb-test',
        channel: 'C1',
        threadTs: '111.222',
      },
      {
        dispatch: async () => {
          throw new Error('dispatch failed');
        },
        postMessage: async () => {
          posts++;
        },
        log: () => {},
      },
    );
  }

  await Promise.all(waits);
  assert.equal(posts, 1);
});

await run();
