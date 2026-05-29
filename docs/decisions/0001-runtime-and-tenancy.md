# ADR 0001 — Runtime & Tenancy Substrate: Cloudflare Durable Objects + Flue

**Date**: 2026-05-29
**Status**: accepted
**Supersedes**: nothing
**Related**: `docs/planning/channel-project-agent-foundation.md`
**Research basis**: Second Brain vault — *Agent Multi-Tenancy*, *Agent Isolation vs Context*, *Stateful Agent Deployment Spectrum*, *Agent Runtimes & Sandboxes — Flue, Trigger.dev, Daytona, CF DO*, *Virtual Workspace Pattern*, *Webhook Doorbell Durability*

## Context

We need to choose where a project-scoped agent's runtime lives, and how tenants are
isolated, before writing code. The choice was pressure-tested against the alternative of
adopting an existing harness (Hermes profiles) rather than building on Cloudflare.

Two facts about *this* project frame the decision:

- **Deliverable = "both": a usable tool that is also the vehicle for learning the
  multi-tenant agent stack.** Learning is co-equal with utility. This licenses building
  the multi-tenant *spine* now, which pure near-term utility (N=1–5) would not justify —
  because single→multi-tenant is otherwise a cheap migration.
- **Trust model = small trusted team / collaborators (semi-trusted).** Not the open
  public, not untrusted code execution. This decides that sandboxes are **not** the
  security boundary.

## The decision is really two decisions

The original plan bundled two independent choices. We separate them:

1. **Runtime placement** — always-on VM (Hermes / Flue-local) vs sleep-and-wake (Flue → CF
   Workers + Durable Objects).
2. **Foundation depth** — thin concrete loop vs control-plane / provider-abstraction layer.

## Considered options (runtime placement)

| Option | Tenancy model | Idle cost | Wake | Verdict |
|---|---|---|---|---|
| **A. Hermes profiles, always-on** | Level 3 (process-per-tenant) — free | flat (~$4–8/mo) | n/a | Best for *personal*; can't hibernate per-tenant → RAM ceiling at scale |
| **B. Flue-local, always-on, thin loop** | per-process | flat (~$4–8/mo) | n/a | Good if goal were pure near-term utility |
| **C. Flue → CF DO** (chosen) | DO-per-tenant actor — isolated SQLite | $0 hibernated | ~5ms | Right for the multi-tenant target |

## Decision

**Build on Cloudflare Durable Objects with Flue as the harness (Option C).**

### Why C, given the goal

- The target regime is genuinely multi-tenant, where the vault's own conclusion holds:
  *"per-tenant hibernation becomes the only affordable model."* Hermes profiles give
  Level-3 isolation but are **always-on** — N processes sharing one host's RAM, which
  ceilings out. Per-tenant hibernation dissolves that ceiling; Hermes cannot do it.
- CF DO **is** the rung the vault repeatedly flagged as *missing*:
  *"is there a 'Level-3-with-hibernation' rung between flat-cost VM and pay-per-use
  sandbox?"* — ~5ms wake, $0 idle, isolated SQLite per DO, fan-out to millions. We are
  building the answer to our own documented research gap.
- The vault's decision tree routes here directly: *"Many tenants, isolation matters, cost
  matters → per-user hibernated actors"* and *"JS-native, sub-second wake, millions of
  cheap entities → Durable Objects."*
- Flue compiles down to the CF Agents SDK / DO runtime and keeps the sandbox **pluggable**
  (virtual → cf-sandbox → Daytona), which serves the coding-work axis without lock-in.

### Foundation depth: thin, not a platform

Even with the learning license, learning licenses the **spine**, not everything:

- **Bindings** live in DO storage or a typed config file — **not** a control-plane service.
- **`CanonicalMessage`** stays a *type* (cheap, documents the seam) but Slack is built
  **concretely** — no provider-adapter *framework* for providers we don't have.
- Still excluded: billing, admin UI, Hermes adapter, full sandbox lifecycle manager.

## The two axes that must not be conflated

The vault separates these deliberately; "build multi-tenancy through sandboxes" merges them:

- **Tenancy** = *where the agent loop lives* → **DO-per-tenant actor** with its own SQLite.
  This is the tenancy primitive and CF's core strength.
- **Code execution** = *where heavy/coding work runs* → **sandbox** (Level 4, the heaviest,
  last rung). Serves the coding differentiator, **not** tenant isolation.

Because tenants are semi-trusted (no untrusted code), sandboxes are **not** the security
boundary — confirming they belong on the code-execution axis, deferred behind `sandboxMode`.

## Build order (= the vault's failure-mode ranking)

The dominant multi-tenant failure mode is **context bleed, not filesystem escape**
(*Agent Isolation vs Context*: "isolation lives in the prompt and the tool wrapper; the
process boundary is the last layer"). Build in this order:

1. **DO-per-tenant actor** — `project:<id>` → one DO, its own SQLite. Tenancy primitive.
2. **Context partition (Layer 1) — do NOT defer.** With DO-per-tenant the partition is
   nearly free: each DO's SQLite *is* the boundary. **Rule: per-tenant memory lives in the
   tenant's own DO; never wire a shared memory backend across DOs** — that re-opens the
   dominant bleed. Verify this, don't assume it.
3. **Credential isolation** — semi-trusted makes this matter sooner. Secrets referenced per
   DO via `botTokenRef`; never in prompts or sandbox files.
4. **Tool guards** — guarded reply (refuse wrong-channel posts) + target allow-lists.
5. **Sandbox = deferred.** Start `virtual`; `sandboxMode` enum is the seam; attach
   `cf-sandbox`/Daytona only when a specific project's code work outgrows virtual.

## Consequences

**Positive**
- Substrate matches the target regime; per-tenant hibernation is native.
- Context partition is nearly free and correct from day one.
- Sandbox tiering is a per-project swap, not a rewrite.

**Negative / accepted costs**
- Sleep-and-wake pulls in real complexity — **signature verification + idempotency /
  durable doorbell** (Slack Events API → Worker → DO is the hibernation-native path;
  Socket Mode's persistent connection would fight $0-idle). These are **the necessary tax
  of the hibernation rung**, not over-engineering. See *Webhook Doorbell Durability*.
- Cold-start compounding remains a watch-item for chatty tenants (*Cold Start Compounds
  for Agents*), though DO's ~5ms wake is the best available answer.

## Guardrail (because the goal is "both", not pure learning)

Prove the loop end-to-end before polishing any layer: bind one channel → mention the bot →
reply lands in-thread → context continues across the thread → an unbound channel stays
silent. This milestone keeps the learning license from drifting into infinite infra and
lets the actual moat surface through use.

## Signals that earn back a deferred piece

- Provider #2 **and** copy-pasting the Slack adapter → promote `CanonicalMessage` to a real
  provider-neutral shape.
- Editing bindings more than ~weekly, or a collaborator needs to → build the control plane.
- A project's code work outgrows the virtual sandbox → attach a real sandbox provider.
- A tenant crosses from trusted into untrusted code execution → sandboxes become the
  security boundary (re-open this ADR).
