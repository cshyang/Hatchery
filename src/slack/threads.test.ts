// Thread backscroll: fetch + render for context hydration — run: npx tsx src/slack/threads.test.ts
import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { renderThreadBackscroll, fetchThreadReplies, fetchChannelHistory, type ThreadMessage } from './threads';

const { test, run } = createTestRunner();

const msgs: ThreadMessage[] = [
  { user: 'Ualex', text: 'can we change the pricing?', ts: '1.0' },
  { bot_id: 'B1', user: 'Ubot', text: 'I looked into it', ts: '2.0' },
  { user: 'Ujo', text: 'what did you find?', ts: '3.0' },
];

test('renderThreadBackscroll: marks the bot, labels others, oldest→newest', async () => {
  const out = renderThreadBackscroll(msgs, 'Ubot');
  assert.equal(
    out,
    'Ualex: can we change the pricing?\nyou (earlier): I looked into it\nUjo: what did you find?',
  );
});

test('renderThreadBackscroll: excludes the triggering message by ts', async () => {
  const out = renderThreadBackscroll(msgs, 'Ubot', { excludeTs: '3.0' });
  assert.ok(!out.includes('what did you find?'), 'triggering message omitted');
  assert.ok(out.includes('can we change the pricing?'), 'prior context kept');
});

test('renderThreadBackscroll: empty input → empty string', async () => {
  assert.equal(renderThreadBackscroll([], 'Ubot'), '');
});

test('renderThreadBackscroll: caps to maxChars, dropping oldest first', async () => {
  const out = renderThreadBackscroll(msgs, 'Ubot', { maxChars: 30 });
  assert.ok(out.includes('Ujo: what did you find?'), 'most recent kept');
  assert.ok(!out.includes('pricing'), 'oldest dropped to fit budget');
});

// A fake fetch that records calls and returns a canned Response (mirrors nango.test.ts).
function fakeFetch(responder: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    return responder(String(url), (init ?? {}) as RequestInit);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test('fetchThreadReplies: GETs conversations.replies with Bearer, parses messages', async () => {
  const { fn, calls } = fakeFetch(() =>
    new Response(JSON.stringify({ ok: true, messages: [
      { user: 'Ualex', text: 'hi', ts: '1.0' },
      { bot_id: 'B1', user: 'Ubot', text: 'hello', ts: '2.0' },
    ] }), { status: 200 }),
  );
  const out = await fetchThreadReplies('xoxb-tok', 'C1', '1.0', { fetchImpl: fn });
  assert.equal(out.length, 2);
  assert.equal(out[0].text, 'hi');
  assert.equal(out[1].bot_id, 'B1');
  assert.match(calls[0].url, /conversations\.replies\?channel=C1&ts=1\.0&limit=200/);
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer xoxb-tok');
});

test('fetchThreadReplies: ok:false → empty array', async () => {
  const { fn } = fakeFetch(() => new Response(JSON.stringify({ ok: false, error: 'thread_not_found' }), { status: 200 }));
  assert.deepEqual(await fetchThreadReplies('t', 'C1', '1.0', { fetchImpl: fn }), []);
});

test('fetchChannelHistory: GETs conversations.history and reverses to chronological order', async () => {
  const { fn, calls } = fakeFetch(() =>
    new Response(JSON.stringify({ ok: true, messages: [
      { user: 'U2', text: 'newest', ts: '2.0' },
      { user: 'U1', text: 'oldest', ts: '1.0' },
    ] }), { status: 200 }),
  );
  const out = await fetchChannelHistory('xoxb-tok', 'C1', { fetchImpl: fn });
  assert.deepEqual(out.map((m) => m.text), ['oldest', 'newest']);
  assert.match(calls[0].url, /conversations\.history\?channel=C1&limit=30/);
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer xoxb-tok');
});

test('fetchChannelHistory: ok:false → empty array; limit clamps to 200', async () => {
  const { fn } = fakeFetch(() => new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), { status: 200 }));
  assert.deepEqual(await fetchChannelHistory('t', 'C1', { fetchImpl: fn }), []);
  const { fn: fn2, calls } = fakeFetch(() => new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 }));
  await fetchChannelHistory('t', 'C1', { fetchImpl: fn2, limit: 999 });
  assert.match(calls[0].url, /limit=200/);
});

await run();
