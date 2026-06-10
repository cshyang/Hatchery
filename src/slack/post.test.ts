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

test('postMessage carries persona identity fields when supplied', async () => {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    calls.push({ body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, ts: '1.2' }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    await postMessage('xoxb-test', 'C1', 'hi', undefined, { username: 'Wren', iconEmoji: ':bird:' });
    assert.equal(calls[0].body.username, 'Wren');
    assert.equal(calls[0].body.icon_emoji, ':bird:');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('postMessage retries without identity when chat:write.customize is missing', async () => {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ body });
    const payload = body.username ? { ok: false, error: 'missing_scope' } : { ok: true, ts: '9.9' };
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const ts = await postMessage('xoxb-test', 'C1', 'hi', undefined, { username: 'Wren', iconEmoji: ':bird:' });
    assert.equal(ts, '9.9');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.username, undefined);
    assert.equal(calls[1].body.icon_emoji, undefined);
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
