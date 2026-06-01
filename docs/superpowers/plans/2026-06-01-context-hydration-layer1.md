# Context Hydration (Layer 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the agent is @mentioned (or continues) in a Slack thread, give it the thread's prior messages so it stops answering context-blind.

**Architecture:** Two new pure-ish functions in `src/slack/threads.ts` — `fetchThreadReplies` (one `conversations.replies` call, fetch-injected for tests) and `renderThreadBackscroll` (pure formatter). The Slack gateway (`.flue/app.ts`) fetches the thread **once**, reuses it for both the existing participation check and a new `threadContext` field on the dispatch input. `botInThread` is retired (its fetch is now redundant). A prompt line tells the model how to read `threadContext`.

**Tech Stack:** TypeScript, Hono, Flue runtime, hand-rolled `node:assert` tests run via `tsx`.

---

### Task 1: `renderThreadBackscroll` — pure formatter

**Files:**
- Modify: `src/slack/threads.ts`
- Test: `src/slack/threads.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/slack/threads.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/slack/threads.test.ts`
Expected: FAIL — `renderThreadBackscroll`/`fetchThreadReplies`/`ThreadMessage` are not exported yet (import/compile error).

- [ ] **Step 3: Add the type and the formatter to `src/slack/threads.ts`**

Add at the top of `src/slack/threads.ts` (after the existing header comment, before `botInThread`):

```typescript
export interface ThreadMessage {
  user?: string;
  bot_id?: string;
  text: string;
  ts: string;
}

const BACKSCROLL_MAX_CHARS = 3000;

/** Render a Slack thread's prior messages as a compact context block for the agent's turn.
 *  The bot's own past messages are marked so the model knows what it already said. The triggering
 *  message (excludeTs) is omitted — it arrives separately as input.message. Capped to the most
 *  recent maxChars (oldest dropped first) so a long thread can't blow the context window. */
export function renderThreadBackscroll(
  messages: ThreadMessage[],
  botUserId: string,
  opts: { excludeTs?: string; maxChars?: number } = {},
): string {
  const max = opts.maxChars ?? BACKSCROLL_MAX_CHARS;
  const lines = messages
    .filter((m) => m.ts !== opts.excludeTs && m.text.trim().length > 0)
    .map((m) => {
      const who = m.bot_id || m.user === botUserId ? 'you (earlier)' : m.user ?? 'someone';
      return `${who}: ${m.text.trim()}`;
    });
  if (!lines.length) return '';
  const kept: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    total += lines[i].length + 1;
    if (total > max) break;
    kept.unshift(lines[i]);
  }
  return kept.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/slack/threads.test.ts`
Expected: PASS — `4 passed, 0 failed` (the four `renderThreadBackscroll` tests).

- [ ] **Step 5: Commit**

```bash
git add src/slack/threads.ts src/slack/threads.test.ts
git commit -m "feat(slack): renderThreadBackscroll — format thread history for context"
```

---

### Task 2: `fetchThreadReplies` — one conversations.replies call

**Files:**
- Modify: `src/slack/threads.ts`
- Test: `src/slack/threads.test.ts`

- [ ] **Step 1: Write the failing test**

First, update the import line at the top of `src/slack/threads.test.ts` to add `fetchThreadReplies`:

```typescript
import { renderThreadBackscroll, fetchThreadReplies, type ThreadMessage } from './threads';
```

Then append these two tests (immediately before the `const main = async () =>` line):

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/slack/threads.test.ts`
Expected: FAIL — `fetchThreadReplies` is not defined.

- [ ] **Step 3: Add `fetchThreadReplies` to `src/slack/threads.ts`**

Add after `renderThreadBackscroll` (before `botInThread`):

```typescript
interface RepliesApiResponse {
  ok: boolean;
  error?: string;
  messages?: Array<{ user?: string; bot_id?: string; text?: string; ts?: string }>;
}

/** Fetch a thread's messages (one conversations.replies call; needs `channels:history`).
 *  fetchImpl is injectable for tests. Returns [] on any non-ok response — a missing thread must
 *  degrade to "no backscroll", never throw into the gateway. */
export async function fetchThreadReplies(
  token: string,
  channel: string,
  threadTs: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<ThreadMessage[]> {
  const f = opts.fetchImpl ?? fetch;
  const url =
    `https://slack.com/api/conversations.replies` +
    `?channel=${encodeURIComponent(channel)}&ts=${encodeURIComponent(threadTs)}&limit=200`;
  const res = await f(url, { headers: { authorization: `Bearer ${token}` } });
  const data = (await res.json()) as RepliesApiResponse;
  if (!data.ok || !data.messages) return [];
  return data.messages.map((m) => ({ user: m.user, bot_id: m.bot_id, text: m.text ?? '', ts: m.ts ?? '' }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/slack/threads.test.ts`
Expected: PASS — all 6 tests (`5 passed... ` then both fetch tests; reads `6 passed, 0 failed`).

- [ ] **Step 5: Commit**

```bash
git add src/slack/threads.ts src/slack/threads.test.ts
git commit -m "feat(slack): fetchThreadReplies — load thread messages for hydration"
```

---

### Task 3: Wire into the gateway + retire `botInThread`

**Files:**
- Modify: `.flue/app.ts:5` (import), `.flue/app.ts:359-366` (engage block), `.flue/app.ts:436-442` (dispatch input)
- Modify: `src/slack/threads.ts` (remove `botInThread` + its `RepliesResponse` type — now orphaned)

- [ ] **Step 1: Swap the import in `.flue/app.ts`**

Change line 5 from:

```typescript
import { botInThread } from '../src/slack/threads';
```

to:

```typescript
import { fetchThreadReplies, renderThreadBackscroll } from '../src/slack/threads';
```

- [ ] **Step 2: Replace the engage block to fetch the thread once**

Replace `.flue/app.ts` lines 359-366 (the `const text` line through the closing brace of the `if (!mentionsBot...)` block):

```typescript
  const text = ev.text ?? '';
  const token = (c.env as Record<string, string | undefined>)[binding.transportTokenRef];
  // Fetch the thread ONCE (if any) and reuse it for BOTH the participation check and the backscroll
  // we hand the agent — so a threaded turn is no longer context-blind. One conversations.replies call.
  const threadReplies =
    ev.thread_ts && token
      ? await fetchThreadReplies(token, ev.channel, ev.thread_ts).catch(() => [])
      : [];
  if (!mentionsBot(text, binding.transportBotId)) {
    // Engage an un-@mentioned reply only if the bot is already participating in this thread.
    const participating = threadReplies.some((m) => m.user === binding.transportBotId);
    if (!participating) return c.body(null, 200);
  }
```

- [ ] **Step 3: Reuse `token` for the working-ack and add `threadContext` to the dispatch input**

In `.flue/app.ts`, the working-ack block now declares its own `ackToken` (around line 405). Replace that line:

```typescript
  const ackToken = (c.env as Record<string, string | undefined>)[binding.transportTokenRef];
  if (ackToken) {
```

with (reuse the `token` from Step 2):

```typescript
  if (token) {
```

…and update the `postMessage(ackToken, ...)` call on the next lines to `postMessage(token, ...)`.

Then change the dispatch `input` object (lines 436-442) to:

```typescript
    input: {
      message: msg.text,
      conversationId: msg.conversationId,
      provider: msg.provider,
      accountId: msg.externalAccountId,
      senderId: msg.senderId,
      ...(threadReplies.length
        ? { threadContext: renderThreadBackscroll(threadReplies, binding.transportBotId, { excludeTs: ev.ts }) }
        : {}),
    },
```

- [ ] **Step 4: Remove the now-orphaned `botInThread` from `src/slack/threads.ts`**

Delete the `RepliesResponse` interface and the entire `botInThread` function (they were the only consumer of that fetch; the gateway no longer calls them). Keep `ThreadMessage`, `renderThreadBackscroll`, `fetchThreadReplies`, and the `RepliesApiResponse` interface.

- [ ] **Step 5: Verify the project still compiles and all tests pass**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: exit 0, no errors (no remaining reference to `botInThread`).

Run: `npm test && npx tsx src/slack/threads.test.ts`
Expected: every suite reads `… 0 failed`.

- [ ] **Step 6: Commit**

```bash
git add .flue/app.ts src/slack/threads.ts
git commit -m "feat(slack): hydrate threaded turns with backscroll; retire botInThread"
```

---

### Task 4: Tell the model how to read `threadContext`

**Files:**
- Modify: `src/prompt.ts:106-107` (the `[Dispatch Input]` explanation)

- [ ] **Step 1: Add the threadContext bullet**

In `src/prompt.ts`, the `message` bullet ends at line 107 (`…lands in the originating thread/chat.\n` +). Insert a new bullet immediately after it, before the `"kind":"heartbeat"` bullet:

```typescript
      `• "threadContext" field (when present) → the earlier messages in this Slack thread, oldest first, ` +
      `with your own past replies marked "you (earlier)". Read it as the conversation so far before you ` +
      `answer the "message"; it is context, not a new request, and you've already seen it.\n` +
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/prompt.ts
git commit -m "feat(prompt): explain the threadContext dispatch field to the agent"
```

---

### Task 5: Add the new test to `npm test` + final verification

**Files:**
- Modify: `package.json:10` (test script)

- [ ] **Step 1: Append the new suite to the test script**

In `package.json`, change the `"test"` script to end with the new file:

```json
    "test": "tsx src/memory.test.ts && tsx src/reflection.test.ts && tsx src/skills.test.ts && tsx src/conversations.test.ts && tsx src/connections.test.ts && tsx src/bindings.test.ts && tsx src/users.test.ts && tsx src/nango.test.ts && tsx src/slack/threads.test.ts"
```

- [ ] **Step 2: Run the full suite + typecheck**

Run: `npm test`
Expected: every suite reads `… 0 failed`, including `threads.test.ts` (`6 passed, 0 failed`).

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: run slack/threads tests in npm test"
```

---

## Manual verification (after all tasks)

Layer 1 has no end-to-end automated test (the gateway wiring is integration). Confirm in `flue dev` or a deployed channel:

1. In a Slack thread, have a person write 2–3 messages **without** the bot, then @mention the bot asking "what do you think?" → the reply should reflect the earlier messages (not ask "about what?").
2. Top-level @mention (no thread) → still works; no `threadContext` (nothing to hydrate).
3. A long thread (>3000 chars) → reply still lands; backscroll silently capped to recent messages.

## Self-review notes

- **Spec coverage:** implements Layer 1 (context hydration → "feed the thread you already fetch into the turn") from the design doc. Layers 2–4 are out of scope for this plan.
- **Type consistency:** `ThreadMessage` defined in Task 1, consumed by `fetchThreadReplies` (Task 2) and `renderThreadBackscroll` (Task 1); gateway uses both (Task 3). Names stable across tasks.
- **Reused vs new:** reuses the `conversations.replies` call `botInThread` already made (now the single fetch); adds no storage.
