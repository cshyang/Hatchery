# Ambient Ingestion (Layer 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Log every human message in a bound Slack channel to the transcript (no LLM turn, agent stays silent), while keeping nightly REM consolidation scoped to bot conversations only — so Phase 3's cross-thread index has a full-channel corpus to read.

**Architecture:** Add an `ambient` flag to the `messages` table. `app.ts` logs non-engaged channel messages with `ambient=1` at the point it currently returns silent; the engaged path is untouched (logs with the default `ambient=0`). Reflection's two watermark queries gain `AND ambient = 0`, so REM ignores ambient rows. The future index (Layer 3) will read all rows regardless — flipping REM to consume ambient later is a one-line filter deletion.

**Tech Stack:** TypeScript, Cloudflare D1 (SQLite), Hono gateway, hand-rolled `node:assert/strict` tests run via `tsx`.

**Why a flag, not just "log everything":** Ambient data's named consumers (per the Layer 2 design) are the index and the review — NOT REM. Letting REM distil whole-channel chatter into the 2k-cap memory would be an unrequested behavior change smuggled in because the rows share a table. The `ambient` column keeps Phase 2 silent (its whole point) while banking the corpus.

---

### Task 1: Migration — add the `ambient` column

**Files:**
- Create: `migrations/0009_messages_ambient.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Ambient-ingestion flag for the transcript (Layer 2). Apply:
-- npx wrangler d1 execute hatchery-skills --remote --file=migrations/0009_messages_ambient.sql
--
-- ambient=1 marks a message the bot OVERHEARD in a bound channel but did not engage with
-- (no @mention, not a thread it's in). These rows build the cross-thread index (Layer 3) and
-- feed the proactive review (Layer 4). Nightly REM (reflection) filters them out with
-- `AND ambient = 0`, so overheard chatter never gets consolidated into the curated memory.
--
-- No backfill: every existing row is an engaged message, and DEFAULT 0 classifies it correctly.

ALTER TABLE messages ADD COLUMN ambient INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 2: Commit**

```bash
git add migrations/0009_messages_ambient.sql
git commit -m "migrate: add ambient flag to messages (Layer 2 ingestion)"
```

> Remote apply is an execution step at the END of the plan (Task 5), after the code is merged — additive `ADD COLUMN` with a DEFAULT is safe and must land on remote D1 *before* the next deploy, or the new `INSERT` would reference a missing column.

---

### Task 2: Teach `logMessage` the flag + make reflection skip ambient rows

**Files:**
- Modify: `src/reflection.ts` (`LogMessageInput`, `logMessage`, `projectsWithUnreflected`, `takeUnreflectedBatch`)
- Test: `src/reflection.test.ts` (extend `FakeD1`, add two tests)

- [ ] **Step 1: Write the failing tests**

First extend the `FakeD1` fake so it understands the new column. In `src/reflection.test.ts`:

Update the `MsgRow` interface (line 9) to add `ambient`:

```typescript
interface MsgRow { id: number; project_id: string; conversation_id: string; sender_id: string; role: string; text: string; ambient: number; created_at: number; }
```

Update the `projectsWithUnreflected` fake branch (the `LEFT JOIN reflection_state` block) to skip ambient rows — change the `if` condition inside the loop:

```typescript
    if (q.includes('LEFT JOIN reflection_state')) {
      const seen = new Set<string>();
      const out: { project_id: string }[] = [];
      for (const m of this.msgs) {
        if (!m.ambient && m.id > (this.state.get(m.project_id) ?? 0) && !seen.has(m.project_id)) {
          seen.add(m.project_id);
          out.push({ project_id: m.project_id });
        }
      }
      return out;
    }
```

Update the `takeUnreflectedBatch` fake branch (the `WHERE project_id=? AND id>?` block) to filter ambient:

```typescript
    if (q.includes('WHERE project_id=? AND id>?')) {
      const [pid, since] = v as [string, number];
      const limit = Number((q.match(/LIMIT (\d+)/) ?? [])[1] ?? 1e9);
      return this.msgs
        .filter((m) => m.project_id === pid && m.id > since && !m.ambient)
        .sort((a, b) => a.id - b.id)
        .slice(0, limit)
        .map((m) => ({ id: m.id, conversation_id: m.conversation_id, sender_id: m.sender_id, role: m.role, text: m.text }));
    }
```

Update the INSERT exec branch to destructure and store `ambient` (the new bind order is `project_id, conversation_id, sender_id, role, text, ambient, created_at`):

```typescript
    if (q.startsWith('INSERT INTO messages')) {
      const [project_id, conversation_id, sender_id, role, text, ambient, created_at] = v as [string, string, string, string, string, number, number];
      this.msgs.push({ id: this.nextId++, project_id, conversation_id, sender_id, role, text, ambient, created_at });
    } else if (q.includes('INSERT INTO reflection_state')) {
```

Now add the two new tests (after the existing `attribution:` test, before `const main`):

```typescript
test('reflection skips ambient rows: only engaged messages are consolidated', async () => {
  const db = new FakeD1();
  await logMessage(db, { projectId: 'A', conversationId: 'c1', senderId: 'slack:T:U1', role: 'user', text: 'engaged-msg' });
  await logMessage(db, { projectId: 'A', conversationId: 'c1', senderId: 'slack:T:U2', role: 'user', text: 'ambient-msg', ambient: true });
  assert.deepEqual(await projectsWithUnreflected(db), ['A']);
  const batch = (await takeUnreflectedBatch(db, 'A'))!;
  assert.ok(batch.includes('engaged-msg'), 'engaged message consolidated');
  assert.ok(!batch.includes('ambient-msg'), 'ambient message skipped by REM');
});

test('reflection gate ignores ambient-only projects (no REM turn for pure chatter)', async () => {
  const db = new FakeD1();
  await logMessage(db, { projectId: 'B', conversationId: 'c1', senderId: 'slack:T:U1', role: 'user', text: 'just chatter', ambient: true });
  assert.deepEqual(await projectsWithUnreflected(db), [], 'ambient-only project does not trigger REM');
  assert.equal(await takeUnreflectedBatch(db, 'B'), null, 'nothing to consolidate');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx src/reflection.test.ts`
Expected: FAIL — `logMessage` doesn't accept `ambient` yet (TS error on the option), and even past that the INSERT binds 6 params (no ambient) so the fake's 7-destructure leaves `created_at` undefined.

- [ ] **Step 3: Update `src/reflection.ts`**

Add `ambient` to `LogMessageInput`:

```typescript
export interface LogMessageInput {
  projectId: string;
  conversationId: string;
  senderId: string; // 'slack:<team>:<user>' for people, 'agent' for the bot
  role: 'user' | 'agent';
  text: string;
  /** True for a message the bot overheard but did not engage (Layer 2 ambient ingestion).
   *  Ambient rows feed the cross-thread index/review but are SKIPPED by nightly REM below. */
  ambient?: boolean;
}
```

Update `logMessage` to bind the flag (note the new column in both the column list and the placeholders):

```typescript
export async function logMessage(db: D1Like, m: LogMessageInput): Promise<void> {
  const text = m.text.trim();
  if (!text) return;
  await db
    .prepare(
      'INSERT INTO messages(project_id, conversation_id, sender_id, role, text, ambient, created_at) VALUES(?,?,?,?,?,?,?)',
    )
    .bind(m.projectId, m.conversationId, m.senderId, m.role, text, m.ambient ? 1 : 0, Date.now())
    .run();
}
```

Add `AND m.ambient = 0` to the `projectsWithUnreflected` gate:

```typescript
  const { results } = await db
    .prepare(
      `SELECT m.project_id AS project_id
         FROM messages m
         LEFT JOIN reflection_state r ON r.project_id = m.project_id
        WHERE m.id > COALESCE(r.last_message_id, 0) AND m.ambient = 0
        GROUP BY m.project_id`,
    )
    .bind()
    .all<{ project_id: string }>();
```

Add `AND ambient = 0` to the `takeUnreflectedBatch` SELECT (leave the watermark INSERT and the rest untouched):

```typescript
  const { results } = await db
    .prepare(
      `SELECT id, conversation_id, sender_id, role, text FROM messages
        WHERE project_id=? AND id>? AND ambient = 0 ORDER BY id LIMIT ${BATCH_LIMIT}`,
    )
    .bind(projectId, since)
    .all<{ id: number; conversation_id: string; sender_id: string; role: string; text: string }>();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx src/reflection.test.ts`
Expected: PASS — all prior tests plus the two new ones (existing tests still pass because `logMessage` defaults `ambient` to 0).

- [ ] **Step 5: Commit**

```bash
git add src/reflection.ts src/reflection.test.ts
git commit -m "feat(reflection): ambient flag on logMessage; REM skips ambient rows"
```

---

### Task 3: Wire ambient ingestion into the gateway

**Files:**
- Modify: `.flue/app.ts` (the `/slack/events` engage gate, lines ~359-453)

No unit test — this is gateway wiring with env-bound HTTP handlers the suite doesn't harness (consistent with how Layer 1's `app.ts` wiring was verified). Correctness is pinned by `tsc` + the Task 2 reflection test (which guards the `ambient = 0` filter that makes this safe) + a manual Slack check in Task 4.

- [ ] **Step 1: Hoist `eventId` + `normalizeSlackMessage` above the engage gate, and replace the gate with an ambient-logging branch**

Find this block (current lines ~359-378):

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

  const msg = normalizeSlackMessage(
    body.event_id ?? `${ev.channel}:${ev.ts}`,
    body.team_id ?? '',
    { channel: ev.channel, ts: ev.ts, thread_ts: ev.thread_ts, user: ev.user, text: stripMention(text, binding.transportBotId) },
    binding,
  );
```

Replace it with:

```typescript
  const text = ev.text ?? '';
  const token = (c.env as Record<string, string | undefined>)[binding.transportTokenRef];
  // Fetch the thread ONCE (if any) and reuse it for BOTH the participation check and the backscroll
  // we hand the agent — so a threaded turn is no longer context-blind. One conversations.replies call.
  const threadReplies =
    ev.thread_ts && token
      ? await fetchThreadReplies(token, ev.channel, ev.thread_ts).catch(() => [])
      : [];

  const eventId = body.event_id ?? `${ev.channel}:${ev.ts}`;
  // Normalize once — both the ambient-log branch and the engaged path below use this.
  const msg = normalizeSlackMessage(
    eventId,
    body.team_id ?? '',
    { channel: ev.channel, ts: ev.ts, thread_ts: ev.thread_ts, user: ev.user, text: stripMention(text, binding.transportBotId) },
    binding,
  );

  // Engage policy: @mention anywhere, or a reply in a thread the bot already posted in.
  const engaged =
    mentionsBot(text, binding.transportBotId) ||
    threadReplies.some((m) => m.user === binding.transportBotId);

  if (!engaged) {
    // Ambient ingestion (Layer 2): remember every message in a bound channel even when we won't
    // answer it, so the cross-thread index (Layer 3) and proactive review (Layer 4) can see the
    // whole room — not just threads the bot was pulled into. NO dispatch, NO LLM turn; the agent
    // stays silent. Flagged ambient:true so nightly REM keeps consolidating ONLY bot conversations.
    // Deduped against Slack's at-least-once retries with the same KV claim the engaged path uses
    // (an event is ambient XOR engaged, so the two claim sites never fire on the same event_id).
    if (c.env.DB && (await claimEvent(c.env.SLACK_EVENTS, eventId))) {
      await logMessage(c.env.DB, {
        projectId: msg.projectId,
        conversationId: msg.conversationId,
        senderId: msg.senderId,
        role: 'user',
        text: msg.text,
        ambient: true,
      }).catch(() => {});
    }
    return c.body(null, 200);
  }
```

- [ ] **Step 2: Remove the now-duplicate `eventId` declaration in the engaged path**

The engaged path re-declares `eventId` (current line ~398). Since it's now hoisted above, find and DELETE this line:

```typescript
  const eventId = body.event_id ?? `${ev.channel}:${ev.ts}`;
```

...leaving the claim that follows it (`if (!(await claimEvent(c.env.SLACK_EVENTS, eventId)))...`) referencing the hoisted `eventId`.

- [ ] **Step 3: Refresh the two now-stale comments in the engaged path**

The engaged-path idempotency comment still says chatter costs no KV; the engaged-path log comment still says we only log bot conversations. Both are now false. Update them.

Change the idempotency comment (current lines ~395-397) to:

```typescript
  // Idempotency: Slack redelivers the same event_id on retry (at-least-once). Claim it before
  // dispatch so a retry can't fire a second reply. (Ambient messages claim it too, above — every
  // persisted message is deduped now, not just dispatch-bound ones.)
```

Change the transcript-log comment (current lines ~421-422) to:

```typescript
  // Log the engaged turn to the transcript (ambient defaults to 0, so nightly REM consolidates it).
  // Best-effort — a logging hiccup must never block the reply.
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean (no errors). This confirms the hoist, the removed duplicate `eventId`, and the new `ambient` option all line up.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all files pass, including the two new reflection tests.

- [ ] **Step 6: Commit**

```bash
git add .flue/app.ts
git commit -m "feat(slack): ambient-log non-engaged channel messages (Layer 2)"
```

---

### Task 4: Manual verification (Slack)

**No files.** Confirm the behavior end-to-end before merging. (If a live Slack workspace isn't available this session, note it as deferred — the unit tests + typecheck cover the logic; this step validates the wiring.)

- [ ] **Step 1: Post a non-mention message** in a bound channel (a channel where the bot has been @mentioned at least once, so a binding exists). The bot must stay SILENT (no reply, no working-ack).

- [ ] **Step 2: Confirm the row landed** — query remote D1:

```bash
npx wrangler d1 execute hatchery-skills --remote --command "SELECT sender_id, ambient, substr(text,1,40) AS text FROM messages ORDER BY id DESC LIMIT 5"
```
Expected: the non-mention message present with `ambient = 1`; any engaged message with `ambient = 0`.

- [ ] **Step 3: Confirm REM is unaffected** — the ambient-only row must NOT surface a project for reflection. (Trust the unit test for this; optionally trigger `/__internal/reflect-sweep` and confirm an ambient-only channel reports `swept: 0`.)

---

### Task 5: Apply migration to remote + finish the branch

- [ ] **Step 1: Apply migration 0009 to remote D1**

```bash
npx wrangler d1 execute hatchery-skills --remote --file=migrations/0009_messages_ambient.sql
```
Expected: success. This is additive and safe; it must precede any deploy of the Task 3 code.

- [ ] **Step 2: Finish the development branch**

Use superpowers:finishing-a-development-branch — verify `npm test` passes, then present merge/PR options.

---

## Self-Review

**Spec coverage (against the Layer 2 section of `2026-06-01-slack-teammate-proactive-memory-design.md`):**
- "Stop dropping non-@mention channel messages; log them to the existing `messages` table" → Task 3 (ambient branch).
- "cheap D1 write, no LLM turn" → Task 3 logs + returns 200; no `dispatch`.
- "Ingesting ≠ responding — the agent stays silent" → Task 3 returns before working-ack/dispatch.
- REM-blast-radius guard (resolved during planning, beyond the spec's text) → Tasks 1+2 (`ambient` column + `AND ambient = 0`).

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `ambient?: boolean` on `LogMessageInput`; `logMessage` binds `m.ambient ? 1 : 0`; `app.ts` passes `ambient: true`; the FakeD1 stores/filters a numeric `ambient`. INSERT column order `(…, text, ambient, created_at)` matches the fake's 7-tuple destructure. `eventId` is declared exactly once (hoisted) after Task 3 Step 2.

**Boundary noted:** messages in a channel with NO binding (before the bot's first @mention there) are still dropped — there's no project to attribute them to. Ambient logging begins once a channel becomes a project. Intentional; not a gap.
