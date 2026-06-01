# Slack Teammate: Proactive Memory & Awareness — Design

**Date:** 2026-06-01
**Status:** Draft for review

## Problem

When the agent is @mentioned in a Slack thread it wakes **context-poor**: it sees only the single mention message + sparse curated project memory. It does not see the thread it's replying in (ironically, `botInThread` already fetches the thread via `conversations.replies` and *discards* it), other threads, or any channel context. It also only acts when explicitly addressed.

We want it to behave like a **teammate**: aware of what's been discussed where, and able to speak up usefully on its own ("there's another thread about this", "this is important — let me say it in the channel").

## Reframe: memory is the substrate, not the feature

"Teammate" decomposes into four capabilities; memory is only the first:

| Capability | Behavior | Today |
|---|---|---|
| **Recall** | remembers durable facts/decisions/commitments | ✅ curated project memory (flat, 2k cap) |
| **Connect** | "this relates to the #pricing thread Tuesday" | ❌ transcript is dead storage (nightly reflection only) |
| **Initiate** | speaks up unprompted when it adds value | ❌ only wakes on @mention / 6h heartbeat |
| **Venue + volume** | thread vs channel vs DM; how often | ❌ only replies where addressed |

The two motivating examples are **Connect** and **Initiate**, not storage.

## Behaviors to cultivate (the teammate's values)

- **Earn the turn** — default silent; speak only when value ≫ noise.
- **Connect, don't just answer** — surface "this links to X", but only when certain; never fabricate a cross-reference.
- **Right venue, right volume** — thread by default; DM for a one-person nudge; root channel rarely and deliberately; hard rate-limit on unprompted posts.
- **Close loops** — track its own commitments and follow up.
- **Attribute honestly** — know who said what.

## Architecture: four layers, built in dependency order

```
1. Context hydration   feed thread backscroll (+ memory) into every turn   ← fixes reactive TODAY
2. Ambient ingestion   log ALL channel messages (no reply, no LLM)         ← enables awareness
3. Cross-thread index  retrieval over the transcript → "Connect"           ← example #1
4. Proactive review    contentless heartbeat, restraint-gated speaking     ← example #2
```

Each layer is independently valuable and the prerequisite for the next. Layer 1 improves every answer whether or not Layer 4 is ever built.

### Layer 1 — Context hydration

On each turn, assemble the room around the message instead of dispatching the bare mention:

- **Thread backscroll** — keep the `conversations.replies` result `botInThread` already fetches; pass it into the dispatch input so the model sees the thread it's in.
- **Project memory** — already injected.
- **Adjacent threads** — retrieved from the index (Layer 3); absent until then.

Cheapest, highest-value piece. No new storage.

### Layer 2 — Ambient ingestion

Stop dropping non-@mention channel messages in `app.ts`; log them to the existing `messages` table (cheap D1 write, **no LLM turn**). This is what lets the index and the review see the whole channel, not just threads the bot was pulled into. Ingesting ≠ responding — the agent stays silent; it's only building awareness.

### Layer 3 — Cross-thread index + Connect

A retrieval index over the transcript so the agent can answer "what else has been discussed about X" and cite real threads.

- **Decision (implementation):** start with **D1 full-text search** (cheap, no new infra); add **embeddings (Vectorize / Workers AI)** later if keyword recall proves too blunt. Recommendation: FTS first.
- Powers Connect on @mention (reactive) and feeds the review turn (Layer 4).
- Confidence gate: cite a thread only above a similarity threshold; otherwise stay silent rather than guess.

### Layer 4 — Proactive review (a heartbeat, not a cron task)

**Cron is the timer; heartbeat is the behavior.** The review is a *contentless* wake — look around, default to going back to sleep — scheduled by a per-project cron the agent can retune.

```
TIMER (cron, per-project, agent-tunable)   →  WHEN it wakes  (work hours, activity-adaptive)
HEARTBEAT (check → skip by default)        →  WHETHER it acts
```

Two-tier skip (both are "wake and skip", at different cost):

```
cron fires (per-project, work-hours)
   ├─ tier 1 (NO LLM):  new messages since last-review watermark?  ──no──► sleep
   │                    (reuses the reflect-sweep cheap-SQL-gate pattern)
   │           yes
   ├─ tier 2 (LLM):     read new activity + memory + index
   │                    └─ worth speaking on?  ──no──► sleep        (the usual outcome)
   │                             yes
   └─ speak  →  venue (thread / DM / channel)  within a noise budget
```

**Speak triggers (tier 2):** an unanswered question it can help with; a connectable dot to another thread; a contradiction with a known decision; a due commitment. **Restraint mechanism:** the review turn drafts a candidate, then self-critiques *"would a good teammate actually interrupt for this?"* → post or discard.

**Self-rescheduling cadence** (the agent owns its timer via existing `set_reminder` / `pause_reminder`):

```
review fires
   ├─ busy since last run  → tighten cron (e.g. */5)
   ├─ quiet                → loosen (e.g. */30)
   └─ after hours/weekend  → pause_reminder; set a resume for next work morning
```

Working hours is the default cron (`*/10 9-18 * * 1-5`); activity is the live adjustment.

## What's reused vs new

**Reused (lean into existing infra):**
- SchedulerDO + `reminderTools` — per-project timing, self-scheduling, pause/resume, TZ-cron.
- `reflect-sweep`'s cheap-SQL-gate pattern — the tier-1 activity gate.
- `messages` transcript table — the ambient log substrate.
- project memory — the curated-fact (Recall) layer.
- `botInThread`'s `conversations.replies` fetch — stop discarding it (Layer 1).
- skills/personality system — houses the review's restraint/venue procedure.

**New:**
- Context-assembly step feeding backscroll + retrieved threads into the turn.
- Ambient ingestion (log all channel messages).
- Retrieval index (FTS → embeddings).
- The review heartbeat behavior: salience triggers, self-critique gate, venue policy, noise budget.
- Per-project review scheduling (distinct from the global 6h `/__heartbeat`).

## Data flow

```
Slack message
  ├─ @mention / participating  → dispatch turn  →  [hydrate: backscroll + memory + index]  → reply
  └─ everything else           → log to messages (ambient)                                  → (silent)

SchedulerDO cron (per-project, work-hours)
  → /__internal review wake → tier-1 SQL gate → (skip | tier-2 review turn → skip | speak)
```

## Open decisions (resolve during implementation)

1. **Index mechanism** — D1 FTS first vs embeddings. Recommend FTS first.
2. **Per-user vs channel memory** — memory is channel-scoped today (initializer is author-blind). Per-user private memory is deferred; the `memories` schema already reserves `scope='user'`.
3. **Timezone** — `set_reminder` cron is hardcoded KL (UTC+8). Fine single-workspace; per-project `tz` on the binding is the forward-hedge for workspace #2.
4. **Noise budget numbers** — max unprompted posts/day, cooldowns, channel-escalation confidence threshold — tune empirically.

## Non-goals (YAGNI)

- Per-message real-time reactivity (rejected: expensive, twitchy, hard to rate-limit — the periodic heartbeat is more teammate-like).
- Embeddings/Vectorize before FTS proves insufficient.
- Per-user private memory in this pass.
- Multi-timezone working hours before workspace #2.

## Testing approach

- **Layer 1:** unit-test the hydration assembly (backscroll present in dispatch input); manual @mention in a thread with prior messages → answer reflects them.
- **Layer 2:** ingestion logs non-mention messages to `messages`; no dispatch/LLM fired (assert no turn).
- **Layer 3:** retrieval returns the right thread for a topic query; confidence gate suppresses weak matches.
- **Layer 4:** tier-1 gate skips dead channels with no LLM call (assert); restraint gate stays silent on low-salience activity; self-reschedule writes the expected cron; pause/resume across work-hours boundary.

## Build order

Phase 1 = Layer 1 (context hydration) — foundation, ships value alone. Phases 2–4 follow in order. This spec covers the full vision; the first implementation plan targets **Layer 1 only**.
