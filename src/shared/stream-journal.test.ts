// Stream-journal partial-content stripping — run: npx tsx src/shared/stream-journal.test.ts
//
// Guards the invariant the @flue/runtime patch relies on: dropping partial.content
// before journaling is both (a) necessary — the unstripped batch blows past DO
// SQLite's ~2 MB value ceiling — and (b) lossless — Flue's stream reconstruction
// rebuilds content from the deltas, so the recovered text is byte-identical.

import assert from 'node:assert/strict';
import { createTestRunner } from './test-utils';
import { stripPartialContent, type MaybePartialEvent } from './stream-journal';

const { test, run } = createTestRunner();

// Build a realistic delta stream: a message growing one token per delta, where each
// event carries the full message-so-far as partial.content (exactly what pi-ai emits).
function buildDeltaStream(deltas: number, tokenSize: number): MaybePartialEvent[] {
  const events: MaybePartialEvent[] = [];
  const blocks: { type: 'text'; text: string }[] = [{ type: 'text', text: '' }];
  for (let i = 0; i < deltas; i++) {
    const token = 'x'.repeat(tokenSize);
    blocks[0].text += token;
    events.push({
      type: 'text_delta',
      contentIndex: 0,
      delta: token,
      // partial snapshot — grows every delta (the quadratic culprit)
      partial: { role: 'assistant', model: 'm', content: [{ type: 'text', text: blocks[0].text }] },
    });
  }
  return events;
}

// Faithful minimal port of Flue's reconstructInterruptedStream content rebuild:
// content comes from the deltas, NEVER from partial.content.
function rebuildText(events: MaybePartialEvent[]): string {
  let text = '';
  for (const e of events) if (e.type === 'text_delta') text += e.delta as string;
  return text;
}

const SQLITE_VALUE_CEILING = 2_000_000;

test('unstripped batch demonstrates the bug: a single flush segment exceeds the SQLite value ceiling', () => {
  // 800 deltas × 50 bytes ≈ a 40 KB message — modest — yet the per-delta snapshots
  // sum quadratically to tens of MB in one segment.
  const events = buildDeltaStream(800, 50);
  const messageBytes = (events.at(-1)!.partial!.content as { text: string }[])[0].text.length;
  const segmentBytes = JSON.stringify(events).length;

  assert.ok(messageBytes < 50_000, `message itself is small (${messageBytes} B)`);
  assert.ok(
    segmentBytes > SQLITE_VALUE_CEILING,
    `unstripped segment must exceed the ceiling to reproduce SQLITE_TOOBIG (got ${segmentBytes} B)`,
  );
});

test('stripped batch stays well under the ceiling (linear, not quadratic)', () => {
  const events = buildDeltaStream(800, 50);
  const stripped = events.map(stripPartialContent);
  const segmentBytes = JSON.stringify(stripped).length;

  assert.ok(
    segmentBytes < SQLITE_VALUE_CEILING / 10,
    `stripped segment should be an order of magnitude under the ceiling (got ${segmentBytes} B)`,
  );
});

test('stripping is lossless: rebuilt text is identical before and after', () => {
  const events = buildDeltaStream(200, 20);
  const stripped = events.map(stripPartialContent);
  assert.equal(rebuildText(stripped), rebuildText(events));
});

test('stripping preserves partial metadata (only content is emptied)', () => {
  const [e] = buildDeltaStream(1, 10);
  const s = stripPartialContent(e);
  assert.equal(s.partial!.role, 'assistant');
  assert.equal(s.partial!.model, 'm');
  assert.deepEqual(s.partial!.content, []);
});

test('stripping never mutates the original event', () => {
  const [e] = buildDeltaStream(1, 10);
  const before = (e.partial!.content as unknown[]).length;
  stripPartialContent(e);
  assert.equal((e.partial!.content as unknown[]).length, before, 'original partial.content untouched');
});

test('events without a partial pass through untouched', () => {
  const e: MaybePartialEvent = { type: 'toolcall_start', contentIndex: 0 };
  assert.equal(stripPartialContent(e), e);
});

await run();
