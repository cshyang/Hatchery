// Wall-clock race invariants — run: npx tsx src/shared/wall-clock.test.ts

import assert from 'node:assert/strict';
import { createTestRunner } from './test-utils';
import { withWallClock } from './wall-clock';

const { test, run } = createTestRunner();

test('withWallClock passes through a result that arrives in time', async () => {
  assert.equal(await withWallClock(Promise.resolve('ok'), 1000, 'fast op'), 'ok');
});

test('withWallClock passes through a rejection that arrives in time', async () => {
  await assert.rejects(withWallClock(Promise.reject(new Error('boom')), 1000, 'failing op'), /boom/);
});

test('withWallClock rejects a hung promise with a retryable timeout message', async () => {
  const hung = new Promise<never>(() => {});
  await assert.rejects(withWallClock(hung, 20, 'hung op'), (e: Error) => {
    assert.match(e.message, /hung op timed out after 20ms \(wall clock\)/);
    assert.match(e.message, /retry the call/);
    return true;
  });
});

await run();
