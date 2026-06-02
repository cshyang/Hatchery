# Cross-Thread Connect (Layer 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the agent a `search_channel` tool over the already-ingested `messages` table with two modes — a keyword `query` finds prior threads on a topic ("there's an earlier thread about this", Connect), and an omitted `query` returns recent channel activity (catch-up). Both cite real discussions, never fabricated ones. This closes the gap the live agent named itself: *"if you ask me something in a new thread, I won't remember what we discussed in older threads."*

**Architecture:** An agent-pull tool (not gateway-push), bound to the project at DO-init (dispatch-safe), querying the existing transcript. No index, no migration, no backfill — Phase 2 already banked the whole channel into `messages`. The query is tokenized to alphanumeric terms (neutralizing SQL-LIKE injection by construction), OR-matched per message, then grouped into threads and scored in JS by distinct-term coverage + recency. The model receives candidate threads and decides whether any is genuinely the same topic; restraint is the load-bearing behavior. Recall comes from the (blunt) keyword match; precision comes from the model.

**Tech Stack:** TypeScript, Cloudflare D1 (SQLite `LIKE`), `@flue/runtime` (`defineTool`, `Type`), hand-rolled `node:assert/strict` tests via `tsx`. Mirrors the `src/users.ts` (`resolveUserName` + `userTools`) module shape.

**Explicitly deferred (YAGNI):**
- **Permalinks** — v1 returns a snippet + date; the model references threads descriptively. Add `chat.getPermalink` (one bot-token call per cited thread) once Connect's recall proves useful in real use. The tool contract doesn't change when added.
- **FTS5 index** — verified working on our D1, but `LIKE` over the existing table is the cheapest thing that could work. Upgrade `searchRelatedThreads`' internals (the only thing that changes) to an FTS5 shadow table if recall proves too blunt. Tool contract stays identical.
- **Ambient filter** — the search includes ambient rows (it's all public channel content; agent-pull + model-judgment gate relevance). To later restrict Connect to bot-participated threads, add `AND ambient = 0` to the one query. Not built now.

---

### Task 1: `searchRelatedThreads` + helpers (the retrieval logic)

**Files:**
- Create: `src/search.ts`
- Test: `src/search.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/search.test.ts`:

```typescript
// Cross-thread Connect retrieval — run: npx tsx src/search.test.ts
import assert from 'node:assert/strict';
import { buildSearchTerms, parseConversationId, searchRelatedThreads, recentThreads } from './search';
import type { D1Like } from './skills';

// ── helper unit tests ───────────────────────────────────────────────────────
const tests: [string, () => Promise<void>][] = [];
const test = (n: string, f: () => Promise<void>) => tests.push([n, f]);

test('buildSearchTerms: lowercases, drops punctuation/short tokens, dedupes', async () => {
  assert.deepEqual(buildSearchTerms('Pricing model?'), ['pricing', 'model']);
  // wildcard / operator chars are stripped to alphanumerics → no LIKE injection
  assert.deepEqual(buildSearchTerms('50% OR _x_ "quote"'), ['50', 'or', 'quote']);
  assert.deepEqual(buildSearchTerms('a the to'), []); // all below min length (<2)
  assert.deepEqual(buildSearchTerms('pricing pricing PRICING'), ['pricing']); // dedupe
});

test('parseConversationId: splits slack:team:channel:thread, null on garbage', async () => {
  assert.deepEqual(parseConversationId('slack:T1:C9:170.5'), { team: 'T1', channel: 'C9', threadTs: '170.5' });
  assert.equal(parseConversationId('nonsense'), null);
});

// ── retrieval tests (FakeD1) ─────────────────────────────────────────────────
interface Row { project_id: string; conversation_id: string; text: string; created_at: number; }
// Minimal D1 fake for the ONE search query: substring-matches each `%term%` bind (LIKE is
// case-insensitive ASCII; we lowercase both sides). Binds: [projectId, excludeId, ...patterns].
class FakeD1 implements D1Like {
  constructor(private rows: Row[]) {}
  prepare(query: string) {
    const rows = this.rows;
    return {
      bind(...v: unknown[]) {
        return {
          async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
            if (!query.includes('FROM messages')) return { results: [] as T[] };
            const [projectId, excludeId, ...patterns] = v as string[];
            const terms = patterns.map((p) => p.replace(/%/g, '').toLowerCase());
            const limit = Number((query.match(/LIMIT (\d+)/) ?? [])[1] ?? 1e9);
            const out = rows
              .filter((r) => r.project_id === projectId)
              .filter((r) => r.conversation_id !== excludeId)
              // no patterns = recency mode (recentThreads) → match all; else keyword OR-match
              .filter((r) => terms.length === 0 || terms.some((t) => r.text.toLowerCase().includes(t)))
              .sort((a, b) => b.created_at - a.created_at)
              .slice(0, limit)
              .map((r) => ({ conversation_id: r.conversation_id, text: r.text, created_at: r.created_at }));
            return { results: out as T[] };
          },
          async run() { return {}; },
          async first<T = Record<string, unknown>>() { return null as T | null; },
        };
      },
    };
  }
}

const mk = (rows: Partial<Row>[]): FakeD1 =>
  new FakeD1(rows.map((r, i) => ({ project_id: 'P', conversation_id: 'slack:T:C:t' + i, text: '', created_at: i, ...r })));

test('finds a thread containing the query terms; returns snippet + conversationId', async () => {
  const db = mk([{ conversation_id: 'slack:T:C:t1', text: 'can we change the pricing model?' }]);
  const out = await searchRelatedThreads(db, 'P', 'pricing');
  assert.equal(out.length, 1);
  assert.equal(out[0].conversationId, 'slack:T:C:t1');
  assert.match(out[0].snippet, /pricing model/);
});

test('groups multiple matching messages in one thread into a single result', async () => {
  const db = mk([
    { conversation_id: 'slack:T:C:tA', text: 'pricing is too high', created_at: 1 },
    { conversation_id: 'slack:T:C:tA', text: 'agreed, the pricing tiers need work', created_at: 2 },
  ]);
  const out = await searchRelatedThreads(db, 'P', 'pricing');
  assert.equal(out.length, 1, 'two messages, one thread → one result');
});

test('ranks a thread matching MORE query terms above one matching fewer', async () => {
  const db = mk([
    { conversation_id: 'slack:T:C:tWeak', text: 'pricing only', created_at: 5 },
    { conversation_id: 'slack:T:C:tStrong', text: 'the pricing model and tiers', created_at: 1 },
  ]);
  const out = await searchRelatedThreads(db, 'P', 'pricing model tiers');
  assert.equal(out[0].conversationId, 'slack:T:C:tStrong', 'more-terms thread ranks first despite being older');
});

test('excludes the current conversation', async () => {
  const db = mk([
    { conversation_id: 'slack:T:C:here', text: 'pricing now' },
    { conversation_id: 'slack:T:C:there', text: 'pricing earlier' },
  ]);
  const out = await searchRelatedThreads(db, 'P', 'pricing', { excludeConversationId: 'slack:T:C:here' });
  assert.deepEqual(out.map((r) => r.conversationId), ['slack:T:C:there']);
});

test('scopes to the project (no cross-project leakage)', async () => {
  const db = mk([
    { project_id: 'P', conversation_id: 'slack:T:C:mine', text: 'pricing mine' },
    { project_id: 'OTHER', conversation_id: 'slack:T:D:theirs', text: 'pricing theirs' },
  ]);
  const out = await searchRelatedThreads(db, 'P', 'pricing');
  assert.deepEqual(out.map((r) => r.conversationId), ['slack:T:C:mine']);
});

test('NEGATIVE: a never-discussed topic returns nothing (no candidate to over-connect)', async () => {
  const db = mk([{ conversation_id: 'slack:T:C:t1', text: 'lunch plans for friday' }]);
  assert.deepEqual(await searchRelatedThreads(db, 'P', 'kubernetes migration'), []);
});

test('NEGATIVE: an empty/punctuation-only query returns nothing (never matches all rows)', async () => {
  const db = mk([{ conversation_id: 'slack:T:C:t1', text: 'anything' }]);
  assert.deepEqual(await searchRelatedThreads(db, 'P', '   ?!  '), []);
});

// ── recency mode (catch-up) ──────────────────────────────────────────────────
test('recentThreads: returns latest threads, newest first, one per thread', async () => {
  const db = mk([
    { conversation_id: 'slack:T:C:old', text: 'old stuff', created_at: 1 },
    { conversation_id: 'slack:T:C:new', text: 'newest stuff', created_at: 9 },
    { conversation_id: 'slack:T:C:new', text: 'older in new thread', created_at: 8 },
  ]);
  const out = await recentThreads(db, 'P');
  assert.deepEqual(out.map((r) => r.conversationId), ['slack:T:C:new', 'slack:T:C:old']);
  assert.match(out[0].snippet, /newest stuff/); // newest message in the thread is the snippet
});

test('recentThreads: excludes the current conversation', async () => {
  const db = mk([
    { conversation_id: 'slack:T:C:here', text: 'in here', created_at: 9 },
    { conversation_id: 'slack:T:C:there', text: 'over there', created_at: 1 },
  ]);
  const out = await recentThreads(db, 'P', { excludeConversationId: 'slack:T:C:here' });
  assert.deepEqual(out.map((r) => r.conversationId), ['slack:T:C:there']);
});

test('recentThreads: empty channel → []', async () => {
  assert.deepEqual(await recentThreads(mk([]), 'P'), []);
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

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx src/search.test.ts`
Expected: FAIL — `./search` doesn't exist (module not found).

- [ ] **Step 3: Write `src/search.ts`**

```typescript
// Cross-thread Connect (Layer 3): find prior threads on a topic by searching the ingested
// transcript. Agent-PULL — exposed as a tool the model calls when a question might have come up
// before. No index: queries the `messages` table Phase 2 already fills (ambient rows included).
//
// Recall is keyword-blunt by design; PRECISION is the model's job — it receives candidate threads
// and cites one ONLY if it's clearly the same topic. The query is tokenized to alphanumeric terms,
// which both removes stopword noise and neutralizes SQL-LIKE wildcard/operator injection (a term
// can never contain %, _, or a quote), so the `%term%` patterns are always safe to bind.

import { defineTool, Type, type ToolDefinition } from '@flue/runtime';
import type { D1Like } from './skills';

const RAW_LIMIT = 200; // cap rows pulled for in-JS grouping; a single channel won't exceed this for a real query
const MAX_THREADS = 4; // candidate threads handed to the model
const SNIPPET_MAX = 160;
const MIN_TERM_LEN = 2;

export interface RelatedThread {
  conversationId: string;
  channel: string | null;
  threadTs: string | null;
  snippet: string;
  when: string; // YYYY-MM-DD of the best-matching message
  score: number; // distinct query-terms matched across the thread
}

/** Tokenize a free-text query into lowercase alphanumeric terms. Drops punctuation (so a term can
 *  never carry a LIKE wildcard or quote), short tokens, and duplicates. Empty array → caller returns
 *  no results rather than running a query that would match everything. */
export function buildSearchTerms(query: string): string[] {
  const seen = new Set<string>();
  for (const tok of String(query ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (tok.length >= MIN_TERM_LEN) seen.add(tok);
  }
  return [...seen];
}

/** Split a Hatchery conversationId ("slack:<team>:<channel>:<thread_ts>") into its parts, or null. */
export function parseConversationId(cid: string): { team: string; channel: string; threadTs: string } | null {
  const m = String(cid ?? '').match(/^slack:([^:]+):([^:]+):(.+)$/);
  return m ? { team: m[1], channel: m[2], threadTs: m[3] } : null;
}

function truncate(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length <= SNIPPET_MAX ? t : t.slice(0, SNIPPET_MAX - 1) + '…';
}

/** Build a RelatedThread from a representative message (the matched/newest one in the thread). */
function toThread(conversationId: string, text: string, createdAt: number, score: number): RelatedThread {
  const parts = parseConversationId(conversationId);
  return {
    conversationId,
    channel: parts?.channel ?? null,
    threadTs: parts?.threadTs ?? null,
    snippet: truncate(text),
    when: new Date(createdAt).toISOString().slice(0, 10),
    score,
  };
}

/** Search the transcript for prior threads matching `query`, scoped to `projectId`. Returns up to
 *  MAX_THREADS candidate threads ranked by how many distinct query terms they contain, then recency.
 *  Empty query or no matches → []. The current thread can be excluded via opts.excludeConversationId. */
export async function searchRelatedThreads(
  db: D1Like,
  projectId: string,
  query: string,
  opts: { excludeConversationId?: string } = {},
): Promise<RelatedThread[]> {
  const terms = buildSearchTerms(query);
  if (!terms.length) return [];

  const ors = terms.map(() => 'text LIKE ?').join(' OR ');
  const { results } = await db
    .prepare(
      `SELECT conversation_id, text, created_at FROM messages
        WHERE project_id = ? AND conversation_id != ? AND (${ors})
        ORDER BY created_at DESC LIMIT ${RAW_LIMIT}`,
    )
    .bind(projectId, opts.excludeConversationId ?? '', ...terms.map((t) => `%${t}%`))
    .all<{ conversation_id: string; text: string; created_at: number }>();

  // Group matching messages into threads; score each thread by distinct query-terms it covers, and
  // keep the single best-covering message as the snippet (tie → most recent).
  const byThread = new Map<string, { matched: Set<string>; best: { text: string; created_at: number; hits: number } }>();
  for (const r of results ?? []) {
    const lc = r.text.toLowerCase();
    const hits = terms.filter((t) => lc.includes(t));
    if (!hits.length) continue;
    const entry = byThread.get(r.conversation_id) ?? { matched: new Set<string>(), best: { text: '', created_at: -1, hits: -1 } };
    hits.forEach((t) => entry.matched.add(t));
    if (hits.length > entry.best.hits || (hits.length === entry.best.hits && r.created_at > entry.best.created_at)) {
      entry.best = { text: r.text, created_at: r.created_at, hits: hits.length };
    }
    byThread.set(r.conversation_id, entry);
  }

  return [...byThread.entries()]
    .map(([conversationId, e]) => ({ thread: toThread(conversationId, e.best.text, e.best.created_at, e.matched.size), at: e.best.created_at }))
    .sort((a, b) => b.thread.score - a.thread.score || b.at - a.at)
    .slice(0, MAX_THREADS)
    .map((x) => x.thread);
}

/** Recency mode (catch-up): the most recent threads in the channel, regardless of topic — the
 *  newest message per thread is the snippet. Powers `search_channel` when called with no query. */
export async function recentThreads(
  db: D1Like,
  projectId: string,
  opts: { excludeConversationId?: string } = {},
): Promise<RelatedThread[]> {
  const { results } = await db
    .prepare(
      `SELECT conversation_id, text, created_at FROM messages
        WHERE project_id = ? AND conversation_id != ?
        ORDER BY created_at DESC LIMIT ${RAW_LIMIT}`,
    )
    .bind(projectId, opts.excludeConversationId ?? '')
    .all<{ conversation_id: string; text: string; created_at: number }>();

  // Rows arrive newest-first; the first time we see a thread is its newest message → the snippet.
  const seen = new Map<string, { text: string; created_at: number }>();
  for (const r of results ?? []) {
    if (!seen.has(r.conversation_id)) seen.set(r.conversation_id, { text: r.text, created_at: r.created_at });
  }
  return [...seen.entries()]
    .sort((a, b) => b[1].created_at - a[1].created_at)
    .slice(0, MAX_THREADS)
    .map(([conversationId, m]) => toThread(conversationId, m.text, m.created_at, 0));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx src/search.test.ts`
Expected: PASS — all helper + retrieval tests, including both NEGATIVE cases.

- [ ] **Step 5: Commit**

```bash
git add src/search.ts src/search.test.ts
git commit -m "feat(search): searchRelatedThreads — keyword Connect over the transcript"
```

---

### Task 2: The `search_channel` tool

**Files:**
- Modify: `src/search.ts` (append the `searchTools` factory)
- Test: `src/search.test.ts` (append tool-surface tests)

- [ ] **Step 1: Write the failing tests**

Append to `src/search.test.ts`, BEFORE the `const main =` line:

```typescript
// Tools' execute is called the way the codebase does it (see users.test.ts): a single-arg cast.
const callTool = (tool: { execute: unknown }, args: unknown) =>
  (tool.execute as (a: unknown) => Promise<unknown>)(args);

test('searchTools: exposes exactly search_channel', async () => {
  const { searchTools } = await import('./search');
  const tools = searchTools(mk([]), 'P');
  assert.deepEqual(tools.map((t) => t.name as string), ['search_channel']);
});

test('search_channel: formats found threads with snippet + date', async () => {
  const { searchTools } = await import('./search');
  const db = mk([{ conversation_id: 'slack:T:C:t1', text: 'we discussed the pricing model here', created_at: 1700000000000 }]);
  const [tool] = searchTools(db, 'P');
  const out = String(await callTool(tool, { query: 'pricing model' }));
  assert.match(out, /pricing model/);
  assert.match(out, /2023-11-14/); // date rendered from created_at
});

test('search_channel: a never-discussed topic returns a clear "nothing found" (no fabrication)', async () => {
  const { searchTools } = await import('./search');
  const db = mk([{ conversation_id: 'slack:T:C:t1', text: 'lunch plans' }]);
  const [tool] = searchTools(db, 'P');
  const out = String(await callTool(tool, { query: 'kubernetes' }));
  assert.match(out, /no earlier|nothing/i);
});

test('search_channel: no query → recent activity (catch-up mode)', async () => {
  const { searchTools } = await import('./search');
  const db = mk([{ conversation_id: 'slack:T:C:t1', text: 'latest channel chatter', created_at: 1700000000000 }]);
  const [tool] = searchTools(db, 'P');
  const out = String(await callTool(tool, {}));
  assert.match(out, /recent/i);
  assert.match(out, /latest channel chatter/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx tsx src/search.test.ts`
Expected: FAIL — `searchTools` is not exported yet.

- [ ] **Step 3: Append `searchTools` to `src/search.ts`**

Add the import of nothing new (already imports `defineTool`, `Type`, `ToolDefinition`). Append at the end of the file:

```typescript
/** Render candidate threads as a compact block the model reads. No permalinks in v1 — the model
 *  references a thread by its snippet/date; clickable cites (chat.getPermalink) are a fast-follow.
 *  The header differs by mode so the model knows whether these are topical matches (cite with care)
 *  or just a recency dump (catch-up). */
function renderThreads(threads: RelatedThread[], mode: 'search' | 'recent'): string {
  if (!threads.length) {
    return mode === 'recent' ? 'No recent activity in this channel.' : 'No earlier threads found about that.';
  }
  const header =
    mode === 'recent'
      ? 'Recent threads in this channel (most recent first):'
      : 'Possibly related earlier threads (cite ONLY if clearly the same topic):';
  const lines = threads.map((t, i) => `${i + 1}. (${t.when}) "${t.snippet}"`);
  return `${header}\n${lines.join('\n')}`;
}

/** The on-demand channel-memory tool. Closed over db + projectId (bound at DO-init, so it's
 *  dispatch-safe and can never reach another project). Two modes: a `query` runs a topical search
 *  (Connect); omitting `query` returns recent activity (catch-up). Optionally pass the current
 *  conversationId so the thread the agent is in is excluded. */
export function searchTools(db: D1Like | undefined, projectId: string): ToolDefinition[] {
  if (!db) return [];
  const searchChannel = defineTool({
    name: 'search_channel',
    description:
      "Look into THIS channel's earlier conversations. Pass `query` with a few keywords to check " +
      'whether a topic has come up before — the result is candidate threads; mention one to the ' +
      'person ONLY if it is clearly about the same thing, and if nothing fits, do not force a ' +
      'connection. OMIT `query` to instead get the most recent threads, to catch up on what has been ' +
      'happening in the channel. Optionally pass `excludeConversationId` (your current conversationId ' +
      'from the dispatch input) to skip the thread you are replying in.',
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({ description: 'A few topic keywords, e.g. "pricing model". OMIT to list recent activity instead.' }),
      ),
      excludeConversationId: Type.Optional(
        Type.String({ description: 'Your current conversationId from the dispatch input, to skip this thread.' }),
      ),
    }),
    async execute({ query, excludeConversationId }) {
      const exclude = excludeConversationId ? String(excludeConversationId) : undefined;
      const q = query ? String(query).trim() : '';
      const threads = q
        ? await searchRelatedThreads(db, projectId, q, { excludeConversationId: exclude }).catch(() => [] as RelatedThread[])
        : await recentThreads(db, projectId, { excludeConversationId: exclude }).catch(() => [] as RelatedThread[]);
      return renderThreads(threads, q ? 'search' : 'recent');
    },
  });
  return [searchChannel];
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx tsx src/search.test.ts`
Expected: PASS — all Task 1 + Task 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/search.ts src/search.test.ts
git commit -m "feat(search): search_channel tool — agent-pull Connect"
```

---

### Task 3: Wire the tool + prompt guidance into the agent

**Files:**
- Modify: `.flue/agents/project.ts` (import + tools array)
- Modify: `src/prompt.ts` (a CONNECT guidance block)
- Modify: `package.json` (add `src/search.test.ts` to the test script)

- [ ] **Step 1: Register the tool in `.flue/agents/project.ts`**

Add the import near the other `src/` tool imports (after the `userTools` import, line ~9):

```typescript
import { searchTools } from '../../src/search';
```

Add it to the `tools` array (after `...userTools(db, botToken),`):

```typescript
    ...userTools(db, botToken),
    ...(db ? searchTools(db, projectId) : []),
    ...nangoTools,
```

- [ ] **Step 2: Add the CONNECT guidance block in `src/prompt.ts`**

After the `SLACK_FORMATTING` constant (line ~56), add:

```typescript
// Connect: use the channel's history before answering as if a topic is brand-new. The restraint
// half is load-bearing — a blunt keyword search almost always returns SOMETHING, so the rule is
// "cite only a genuine match, never a forced one." This fights the over-connect failure mode.
const CONNECTING_THE_DOTS =
  `CONNECTING THE DOTS\n` +
  `You can see the channel's earlier conversations with search_channel (pass your current conversationId ` +
  `as excludeConversationId so it skips this thread). When someone raises a topic that may have come up ` +
  `before, call it with a few keywords FIRST; if a result is clearly about the same thing, briefly point ` +
  `to it ("we touched on this earlier — …"). If nothing is clearly relevant, say nothing about it and just ` +
  `answer — never invent or force a cross-reference; a wrong "this relates to X" is worse than none. When ` +
  `asked to catch up on recent channel activity, call search_channel with NO query to list the latest threads.`;
```

Add it to the `blocks.push(...)` of behavioral guidance (line ~125), alongside the others:

```typescript
  blocks.push(FINISHING_THE_JOB, USING_YOUR_TOOLS, SLACK_FORMATTING, CONNECTING_THE_DOTS);
```

- [ ] **Step 3: Add the test to the suite in `package.json`**

Change the `test` script's tail from:

```
... && tsx src/slack/threads.test.ts"
```

to:

```
... && tsx src/slack/threads.test.ts && tsx src/search.test.ts"
```

- [ ] **Step 4: Typecheck + full suite**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npm test`
Expected: all files pass, including `src/search.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add .flue/agents/project.ts src/prompt.ts package.json
git commit -m "feat(agent): register search_channel + Connect prompt guidance (Layer 3)"
```

---

### Task 4: Manual verification (Slack) — the real acceptance test

**No files.** Connect's value AND its main risk are behavioral, so verify both directions. (Defer if no live workspace this session; the unit tests cover the retrieval + the negative case, but the model's restraint can only be checked live.)

- [ ] **Step 1: Positive** — in a bound channel, @mention the bot about a topic genuinely discussed in an earlier thread. The reply should reference that earlier thread (snippet/recognizable).

- [ ] **Step 2: NEGATIVE (the one that matters)** — @mention the bot about a topic NEVER discussed in the channel. The reply must NOT claim a bogus connection ("this relates to the … thread"). It should just answer. If it fabricates a cross-reference, tighten `CONNECTING_THE_DOTS` and re-verify.

- [ ] **Step 3 (optional)** — confirm search ignores other channels: the cited thread is always from the same channel (project-scoped).

---

### Task 5: Finish the branch

- [ ] **Step 1: Finish**

No migration, no remote DB change, no deploy ordering — this is pure Worker code. Use superpowers:finishing-a-development-branch: verify `npm test`, present merge/PR options. (Behavior ships at the next deploy, same as Phase 2; Task 4 runs post-deploy.)

---

## Self-Review

**Spec coverage (Layer 3 of `2026-06-01-slack-teammate-proactive-memory-design.md`):**
- "retrieval index over the transcript → answer what else has been discussed about X" → `searchRelatedThreads` (Task 1).
- "cite real threads" → results carry conversationId/channel/threadTs + snippet (Task 1); model references them (Task 3 prompt).
- "Powers Connect on @mention (reactive)" → `search_channel` agent tool (Task 2), prompt tells the model to call it (Task 3).
- "Confidence gate: cite only above a threshold; else stay silent" → REPLACED by model-as-precision-filter + restraint prompt (the recall-only reframe); the negative unit test + Task 4 Step 2 enforce it. Documented divergence from the spec's FTS+threshold approach, with rationale in the plan header.
- "D1 FTS first vs embeddings — FTS first" → SUPERSEDED: `LIKE` over the existing table beats building an FTS index for v1 (no migration/backfill); FTS5 is the documented upgrade path behind the same function.

**Placeholder scan:** none — full code in every step.

**Type consistency:** `RelatedThread` shape is produced by `searchRelatedThreads` and consumed by `renderRelatedThreads`; `searchTools(db, projectId)` matches the `userTools(db, token)` factory signature and the `...(db ? f() : [])` wiring used for `skillTools`/`memoryTools`. `buildSearchTerms`/`parseConversationId`/`searchRelatedThreads` names match between `search.ts` and `search.test.ts`. Tool `execute` is called in tests with `(args, undefined as never)` to match the `(args, signal)` runtime signature.

**Boundary noted:** the tool searches `messages`, which includes ambient rows (intended — public channel content). Cross-project leakage is prevented by `WHERE project_id = ?`. The current thread is excluded only when the model passes `excludeConversationId`; if it forgets, the worst case is the current thread appearing as a candidate, which the model recognizes — a soft guard, acceptable for v1.
