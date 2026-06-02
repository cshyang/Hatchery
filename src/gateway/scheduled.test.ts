// Scheduled job input builder invariants — run: npx tsx src/gateway/scheduled.test.ts

import assert from 'node:assert/strict';
import { buildScheduledInput } from './scheduled';
import { createTestRunner } from '../shared/test-utils';
import type { D1Like } from '../skills/repository';

const { test, run } = createTestRunner();

const DB = {} as D1Like;

test('buildScheduledInput: active skill body combines with one-off prompt', async () => {
  const result = await buildScheduledInput(
    { db: DB, projectId: 'P', kind: 'job', now: '2026-06-02T00:00:00.000Z', payload: { skill: 'daily', prompt: 'Then summarize.' } },
    { loadRunnableSkillBody: async () => ({ status: 'active', body: 'Check the queue.' }) },
  );
  assert.deepEqual(result, {
    input: {
      kind: 'job',
      now: '2026-06-02T00:00:00.000Z',
      skill: 'daily',
      instructions: 'Check the queue.\n\nThen summarize.',
    },
  });
});

test('buildScheduledInput: topic-only payload stays a lightweight heartbeat topic', async () => {
  const result = await buildScheduledInput({
    db: undefined,
    projectId: 'P',
    kind: undefined,
    now: '2026-06-02T00:00:00.000Z',
    payload: { topic: 'website launch' },
  });
  assert.deepEqual(result, {
    input: {
      kind: 'heartbeat',
      now: '2026-06-02T00:00:00.000Z',
      topic: 'website launch',
    },
  });
});

test('buildScheduledInput: archived skill with no fallback work is skipped', async () => {
  const logs: string[] = [];
  const result = await buildScheduledInput(
    { db: DB, projectId: 'P', kind: 'job', now: 'now', payload: { skill: 'retired' } },
    { loadRunnableSkillBody: async () => ({ status: 'archived' }), log: (message) => logs.push(message) },
  );
  assert.deepEqual(result, { skipped: 'nothing to run (skill missing, no prompt/topic)' });
  assert.match(logs[0], /archived/);
});

await run();
