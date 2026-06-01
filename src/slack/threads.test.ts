// Thread backscroll: fetch + render for context hydration — run: npx tsx src/slack/threads.test.ts
import assert from 'node:assert/strict';
import { renderThreadBackscroll, type ThreadMessage } from './threads';
// NOTE: fetchThreadReplies is imported in Task 2 (added alongside its tests).

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
