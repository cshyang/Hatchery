// Slack post wrapper invariants — run: npx tsx src/slack/post.test.ts

import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { editMessage, postMessage } from './post';

const { test, run } = createTestRunner();

test('postMessage sends formatted text and optional blocks', async () => {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    calls.push({ body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, ts: '123.456' }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const blocks = [{ type: 'header', text: { type: 'plain_text', text: 'Done' } }];
    const ts = await postMessage('xoxb-test', 'C1', '**Done**', '111.222', { blocks });

    assert.equal(ts, '123.456');
    assert.deepEqual(calls[0].body, {
      channel: 'C1',
      text: '*Done*',
      thread_ts: '111.222',
      blocks,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('editMessage sends formatted text and optional blocks', async () => {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    calls.push({ body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: '*Ready*' } }];
    await editMessage('xoxb-test', 'C1', '123.456', '# Ready', { blocks });

    assert.deepEqual(calls[0].body, {
      channel: 'C1',
      ts: '123.456',
      text: '*Ready*',
      blocks,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await run();
