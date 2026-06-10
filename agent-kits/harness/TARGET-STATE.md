# Delivery system — target-state architecture

Where the Hatchery delivery system is going (not a minimal V1 — the destination, with an
ordered build path toward it). Produced by a design swarm grounded in the real stack;
decisions below are owned calls, not options.

## Thesis

A **strong conductor wielding a worker swarm over a git-as-truth durability spine, with
model strength allocated per task — tiers (including the conductor's own) are
operator-tunable in `defaults.yaml`; spend where judgment is load-bearing, save where work
is mechanical.** A Trigger.dev task is a thin durable *host*: per iteration it clones the
issue branch, reads the handoff cursor (or derives state from which artifacts exist), boots
exactly one conductor (as the pi **parent**, the only agent holding the `subagent` tool),
and on exit just exits — a later re-dispatch continues if parked or crashed. The conductor
is a general swarm orchestrator whose single decision procedure (the top-of-turn goal-state
diff) **converges**, for a coding task, on the proven gated pipeline
(plan → spec-review → [oracle-write → oracle-review] → implement → [ui-walk] →
verify → draft PR). The pipeline is the swarm's coding **attractor**, expressed as serial
gated `subagent` calls — never a pi `chain` — so a conductor turn sits between every stage
and the generator-evaluator boundary never collapses. The same swarm substrate (parallel
`tasks`+worktrees, dynamic expand/collect, runtime agent creation) stays available for
novel work, paid for only off-template.

## Architecture

```
 HUMAN ──comment/approve/veto──▶ LINEAR ◀──questions/state──────────────┐
                                   │ (webhook)                          │
                                   ▼                                     │
           ┌────────────────────────────────────────────────────┐        │
           │  HATCHERY CONTROL PLANE                            │  needs_attention
           │  • Linear webhook→dispatch                         │  callback      │
           │  • state-aware comment routing                     │                │
           │  • re-dispatch on reply / stuck-issue re-run       │                │
           │    (trivial cron or manual)                        │                │
           │  • per-issue concurrency key                       │                │
           └───────────────────┬────────────────────────────────┘                │
                dispatch (initial │ continuation, feedback)                       │
                                 ▼                                                │
 ┌───────────────────────────────────────────────────────────────────────────────┴┐
 │ TRIGGER HOST (run-coding-task.ts — durable, ephemeral)                          │
 │  clone branch ▶ readHandoff (git show) ▶ boot conductor                         │
 │     ▶ on exit: parked or terminal → just exit (re-dispatch continues)            │
 │        provisions git creds + OPENROUTER + GH                                   │
 └───────────────────────────────┬─────────────────────────────────────────────────┘
          pi --system-prompt conductor.md --model <conductor: tier from defaults.yaml>
                                  ▼
        ┌──────────────────────────────────────────────────────────┐
        │ CONDUCTOR (model per `conductor:` tier) — pi PARENT       │
        │  sole subagent holder; goal-state diff → ONE decision      │
        │   ├ coding task → ATTRACTOR: gated pipeline (default)     │
        │   └ novel task  → bespoke lineup (action:create)          │
        │  drains STEERING INBOX at each top-of-turn checkpoint      │
        └───────┬──────────────────────────────────────────────────┘
       serial gated subagent({agent, context:"fresh", model:tier})
       — conductor turn (parse+enum-validate+rehash) BETWEEN every stage —
   ┌────────────┴──────────── PIPELINE = CONVERGENCE ───────────────────────┐
   │ plan→spec-review→[oracle-write→oracle-review]→impl→[ui-walk]→verify│
   └────────────────────────────────────────────────────────────────────────┘
                 │ parallel tasks+worktree:true (independent slices / multi-lens)
                 ▼ WORKER TIERS (per job-class, price-agnostic; OpenRouter)
        gate=deepseek-v4-pro  default=kimi-k2.6  mechanical=mimo-v2.5  ← baseline defaults
                 │  workers commit NOTHING — conductor owns ALL git + PR
 ═══════════════ STATE SPINE (sole durability boundary) ═══════════════════════
   branch  harness/<id>  (deterministic, issue-scoped, reused on rerun)
     .harness/issues/<id>/{issue, spec|decomposition, reviews/, oracle/,
        implementation/, verification/, steering-inbox/, handoff.json}
     commit a step's artifact when it completes + update the cursor
        → fresh process rebuilds from git (artifacts ARE the state; cursor is a hint)
```

## Architectural decisions (owned calls)

1. **Conductor = pi parent**, invoked `--system-prompt conductor.md` with `--model` drawn
   from the `conductor:` tier in `defaults.yaml`, runner-overridable per dispatch.
   (Resolves the deferred "parent vs nestable subagent" — it's the parent.)
2. **Pipeline backbone = `gated_dispatch` calls, one per GATE.** *(Upgraded 2026-06-10.)*
   The generator→review→replan loop is code-enforced by the kit's own pi extension
   (`extensions/gated-dispatch.ts`): fresh generator child per cycle, objections injected,
   verdict parsed from the review artifact, one typed outcome back to the conductor. The
   gate is now a mechanism, not prompt discipline — a conductor turn sits between *gates*
   (route, enum-walk, checkpoint), not between every leg. A pi `chain` still flows
   `{previous}→next` with no gate → **chain remains forbidden as the backbone**; allowed
   only for *ungated* micro-loops inside one stage.
3. **Git is the SOLE durability boundary.** pi runs `--no-session`; every resume is cold
   and rebuilds from the **committed artifacts** on the branch (a thin handoff cursor is a
   hint, not truth — see Durability below). A re-dispatch on human reply, a re-dispatch on
   crash, and a manual rerun are the same operation.
4. **Deterministic issue-scoped branch** `harness/<id>` (computable from the issue id
   alone). Today's `hatchery/<slug>-<randomUUID8>` is run-scoped and recoverable only via
   the DB row (`continuation.ts:38`) — a single point of failure for git-as-truth. Replace it.
5. **One branch; the execution ledger (`.harness/issues/<id>/`) lands in the PR diff.**
   autoship-proven, KISS. *Named tradeoff, flagged for product review (see Risks): for a
   multi-tenant runner, shipping our ledger into a customer's PR diff is customer-facing
   noise — revisit whether it belongs on a separate ref or is stripped pre-PR.*
6. **Conductor owns ALL git + PR; workers commit nothing; the runner stops doing git on
   the delivery path.** The conductor *must* checkpoint mid-process, which the runner
   structurally can't. Gate on `d.kit` so `coding-default` keeps runner-drives-git.
7. **One continuation path: handoff cursor + re-dispatch — NOT a waitpoint+reaper apparatus.**
   *(Simplification, 2026-06-09.)* Resume, HITL-reply, crash-recovery, and manual retry are
   the SAME operation: re-dispatch the issue → clone the deterministic branch → read the
   handoff cursor (or derive state from which artifacts exist) → continue. Park = the
   conductor ends the run, writing `needs_attention` + the question into the handoff; the
   human reply re-dispatches. No Trigger waitpoint suspend, no reaper subsystem, no token
   machinery. Cost: a cold re-dispatch per round — which git-as-truth already made cold and
   which human latency dwarfs. A trivial "re-run stuck issues" trigger (cron or manual)
   covers crash-recovery; it's a *trigger*, not state.
8. **Per-issue concurrency key is the one prerequisite that survives** (Trigger config):
   never two dispatches for one issue at once. External-mutation dedup is branch-keyed
   (PR head = branch, already idempotent) plus a `last_comment_id` field — not a state-machine.
9. **Two steering tiers over one human surface:** Tier-1 GATE (blocking park/resume:
   `plan_approval|spec_approval|path_veto|ambiguity_halt|needs_input`) mapped onto the
   conductor's existing reviewer-verdict machinery — *a human gate is a reviewer whose
   verdict comes from a person*. Tier-2 NUDGE (non-blocking) drained from a durable,
   append-only **steering inbox** on the branch at each top-of-turn checkpoint.
10. **One orchestrator, no mode-branch.** The pipeline is what the goal-state diff *emits*
    for a coding task; novel tasks produce a different lineup from the same machinery via
    `subagent({action:"create"})`. Common (coding) case carries zero composition overhead.

## Swarm ⇄ pipeline coexistence — pi mechanism map

| Need | pi mechanism | Why |
|---|---|---|
| Pipeline backbone (default) | `gated_dispatch({generator, reviewers, artifacts, max_cycles})` — kit extension | gen→review→replan loop code-enforced; conductor turn between gates |
| Independent slices of a decomposition | parallel `tasks` + `worktree:true` | per-worktree isolation; same gate per slice |
| Multi-lens review of one artifact | multiple `reviewers` entries on one gate; ANY reject → replan | strengthens gate, keeps gen-eval |
| decomposition → implementation | dynamic expand/collect on the reviewer's `outputSchema`, `maxItems`-bound | pi-native "build the breakdown" |
| ungated micro-loop in one stage | `chain` mode (the *only* legit chain use) | no conductor gate between sub-steps |
| novel non-coding task | `subagent({action:"create", config})` | composes a bespoke lineup; coding never touches it |
| child→conductor escalation | pi-intercom `contact_supervisor` → handoff `needs_attention` | bridges to a HITL park |

Topology is a **structural** hub-and-spoke star: only `conductor.md` lists `subagent`;
pi-subagents blocks any child from fanning out, `maxSubagentDepth` caps nesting. Every
recovery funnels through the one gatekeeper.

## Durability — a handoff cursor over git-as-truth

**The committed artifacts ARE the state; the handoff file is just a cursor.** On the issue
branch, `.harness/issues/<id>/` holds the real work (`spec.md`, `reviews/`, `oracle/`,
`implementation/`, the diff). State is **derivable from which artifacts exist** — the
handoff is a hint that saves a re-derivation, not the source of truth. A stale or missing
handoff is recoverable by reading the tree; a half-committed step just re-runs (git only
ever holds completed commits). So **no atomic-commit protocol, no state machine** — commit
a step's artifact when it's done, update the cursor, continue.

The handoff cursor (md or jsonl — conductor writes at end, reads at start):

```jsonc
{ "next": "spec-review",          // where to pick up (or derive from the tree)
  "done": ["spec"],               // completed steps
  "parked_question": "<verbatim, if waiting on a human>",
  "pr_url": "", "last_comment_id": "" }   // external ids for cheap dedup
```
That's the whole record. Everything the earlier rich manifest carried (a `step_status`
machine, per-step hashes, `pending_mutation`, `resume_attempts`, `gate_request`) was
hardening around this cursor — **add a field back only when an observed failure demands it**
(a real double-comment → add comment-dedup; never seen → don't). The kernel is: branch +
artifacts-as-truth + thin cursor + re-dispatch.

## Already built vs gaps

**Built/proven:** the whole kit (conductor + 11 workers + skills + `defaults.yaml`), ported
and de-branded; asymmetric star enforced in frontmatter; OpenRouter wired (CLI + RPC);
dispatch rewritten to the `subagent` tool; **`gated_dispatch` extension built + live-load
verified** (registers in a real pi run; helper logic unit-tested);
model/effort tiering + dispatch-modes/topology;
Trigger host scaffold (clone/branch/kit-install/machine-sizing/outcome-trust gate);
`openOrUpdatePullRequest` idempotent on head branch; autoship as a complete reference for
handoff-cursor read-back + re-dispatch + `buildHumanReplyBlock`.

**Wired (Step 2, 2026-06-10):** delivery path in `run-coding-task.ts` gated on `d.kit ===
'delivery'` — deterministic `harness/<id>` branch (+ resume-from-remote when the branch
already exists from a crashed run), kit install (agents/skills/extensions → `.pi/`,
defaults → `.harness/`, ledger committable / scratch excluded), conductor-as-parent boot
(`--system-prompt` from frontmatter-stripped conductor.md, model from the `conductor:`
tier), Runner Handoff envelope + parked-question re-injection on continuation,
outcome-trust gate (clean-worktree check — the Step-1 finding, now code — plus cursor
read for park routing), runner-owned push + draft PR, both kits bundled into deploys.

**Gaps (remaining):** control plane must dispatch `kit: 'delivery'` · per-issue
concurrency key on the trigger call (control-plane side) · `parked` status in
`RunnerCallbackSchema` (v1 routes parks via `completed` + `needs_attention:` summary
prefix) · control-plane Linear-webhook→re-dispatch + state-aware comment routing · full
git-ownership flip incl. push/PR (v1 hybrid: conductor commits, runner pushes+PRs —
keeps the token out of the agent env) · `.pi/settings.json`
(`disableBuiltins`/`oracle.disabled`) · steering inbox · bespoke-composition entry
path · ui-walker browser tooling (browser MCP in the image).

## Build path (ordered — each step real and de-risking)

1. **Retire the existential unknown first — gate capability.** Boot conductor-as-parent on
   the **delivery** kit (conductor model from the `conductor:` tier, workers per tier), one
   issue end-to-end, happy path, **no HITL / no resume / no fan-out**, gated on `d.kit`.
   *Answers the one question everything else rests on: can the baseline tier map hold the
   generator-evaluator gates? If a gate underperforms, the fix is remapping that tier
   upward — allocation is per-task, not dogma; it does not invalidate the architecture.
   Learn it before building durability machinery.* Run this locally with the pi CLI against
   a test repo first — no Trigger deploy needed to answer the gate-capability question;
   wire the runner after.
2. **Git-ownership flip + deterministic branch.** Conductor owns git+PR; creds at setup;
   issue-scoped branch name. *Precondition for every later resume.* The runner's
   outcome-trust gate MUST verify a clean worktree at every per-issue terminal
   (`git status --porcelain` empty, branch tip ahead of base when code changed) —
   Step-1 evidence: a live run reported `verification-passed` with the fix sitting
   uncommitted in the worktree. Commit discipline is mechanical; enforce it in code,
   not prompt.
3. **Handoff cursor + re-dispatch — resume, crash-recovery, and HITL in ONE mechanism.**
   Conductor writes/reads the cursor (state otherwise derived from the tree); per-issue
   concurrency key; the control plane re-dispatches on a Linear reply (HITL) and a trivial
   cron re-runs stuck issues (crash). Kill a run mid-pipeline; confirm a re-dispatch resumes
   the right step. *Resume + HITL + crash recovery together — no waitpoint / reaper /
   state-machine.*
4. **Parallel fan-out for independent slices.** expand/collect from decomposition;
   `tasks`+`worktree:true`; same gate per slice.
5. **Bespoke composition + steering inbox (tier-2).** `action:create` novel-task path +
   on-branch steering inbox + state-aware comment routing.
6. **ui-walker browser tooling.** Browser MCP in the image; wire `ui_journeys` into verify.

## Risks / open product calls

- **Baseline tier-map gate capability is unvalidated — the existential unknown.** Step 1
  exists to retire it. If a gate underperforms, remap that tier upward — allocation is
  per-task; the architecture is not invalidated.
- **Ledger-in-PR (decision 5)** — for a multi-tenant runner this is customer-facing; consciously decide separate-ref vs strip-pre-PR vs accept. (My lean: revisit before Step 2.)
- Two git-ownership models in one runner file → double-commit if `d.kit` gating isn't clean; test both paths.
- `OPENROUTER_API_KEY` missing = every run fails (hard prereq, now whole-runner).
- Untrusted repo/Linear content → OpenRouter (SSRF/exfil), widened by `action:create`.
- Cold-resume reboots the conductor model each iteration — real token cost (not a reliability concern; human latency dwarfs it).
