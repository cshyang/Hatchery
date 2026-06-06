# RCA — Agent silent ("On it" then no reply) since the flue 0.9.1 deploy

> **Status:** ROOT CAUSE FOUND (high confidence). The agent has been **fully down for every
> dispatched Slack turn since the flue 0.9.1 deploy at 2026-06-03 13:56 UTC.** This is a *different*
> failure than the parked durable-turn-dispatch plan addresses, and it **invalidates that plan's
> premise** that 0.9.1 Phase 0 was "DONE + clean." It was clean at build time; it was never
> verified with a live turn after deploy.

## Symptom
User sends a message → bot posts the deterministic working-ack `👀 On it…` → **no reply, ever.**
Confirmed in prod D1 `messages`: the two most recent rows (thread `…633849`, 15:26 + 15:27 UTC)
are both `role:user` with **no following `role:agent` row**. Even a bare "Hello" dies.

## Evidence (not inference)

**1. The LLM turn never executes.** Live `wrangler tail` (observability on, head-sampling 1) during a
reproduction "Hello" at 15:58 UTC captured every invocation:

| event | what | wall | logs |
|---|---|---|---|
| `POST /slack/events` | Slack webhook → worker | 1913ms | 0 |
| `POST /__flue/internal/dispatch` | Flue dispatch reaches the DO | **50ms** | 0 |
| DO `rpcMethod: setName` | agent **init only** | 20ms | 0 |
| DO `scheduledTime` alarm | fired | 27ms | **0** |

- `dispatch` returns in **50ms** → it did NOT run the model (a real turn = multi-second provider call).
- Zero `[tool→]`/`[tool✗]` logs anywhere, though `observability.ts` wraps *every* tool's `execute()`.
- No multi-second DO invocation, no outbound provider fetch, `outcome:ok`, `exceptions:0` everywhere.
- The +30s alarm never produced a turn (tail stayed alive past it).

→ The DO **accepts** the dispatch (setName + 200) but the dispatched turn is **enqueued and never
drained into an LLM run.** The reply is missing because the *turn* is missing.

**2. It is NOT the three hypotheses we (and the parked plan) reached for:**
- Not eviction-by-deploy: last deploy was 14:46 UTC, **40 min before** the 15:27 failure. DO was stable.
- Not "model ended in plain text without calling reply" (`observability.ts:22` mode): no provider call
  happened — no multi-second DO invocation, zero tool logs.
- Not "reply_to_conversation threw": that tool was never reached.

**2b. Same dataset, the OTHER failure mode, cleanly separated by deploy-proximity.** The 11:07 UTC drop
(D1 id160, "Can I connect via PAT instead?" → no reply, re-asked + answered at 12:21) sits **between
deploys at 11:05:15 and 11:10:58 UTC** — that one genuinely *was* eviction, exactly as the parked plan
describes. So the plan was right about 11:07 and blind to 15:26. Two distinct failures; deploy-proximity
is the discriminator: 11:07 had a deploy mid-turn, 15:26 did not.

**3. Regression bracket = the 0.9.1 deploy.** (commits are `+0800`, deploys UTC)
```
12:21 UTC  last GOOD agent reply (D1 id162)          ← running flue 0.8.1
12:39 UTC  deploy  (32483d4 slack-setup, still 0.8.1)
13:51 UTC  commit 85ae99c  package.json 0.8.1 → 0.9.1
13:56 UTC  deploy  ← carries flue 0.9.1                ← THE BREAK
14:46 UTC  deploy  (7c15e14 Pi contract)
15:26/15:27 UTC  user msgs → NO reply (first traffic after the 0.9.1 deploy)
```
First turn attempted after the 0.9.1 deploy failed; last turn before it succeeded. The broken
mechanism (Flue dispatch-queue → DO durable scheduling) is exactly what 0.9 changed.

## Likely mechanism (two candidates — not yet pinned)
Flue dispatch errors are **swallowed into fiber state, not printed** (per the flue-cloudflare-agents
skill). So "0 logs / outcome:ok / fast invocation" is consistent with EITHER:
- **(a) Turn never drains.** Flue 0.9 enqueues to a `dispatchQueue` drained inside the DO via the
  agents-SDK durable `queue()`/`schedule()` (cf_agents_* SQLite). 0.9 "stops owning DO migrations
  implicitly"; this migration redeclared `Project`/`FlueRegistry` with fresh `new_sqlite_classes`
  tags. If the drain/alarm runs no turn, enqueued turns are silently dropped.
- **(b) Turn drains but the agent errors instantly, swallowed.** e.g. the `createAgent` initializer in
  `.flue/agents/project.ts` throws on 0.9.1 (a D1/binding/SDK API shape change) before any model call
  → fast invocation, no logs, no reply, error buried in the fiber.

Pin it by reading the **fiber state** (`flue_sessions`, `listFibers({name:'flue:dispatch'})`,
`inspectFiberByKey` — errors live here) via a temp SSE pass-through route, which also reveals whether
the failure is in the dispatch *queue* (Slack uses `dispatch()`) vs the *turn itself* (the SSE route
runs the turn directly, bypassing the queue).

## Fix — split the branch FIRST (the branches have opposite fixes)
Don't pick a fix until we know whether it's the 0.9.1 **code path** or the **prod DO-migration state**:

- **Discriminator (cheap, local, no prod risk): `flue dev` repro.** Miniflare = fresh DO state, so it
  isolates code from prod migration state. Add the temp SSE route, POST `{"message":"hi"}`, watch the
  event stream / fiber.
  - Turn **fails to start locally too** → 0.9.1 *code* bug, prod-independent → rollback OR forward-fix
    both restore service; pick by effort.
  - Turn **starts locally** (even if the model egress flakes — that's a known flue-dev quirk, ignore
    it) → prod **DO state** is wedged → a code rollback alone will NOT fix it; the DO needs repair/
    recreation. (Asymmetry: "fails locally" is strong proof; "works locally" is suggestive.)
  - To nail causality instead of bracketing a 3-deploy window: repro on `32483d4` (pre-bump, 0.8.1)
    vs `85ae99c` (the bump, 0.9.1) → deterministic "this commit."

- **Then fix:**
  - **A — Roll back to 0.8.1 (fastest restore IF it's the code branch).** 0.9.1 buys nothing
    functional now: the only reason to be on it (the `extend` durable-turn API) is **unreleased**
    (>0.9.1). RISK: the `new_sqlite_classes` retag may not cleanly reverse — verify DO migration state.
  - **B — Forward-fix on 0.9.1.** Pin the drain (or initializer throw) and add the missing kick/config.

> **PROD-MUTATING. Do not roll back, redeploy, or touch the DO migration without the user's explicit
> call** — it's hard to reverse and outward-facing.

Either way: **add a live post-deploy turn smoke-test to gated CD** so "build clean" never again gets
mistaken for "turns work." The parked plan verified tsc/test/build/dry-run — none exercise a real
dispatched turn.

## Correction to the parked plan (`2026-06-03-durable-turn-dispatch.md`)
That plan's recommendation — "park, wait for the Flue `extend` release, gated CD neutralizes the
trigger" — is aimed at the *eviction* failure. The current outage is not eviction; the agent does not
reply to **anything**, with no deploy in flight. Waiting for a future Flue release does not fix it.
