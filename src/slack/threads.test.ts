// Thread backscroll: fetch + render for context hydration — run: npx tsx src/slack/threads.test.ts
import assert from 'node:assert/strict';
import { renderThreadBackscroll, fetchThreadReplies, type ThreadMessage } from './threads';

const tests: [string, () => Promise<void>][] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

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

const main = async () => {
  let pass = 0, fail = 0;
  for (const [n, fn] of tests) {
    try { await fn(); console.log(`  ✓ ${n}`); pass++; }
    catch (e) { console.log(`  ✗ ${n}\n    ${(e as Error).message}`); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
};
await main();
