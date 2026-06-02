# Proactive Review (Layer 4) — Design

**Date:** 2026-06-02
**Status:** Draft for review
**Depends on:** L1 (context hydration), L2 (ambient ingestion), L3 (`search_channel`) — all live.

## Problem

The agent today is purely **reactive** — it acts only when @mentioned or continuing a thread it's in. A teammate also *initiates*: notices an unanswered question, connects a discussion to an earlier one, follows up on a commitment. Layer 4 is the only layer where the agent speaks **unprompted**.

That is also the only layer that can misfire *in public*. Every other layer fails safe (worst case: it doesn't answer). L4 can interrupt the team uninvited, so the design centers on **restraint**, not capability.

## Core reframe (settled earlier)

**Cron is the timer; the heartbeat is the behavior.** The review is a *contentless* wake on a schedule — look around, and almost always go back to sleep. Speaking is the exception.

```
TIMER     (cron, work hours)        → WHEN it wakes
HEARTBEAT (check → usually skip)    → WHETHER it acts
```

## Decisions locked during brainstorming

- **Triggers:** (1) unanswered question, (2) connect-the-dots, (3) chase-a-commitment. ("Flag a contradiction" dropped — highest stakes, most embarrassing when wrong.)
- **Rollout:** live, rate-limited — **≤1 proactive post per project per day**, **thread-only** (never the root channel). A **shadow toggle** is built in so the operator can dry-run first.

## Architecture

```
ticker cron  */10 09–18 Mon–Fri (KL)  →  POST /__internal/review-sweep   [mirrors /__internal/reflect-sweep]
        │
   for each ACTIVE project:
   ┌────▼─ TIER 1  (no LLM — cheap SQL on review_state) ─────────────────┐
   │  new messages since last_reviewed_message_id?   ──no──► skip         │
   │  AND no proactive post in the last 24h?         ──no──► skip (budget)│
   └────┬────────────────────────────────────────────────────────────────┘
        │ both pass → takeReviewBatch (advance watermark, consume-on-take),
        │             dispatch a fresh `review:<projectId>:<ts>` session inline:
   ┌────▼─ TIER 2  (one LLM turn) ───────────────────────────────────────┐
   │  reads: activity-since-watermark (ambient INCLUDED) + memory         │
   │  tools on tap: search_channel (verify a link), set_reminder          │
   │  DRAFT a candidate → SELF-CRITIQUE                                    │
   │     "would a good teammate actually interrupt for THIS, now?"        │
   │        ├─ no  → call no tool → stay silent  (the normal outcome)     │
   │        └─ yes → proactive_reply(conversationId, text)                │
   └──────────────────────────────────────────────────────────────────────┘
```

This is the **same proven shape as nightly reflection** (`reflect-sweep`): a cheap-SQL gate, take-batch-and-advance-watermark, dispatch an inline procedure to a fresh session. The difference is cadence (every 10 min, work hours vs nightly) and the turn's job (decide-to-speak vs write-memory).

### Tier 1 — the cheap gate (no LLM)

A project qualifies for a review turn only if **both**:
- it has messages with `id > last_reviewed_message_id` (new activity), **and**
- `last_proactive_post_at` is null or older than 24h (budget available).

If budget is spent, skip entirely (do **not** advance the watermark) — tomorrow's review then sees everything since the last *actual* review and picks the single most-worthy item. Idle/quiet projects cost one SQL query and zero tokens.

### Tier 2 — the review turn (one LLM turn)

Dispatched like `reflect-sweep`: fresh `review:<projectId>:<ts>` session, `input = { kind: 'heartbeat', instructions: buildReviewInstructions(batch) }`. The batch is the channel activity since the watermark — **ambient rows included** (this is the second consumer ambient ingestion was built for; reflection filters ambient, the review does not). The turn reuses the existing agent, so it already has `search_channel`, `set_reminder`, memory, and `proactive_reply`.

The batch is rendered **with each line's `conversation_id`** (like reflection's `(conversation_id) sender: text` format) — that's how the model obtains the `conversationId` to hand `proactive_reply` when it decides to speak into a specific thread. Without it the turn would have a draft but no target.

The review procedure (a constant, like `REFLECT_PROCEDURE`) makes silence the default and speaking the rare exception:

> **PROACTIVE REVIEW** (background — you woke on a timer; nobody asked for you). Below is recent channel activity. Almost always the right move is to stay **silent** and go back to sleep. Speak only if there is **one** thing a thoughtful teammate would genuinely interrupt for:
> - an **unanswered question** you can clearly help with;
> - a **strong, specific link** to an earlier thread — call `search_channel` first and cite only a real match;
> - a **commitment that's now due** — or call `set_reminder` to follow up on one you notice coming.
>
> **Draft it, then self-critique:** would a good teammate actually say this, now, unprompted? Is it *clearly* useful, not just *plausibly* relevant? If you hesitate, stay silent.
>
> To speak, call `proactive_reply` with the `conversationId` of the relevant thread — at most one thing, never the channel root. If nothing clears the bar, call no tool. That is the normal, correct outcome.

### The three triggers, concretely

- **Unanswered question + connect-the-dots** — the *same* review turn. Connect-the-dots just adds a `search_channel` call to verify a real link before citing it. Both post into the **relevant thread**.
- **Chase a commitment** — **no new storage.** A commitment ("I'll send X by Friday") is just a reminder with a due date, and the agent already has `set_reminder`. The review notices the commitment and schedules a follow-up; the existing `/__internal/scheduled` path fires it. Trigger 3 is therefore *procedure prompt only* — no new code beyond telling the review to do it.

### `proactive_reply` — one new tool, three jobs

```
proactive_reply(conversationId, text):
  1. shadow mode?  → console.log('[review-draft] …'); return 'drafted (shadow)'   (no post, no budget spent)
  2. budget spent? (last_proactive_post_at within 24h) → refuse 'budget spent'    (authoritative ≤1/day guard)
  3. post into the thread (target built from conversationId + binding)            (always in-thread → never root)
  4. record last_proactive_post_at = now                                          (consume the budget)
```

Closed over `db` + `projectId` at DO-init (dispatch-safe, like `search_channel`). It is the *authoritative* ≤1/day enforcer (Tier-1's budget check is just an optimization to skip the LLM). It always posts to the **thread** of the given `conversationId`; replying in-thread to any message — even a top-level one — is a threaded reply, never a root-channel broadcast, so the venue rule is enforced in code, not just prompt.

### Venue policy (v1)

**Thread-only.** All three triggers are naturally thread posts (reply where the question/topic/commitment lives). **Never the root channel.** DM venue is deferred (needs `conversations.open` plumbing and isn't required by these triggers).

### Noise budget

**≤1 proactive post per project per rolling 24h.** Enforced authoritatively in `proactive_reply`, optimized at the Tier-1 gate. Commitment follow-ups go through the separate reminder/scheduled path and are **not** counted against this budget (they're tracked obligations, not unsolicited observations) — confirm during planning.

### Shadow toggle (the operator's dry-run)

`REVIEW_MODE` env var: `'shadow' | 'live'`, **defaulting to `shadow`**. In shadow, `proactive_reply` logs `[review-draft] <conversationId>: <text>` (visible via `wrangler tail`) instead of posting, and does not consume budget. The review still runs end-to-end, so the operator watches the restraint gate against real activity with **zero blast radius**, then sets `REVIEW_MODE=live`. This is the same tail-based verification used to prove L3, applied as a safety valve.

## State: the `review_state` table

```sql
CREATE TABLE IF NOT EXISTS review_state (
  project_id               TEXT    PRIMARY KEY,
  last_reviewed_message_id INTEGER NOT NULL DEFAULT 0, -- watermark, advanced by the route (consume-on-take)
  last_reviewed_at         INTEGER,
  last_proactive_post_at   INTEGER                      -- null = never; the ≤1/day budget reads this
);
```

Separate from `reflection_state` — reflection consumes nightly on its own watermark; the review consumes every 10 min on this one. A message is independently seen by both (reviewed for speaking, reflected into memory). The watermark column is written by the route's `takeReviewBatch`; the budget column is written by `proactive_reply` — different columns, targeted upserts so neither clobbers the other.

## Deliberate simplifications (first-principles cuts from the original spec)

- ❌ **Self-rescheduling cadence** (busy→tighten / quiet→loosen / after-hours→pause) — **dropped.** The Tier-1 gate is ~one SQL query, so waking every 10 min on a dead channel is nearly free. Adaptive cadence optimized a cost that doesn't exist. A fixed work-hours cron + cheap gate is sufficient; revisit only if the fixed cadence proves wrong.
- ❌ **DM venue** — deferred (see Venue).
- ❌ **Flag-a-contradiction trigger** — dropped by the user.

## What's new vs reused

**New:**
- `review_state` table (watermark + budget).
- `src/review.ts` — `projectsToReview` (gate), `takeReviewBatch` (activity since watermark, ambient included, advance), `buildReviewInstructions` (the procedure constant).
- `/__internal/review-sweep` route (token-guarded, mirrors `reflect-sweep`).
- `proactive_reply` tool (post + budget + shadow).
- A work-hours review cadence in the ticker.

**Reused (lean on existing infra):**
- `reflect-sweep`'s entire shape — take-batch + watermark + dispatch-inline.
- `search_channel` (L3) — the connect-the-dots verification.
- `set_reminder` / `/__internal/scheduled` (existing) — the entire commitment-chase path.
- The `messages` transcript (ambient rows) — the review's activity source.
- project memory, the agent itself, `withToolLogging` (the shadow drafts surface through it).

## Data flow

```
ticker review cron → /__internal/review-sweep
  → for each active project:
      tier-1 gate (review_state: new activity? AND budget free?)
        ├─ fail → skip (no LLM, no watermark advance)
        └─ pass → takeReviewBatch (advance watermark) → dispatch review:<proj> turn
                    → turn decides: silent (normal) | proactive_reply (thread post, consume budget)
                    → may also set_reminder for a noticed commitment
```

## Open decisions (resolve during planning)

1. **Ticker cadence mechanism** — a Cloudflare cron trigger (UTC, so `*/10 1-10 * * 1-5` for 09–18 KL) vs a SchedulerDO TZ-aware schedule. Follow whatever pattern `reflect-sweep`'s trigger already uses.
2. **`REVIEW_BATCH_LIMIT`** — smaller than reflection's 300 (this runs every 10 min); propose 100.
3. **Commitment follow-ups vs the ≤1/day budget** — proposed: not counted (separate reminder path). Confirm.
4. **`REVIEW_MODE` default for the first deploy** — proposed `shadow`; operator flips to `live` after a dry-run day.

## Non-goals (YAGNI)

- DM venue, adaptive cadence, the contradiction trigger (all above).
- More than one proactive post/day.
- Per-user noise budgets or per-user memory.
- A separate "judge" turn — v1 uses one turn with an in-prompt self-critique; split into a judge turn only if the single-turn gate proves too loose.

## Testing approach

- **Tier-1 gate** (`projectsToReview`, FakeD1, like reflection tests): surfaces a project with new activity; **skips** a project with no new messages; **skips** a project that posted in the last 24h (budget).
- **`takeReviewBatch`**: advances the watermark (consume-on-take); **includes ambient rows** (the key difference from reflection's batch); caps at `REVIEW_BATCH_LIMIT`.
- **`proactive_reply`**: records `last_proactive_post_at`; **refuses** when budget spent; **shadow mode** logs and neither posts nor consumes budget; refuses a missing/empty `conversationId`.
- **Restraint (behavioral)** — only verifiable live, exactly like L3. **Shadow mode is the verification vehicle:** deploy with `REVIEW_MODE=shadow`, watch `[review-draft]` lines via `wrangler tail` against real channel activity, confirm it stays silent on low-value activity and drafts something sane on a genuine unanswered question — *before* flipping to `live`.

## Build order

A single plan: migration (`review_state`) → `src/review.ts` (TDD) → `proactive_reply` tool (TDD) → `/__internal/review-sweep` route + ticker cron → review procedure prompt → manual shadow-mode verification → finish. Ships dormant until deploy; goes live only when `REVIEW_MODE=live` is set (so deploy + shadow-watch is the safe gate, not just deploy).
