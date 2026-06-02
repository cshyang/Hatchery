// Gateway JSON helper invariants — run: npx tsx src/gateway-json.test.ts

import assert from 'node:assert/strict';
import { readJsonOrNull } from './gateway-json';
import { createTestRunner } from './test-utils';

const { test, run } = createTestRunner();

test('readJsonOrNull: returns parsed JSON value', async () => {
  const value = await readJsonOrNull<{ topic?: string }>(async () => ({ topic: 'launch' }));
  assert.deepEqual(value, { topic: 'launch' });
});

test('readJsonOrNull: returns null for malformed or absent JSON', async () => {
  const value = await readJsonOrNull(async () => {
    throw new Error('bad json');
  });
  assert.equal(value, null);
});

await run();
