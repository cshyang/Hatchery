// Gateway auth helper invariants — run: npx tsx src/gateway/auth.test.ts

import assert from 'node:assert/strict';
import { hasMatchingSecretHeader } from './auth';
import { createTestRunner } from '../shared/test-utils';

const { test, run } = createTestRunner();

test('hasMatchingSecretHeader: accepts exact configured secret match', async () => {
  assert.equal(hasMatchingSecretHeader('secret', 'secret'), true);
});

test('hasMatchingSecretHeader: missing configured secret keeps route inert', async () => {
  assert.equal(hasMatchingSecretHeader(undefined, undefined), false);
  assert.equal(hasMatchingSecretHeader('', ''), false);
  assert.equal(hasMatchingSecretHeader(undefined, 'secret'), false);
});

test('hasMatchingSecretHeader: wrong or missing header is rejected', async () => {
  assert.equal(hasMatchingSecretHeader('secret', undefined), false);
  assert.equal(hasMatchingSecretHeader('secret', ''), false);
  assert.equal(hasMatchingSecretHeader('secret', 'SECRET'), false);
});

await run();
