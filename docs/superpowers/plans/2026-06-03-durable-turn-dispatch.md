# Durable Turn Dispatch — Scoping Plan

> **Status (settled 2026-06-03):** Phase 0 (upgrade to 0.9.1) DONE + clean. The proper fix is **one Flue
> release away** and there is **no honest cheap interim fix** — so the recommendation is **park the custom
> durability build, wait for the release carrying `fe92e6d`, then do Phase 2.** The incident's *trigger*
> (back-to-back mid-turn deploys) is already neutralized by gated CD. History of how we got here is below.

**Goal:** A Slack turn must not silently vanish when the agent DO is evicted (redeploy) or the turn errors — it should durably persist and recover, instead of leaving the user in silence.

**Origin:** RCA of the 2026-06-03 dropped turn (11:07 question, "👀 On it…" then no reply for 74 min). Root cause: two back-to-back CD deploys evicted the in-flight turn; Flue `dispatch()` is fire-and-forget so the evicted turn was swallowed with no recovery.

**Tech stack:** Flue (`@flue/runtime`), Cloudflare Workers + Durable Objects, the `agents` SDK (durable `queue()`/`schedule()` backed by `cf_agents_*` SQLite tables), D1, KV.

---

## The decisive finding (the kill-test)

`extend({ base, wrap })` — the mechanism for the real fix — **is real, closes #187, but is NOT released yet.**

```
0.9.1 published   2026-06-02 05:57 UTC   ← latest npm release, what we run
#194 merged       2026-06-03 02:47 UTC   ← ~21h LATER (commit fe92e6d), unreleased
```

- PR #194 (`feat(cloudflare): add authored deployment and agent extensions`) adds `import { extend } from '@flue/runtime/cloudflare'`, letting authored code subclass the generated Agents-SDK Durable Object beneath Flue-owned routing (and `wrap` the final class, e.g. Sentry). Example in the PR uses `onStart` + `scheduleEvery` + `setState` inside the subclass.
- It merged ~21h **after** 0.9.1 was cut. The installed 0.9.1 `dist/cloudflare/` has no agent-extension file and exports no `extend` (verified). No published version > 0.9.1 exists; the `next` dist-tag is a stale beta.
- **So:** the proper fix is gated on the next Flue release, not on us building anything custom.

**Nuance — `extend` unblocks the fix, it is not the fix.** Once released, we still build the durable turn *inside* the DO subclass using the agents-SDK primitives, and the eviction spike (below) still has to run to choose between them.

---

## Why there's no honest cheap interim fix

The original Phase 1 ("make the KV dedup claim recoverable so Slack's redelivery re-dispatches") **does not address the incident**, because the engaged path **always returns 200** (`app.ts:547`) before the turn runs:

```
claim eventId (app.ts:494, 3h TTL)
queueWorkingAck → "👀 On it…"  (waitUntil, fires AFTER the ack)
dispatchSlackTurnWithFallback   (fire-and-forget; catches only a *synchronous* dispatch throw)
return 200                       (app.ts:547, unconditional)
   … turn dies here on eviction → user saw "On it…", then silence
```

Because we 200 within Slack's 3s window, **Slack considers the event delivered and never redelivers.** Releasing/expiring the claim therefore has nothing to act on — the recovery channel the plan assumed (Slack redelivery) doesn't exist for this path. Holding the ack until completion is impossible (3s budget vs. a fire-and-forget turn). Claim-hardening only fixes a crash in the ~tens-of-ms between claim and 200, which is already mostly protected — ceremony, not a fix.

**Conclusion:** without `extend` (unreleased) there is no DO-context hook to make the turn durable, and the gateway-side reframe (below) is throwaway once `extend` lands. So the disciplined move is to wait.

---

## Reframe considered and ABANDONED

> Gateway durable inbox: persist each event to a D1 `pending_turns` row before dispatch; agent reply tool marks `eventId → slack ts` done; the existing ticker re-drives un-acked turns into the same session.

Rejected: (a) it's **throwaway** — we'd rip it out when `extend` ships one release away (anti-salvage); (b) its crux is unsolved — reliably detecting turn *completion* still wants the DO-boundary hook Flue doesn't expose, so "done" tied to the reply-post reintroduces a post-then-crash double-post gap. Don't build it.

---

## Phase 0 — Upgrade + de-risk · DONE 2026-06-03

- [x] Upgrade `@flue/runtime` + `@flue/sdk` + `@flue/cli` 0.8.1 → 0.9.1; committed `85ae99c`. **Clean:** `tsc --noEmit` exit 0, `npm test` all green, `flue build --target cloudflare` complete, `wrangler deploy --dry-run` bindings intact. #144 sandbox breaking change did NOT bite (`sandboxMode` dormant, as predicted).
- [x] Kill-test (what #194 actually shipped, and in which version) — **answered above:** `extend` is real + unreleased.

---

## Phase 1 — NOT SHIPPING (placebo for the incident)

The recoverable-claim idea is a no-op for the eviction case (see "Why there's no honest cheap interim fix"). Only optional defense-in-depth remains, and it does **not** fix the incident:

- *(optional, low value)* claim-after-ack ordering / release-on-synchronous-dispatch-failure, to close the tiny crash-before-200 window. Flag clearly as "does not fix the eviction incident." Recommendation: **skip** unless we want belt-and-suspenders.

---

## Phase 2 — Durable turn via official `extend` · BLOCKED on the next Flue release

When `@flue/runtime` publishes a version > 0.9.1 containing `fe92e6d`:

- [ ] Bump `@flue/runtime` + `@flue/cli` + `@flue/sdk`; re-run the Phase 0 gate (tsc/test/build/dry-run); confirm `extend` is exported from `@flue/runtime/cloudflare` and reachable from the agent-local `cloudflare` descriptor (per PR #194: `export const cloudflare = extend({ base, wrap })` colocated with `createAgent`).
- [ ] **Eviction spike (still required):** in the DO subclass, enqueue a turn via both `queue()` and `schedule(0,…)`, force a worker reload mid-task, observe which recovers. Pick the primitive from evidence. (Prior reading: `schedule(0,…)` re-drains via `alarm()` on every restart → proactive recovery; `queue()` only flushes on the next `queue()` call → needs an `onStart` drain-kick. `agents` SDK: `queue` at `dist/index.js:1434`, `alarm` at `:3091`.)
- [ ] Author the bite-sized TDD tasks **after** the spike: durable turn-ingest in the subclass; idempotency key = `eventId` so recovery can't double-run; reply-post idempotency (a recovered turn must not double-post — prefer a guarded re-post over silence); telemetry on `queue:error`/`schedule:error` so a dying turn stops being invisible.

---

## Phase 3 — Verify the original failure can't recur

- [ ] Reproduce the RCA: dispatch a turn, redeploy the worker mid-turn, confirm the turn recovers and the reply lands (vs. today's silence).
- [ ] Confirm no double-reply on the happy path and on a recovered turn.

---

## Watch-condition / next action

- **Watch:** `npm view @flue/runtime versions` for a release > 0.9.1 that contains commit `fe92e6d` (the #194 `extend` API). No `/schedule` poll set — there's no published ETA.
- **Until then:** rely on gated CD (live) to avoid mid-conversation deploys. That already neutralizes the incident's trigger.
