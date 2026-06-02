// Shared HTTP helper invariants — run: npx tsx src/providers/http.test.ts
import assert from 'node:assert/strict';
import { fetchWithTimeout, jsonMessageOrText } from './http';
import { createTestRunner } from '../test-utils';

const { test, run } = createTestRunner();

test('jsonMessageOrText: prefers a JSON message field', () => {
  assert.equal(jsonMessageOrText(JSON.stringify({ message: 'bad token' }), 20), 'bad token');
});

test('jsonMessageOrText: falls back to a bounded raw body', () => {
  assert.equal(jsonMessageOrText('not-json-response', 8), 'not-json');
});

test('fetchWithTimeout: passes a timeout signal to the injected fetch', async () => {
  const res = await fetchWithTimeout('https://example.test', { method: 'GET' }, {
    timeoutMs: 1000,
    timeoutMessage: 'timed out',
    failurePrefix: 'failed',
    fetchImpl: (async (_input, init) => {
      assert.ok(init?.signal, 'signal is provided');
      return new Response('ok');
    }) as typeof fetch,
  });
  assert.equal(await res.text(), 'ok');
});

test('fetchWithTimeout: maps abort errors to the timeout message', async () => {
  const err = new Error('late');
  err.name = 'AbortError';
  await assert.rejects(
    fetchWithTimeout('https://example.test', {}, {
      timeoutMs: 1000,
      timeoutMessage: 'provider timed out',
      failurePrefix: 'provider failed',
      fetchImpl: (async () => {
        throw err;
      }) as typeof fetch,
    }),
    /provider timed out/,
  );
});

test('fetchWithTimeout: maps other fetch errors to the failure prefix', async () => {
  await assert.rejects(
    fetchWithTimeout('https://example.test', {}, {
      timeoutMs: 1000,
      timeoutMessage: 'provider timed out',
      failurePrefix: 'provider failed',
      fetchImpl: (async () => {
        throw new Error('socket closed');
      }) as typeof fetch,
    }),
    /provider failed: socket closed/,
  );
});

await run();
