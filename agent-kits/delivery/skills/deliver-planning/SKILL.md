---
name: deliver-planning
description: Use during the harness's deliver track when a Linear/GitHub issue must become a reviewed executable spec for a Bug, Feature, or Refactor.
---

# Deliver Planning

## Overview

Deliver planning is the step between "a human filed an issue" and "an executor has a contract to build against." Its output is a single `spec.md` per issue, judged by a fresh-context reviewer before oracle assembly begins.

The skill is shared by a generator-evaluator pair:

- **deliver-planner** — drafts the spec. Evidence-first across all types.
- **deliver-spec-reviewer** — skeptical judge. Three checks: well-formedness, groundedness, scope sanity. Binding verdict.

Agents cannot discharge their own work. A deliver-planner that both wrote and approved would drift into a lower-friction standard. That's why the pair is structural.

## When to use

Use this skill when:

- The conductor (or manual operator) has an incoming deliver-track issue and needs a reviewed spec before oracle assembly.
- A prior review returned REJECTED and the deliver-planner is replanning.

Do not use when:

- The issue is still being triaged for type/scope (pre-plan triage is an operator decision).
- The spec has been approved and oracle assembly is now in progress. Different skill territory.

## Type postures

The dispatch names the type. Posture, anti-patterns, and per-type procedure follow.

### Bug — forensic

Every claim grounded in observed output, grep'd code, or cited issue content. Find the root cause — do not stop at the symptom. The spec covers exactly the reported bug; no adjacent fixes.

### Feature — generative

Evidence-first for features means evidence from codebase patterns, not runtime error output. Find the smallest design that solves the stated problem by following existing patterns. Novelty is a cost; fit is a feature. The spec covers the stated problem, not its adjacent imaginable extensions.

For frontend/UI features, include an `Intended Layout` section in the spec. Use a concise ASCII sketch to expose hierarchy, navigation, tab/sidebar placement, empty states, and primary action placement. Keep it schematic, not pixel-perfect. Omit this section for backend-only work.

Frontend/UI specs should also name executable evidence for important user-visible claims. Evidence can be existing E2E/component tests, browser/preview checks, screenshots, screen recordings for interaction-heavy flows, or a documented blocker when no trustworthy automated evidence is feasible. Do not rely on "human review will check it" when the repo already has automatable behavior evidence.

### Refactor — conservational

Preserve observable behavior. Improve structure (coupling, readability, testability, complexity, performance, security) without changing what the code does externally. Tests are the contract — what existing tests cover defines what is preserved; what they don't cover must be filled by regression tests before the refactor lands.

## Status enums (strict)

Each type has one status field in frontmatter. Values are strictly enumerated — no other labels are valid outputs:

- `reproduction-status: confirmed | cannot-reproduce | need-info` (Bug)
- `design-status: drafted | need-info` (Feature)
- `preservation-status: ready | needs-coverage-first | need-info` (Refactor)

Do not invent `ready`, `proposed`, `in-progress`, `draft`, or any other label. If none of the enumerated values fit, use `need-info` and explain what is missing.

**Canonical source for enum validation.** The conductor maintains the full enum table at `.pi/agents/conductor.md` § Enum validation and enforces it mechanically at every frontmatter parse boundary. If this listing and the conductor's table ever disagree, the conductor's table wins. Workers reading this file emit the values listed above; the conductor catches invented values before reaching any reviewer.

## Spec schema

The full spec template, including frontmatter, all universal sections, and type-specific sections, lives at `assets/spec-template.md`. The deliver-planner fills it; the reviewer checks conformance against it.

Universal sections (all types): Outcome, Acceptance Criteria, Scope Fence, Rabbit-Hole Patches, Blast-Radius Manifest, Skeleton Position, Concrete Example. Optional: Failure Modes, Assumptions. Frontend/UI specs also include Intended Layout. `Assumptions` exists to surface product judgment the planner made on its own — auth scope, thresholds, intent calls — so the human gate at Ready→Building can override. Hidden product judgment (made silently in body text instead of called out here) is a scope failure.

Type-specific sections:

- **Bug** — Reproduction Steps, Root Cause
- **Feature** — Design Rationale (with Alternatives, Picked + Reason; conditional subsections based on blast-radius characteristics)
- **Refactor** — Behavior Preservation (What must be preserved, Preservation Proof, Structure Improvement); Design Rationale is optional

## Spec granularity discipline

The spec is the implementation plan. Two disciplines apply to every spec, regardless of type. (Inspiration acknowledged: [obra/superpowers](https://github.com/obra/superpowers) `writing-plans` skill — adapted to the harness's spec artifact.)

### Bite-sized acceptance criteria

Each Acceptance Criterion is one observable outcome a fresh-context executor can attempt in one short step. Not "the user can manage their account" — that is a feature description, not a criterion. Concrete shape:

- **One state change or visible effect per criterion.** A criterion that requires three unrelated state changes is three criteria.
- **Stated in observable terms.** "Submitting an empty form shows `Required` next to Name" — not "validation works." If you cannot describe the criterion as something a reviewer (human or `ui-walker`) can check, it is not yet a criterion.
- **Sized so the executor can verify it independently.** If satisfying one criterion requires implementing two unrelated subsystems first, split the criterion (or escalate the spec to umbrella).

### Per-criterion verification command

Every Acceptance Criterion includes a `Verification: \`<cmd>\`` line citing the smallest command (or `ui-walker` journey name) that proves it. This is the conductor's mechanical hook — pre-spec-review baseline runnability extracts these commands and runs them at the testbed SHA before the reviewer ever sees the spec.

- For backend behavior: a unit/integration test invocation, a `curl` against the test server, or a query against test data.
- For frontend behavior: a `ui-walker` journey name from the oracle's `ui_journeys` block, or an E2E test invocation.
- For Refactor preservation: the executable behavior test cited in `Preservation Proof`.
- If no command can prove the criterion, the criterion is not yet ready — add an Assumption naming the gap or escalate as a blocker.

### Files-touched explicitness

The Blast-Radius Manifest already enumerates files into the four buckets (Expected to create / Expected to change / May change / Must not change). The discipline strengthens to: **every Acceptance Criterion should map to at least one file under "Expected to create" or "Expected to change."** A criterion that does not trace to a file in the manifest either belongs to a different slice or signals an incomplete manifest. Reviewer flag.

These disciplines tighten the spec's contract enough that `deliver-implementer` can apply `test-driven-development` (see `.pi/skills/test-driven-development/`) without ambiguity about what "passing" means.

## Scope classification (before any drafting)

Before deciding whether to write a spec, classify the issue. The question is **not** "does any signal trigger umbrella?" — it is **"can one AI agent ship this in one session?"** Default toward bounded. Decomposition is the rare path, not the standard one.

- **Bounded** — work that one AI agent can plan, implement, validate, and ship as one PR in one session. May span DB + API + UI when the layers form one coherent feature with a shared acceptance boundary. Output: `spec.md`.
- **Umbrella** — work that genuinely cannot fit in one session: too large for one model context, requires shipping + observing one slice before the next can be designed (DB migration with bake time, telemetry-gated rollout), or composed of independent outcomes without a shared acceptance boundary. Output: `decomposition.md`.

### What "fits in one session" means

You are decomposing for an AI agent, not a human team. The executor ships full verticals (DB + API + UI) in one session — there are no skill-stack boundaries between layers and no parallel-work coordination cost between humans. The threshold that matters is **model context window and validation budget**, not surface count.

Weight these signals together. No single one is decisive:

- **Total estimated change size.** Calibrated for AI-agent-led delivery: typical bounded slices land in the **2000–5000 LOC** band (additions across all layers, including tests + UI + infra + docs). Modern context windows easily hold a whole feature plus tests; the constraint is verifier trust and one integration test, not implementer memory. Above ~5000 LOC the coherence ceiling strengthens the umbrella case, but only when the work also cannot be sequenced inside one session. Below ~500 LOC, planning overhead dominates (the harness spec + review + oracle artifacts can be longer than the code itself) — look for a coupled sibling to merge into a bigger bounded slice rather than auto-decomposing. For human-led delivery the ceiling shifts down to ~1500 LOC; this skill is calibrated for agents.
- **Shared acceptance boundary.** One user-visible outcome that confirms the whole change end-to-end ("operator toggles X and sees behavior change") = bounded, even across DB+API+UI. Independent outcomes that confirm separately ("eight feature-dense pages each become a section with sub-tabs") = umbrella.
- **Inter-slice observability dependency.** Slice 2 cannot be safely designed until slice 1 ships and is observed (DB migration bake time, telemetry-gated rollout, schema change that needs production validation before next layer) → real umbrella. "Logically separable but could ship together" → not umbrella.
- **Validation reach.** One validation gate confirms the whole change → bounded. Different gates per slice that don't run together → umbrella.
- **Issue body framing.** Bulk-application phrasing ("rework," "redesign across," "all routes," "across the entire X") is *evidence* of umbrella shape, not a trigger. A small feature described in bulk language is still bounded; a genuinely large refactor described as a single ask is still umbrella.

### Decision procedure

1. Map rough blast-radius (directory-level estimate is enough; full file-level mapping comes later).
2. Estimate total change size in LOC of additions across all touched layers.
3. Answer the question: *"Could one AI agent ship this in one session?"* Name the constraint that would break — context, validation, observability dependency, or none.
4. **Yes / probably yes** → `spec.md`. Multi-layer bounded work is handled via Blast-Radius Manifest (cross-layer file list), Skeleton Position (per-layer pattern fit), and Concrete Example (end-to-end illustration). Do not split for tidiness.
5. **No, with a named constraint** → `decomposition.md`. The artifact's frontmatter must include `decomposition-rationale: <one-sentence citation of the constraint that ruled out single-session delivery>`. The reviewer reads this; so does the operator at breakdown approval.

### Anti-patterns

- **OR-of-signals reflex.** Do not auto-decompose because the issue mentions "all" or because it touches three layers. Multi-layer ≠ multi-session.
- **Decomposing to demonstrate thoroughness.** A feature that fits one PR with a clear plan does not benefit from a 3-slice breakdown that adds N+1 PRs of process for the same delivered work.
- **Ignoring shared acceptance boundary.** Three slices that each implement part of "user toggles X and sees behavior change" is the same one bounded thing, regardless of layer count.
- **Avoiding umbrella when one is real.** When the work genuinely cannot fit (a 13K-LOC redesign across 8 independent sections, each its own validation surface), do not collapse to a heroic single spec. The umbrella path exists for this.

When umbrella shape is chosen, switch artifact type immediately. Do not draft a partial `spec.md` and then convert; the artifacts are mutually exclusive.

## Breakdown outcome

For umbrella issues, the deliver-planner writes `decomposition.md` instead of `spec.md`. The artifact uses `artifact: decomposition`, `conductor-status: ready`, and `type: decomposition` in frontmatter — see `assets/decomposition-template.md`.

After writing `decomposition.md`, the conductor dispatches `deliver-decomposition-reviewer` (not `deliver-spec-reviewer`). The reviewer applies five checks (Groundedness, Slice sizing, Dependency correctness, Surfaced concerns load-bearing, Question discipline) — see `references/decomposition-review-rubric.md`.

### Slice quality — the four checks

When decomposition IS the right shape, each slice must pass these four checks in order. The first failure means re-cut. The planner applies them while authoring; the reviewer re-applies them to catch slips.

1. **Name the function.** Describe what the slice does in one sentence, using a verb a non-engineer would understand. If the sentence mentions a file, a function name, or a layer (backend/frontend/infra), the slice is mis-cut — restart from the capability. A slice is *what is delivered*, not *what code is written*.

   | Slice IS (capability) | Slice is NOT (implementation step) |
   |---|---|
   | "Members can be invited and accept invitations" | "Implement `createInvitation` with duplicate checks" |
   | "Webhook ingestion drops to DLQ after 3 retries" | "Add retry counter column to webhook_events" |
   | "Add a search bar to the chat list" | "Build the SearchInput component" |

2. **End-to-end completeness.** Does the slice deliver the function from the entry point a user/operator touches all the way to the underlying state change? If the slice produces output that no other shipped code consumes, OR consumes input that no other shipped code produces, it is coupled to its missing half — merge them.

3. **One contract, one owner.** If any two slices in the breakdown reference each other's contracts (envelope shape, error code, response field, sequencing requirement, schema column), they are the same slice. Distributed contracts produce integration failures the reviewer guards against — envelope drift, sequencing skew, half-done feature, schema-code skew, test orphaning, doc-code skew. The fix is always the same: merge coupled slices until the contract has one owner.

4. **One integration test exists at the boundary.** Each slice has one test file that exercises its contract end-to-end — a test that would fail if the function stopped working from the user's perspective, not a unit test of an internal function. If you can't name that test file today, the slice is mis-cut.

Stop at the first failure and re-cut.

### When fine slicing IS correct

Fine slicing into many small pieces is right when:

- Slices have genuinely independent contracts (different services, different consumers, different release cadences)
- Each slice produces an observable change someone could verify alone
- Slices ship on different cadences (a dependency upgrade is its own slice, not coupled to the feature using it)

Rule of thumb: fine slicing is for parallel work with clear boundaries; coarse slicing is for one user-visible feature.

Once the breakdown is approved, the conductor updates the already-created issue branch, opens or updates the `[Breakdown]` draft PR, and parks the parent issue at `Breakdown Proposed`. The operator reviews the PR and either moves the parent to `Breakdown Approved` or runs `create-issues <id>` to create child issues in Linear and start dependency-free slices. The full lifecycle lives in the conductor's § Create-issues phase.

Discipline:

- **One umbrella per plan run.** If the issue is an umbrella, write the decomposition. Do not also write a `spec.md` for the umbrella; do not pre-write specs for the slices.
- **Slices are not yet specs.** Each slice description in `decomposition.md` is a one-sentence scope, not a full spec. Per-slice planning happens after `create-issues <id>` creates the Linear child issues; dependency-free children may be moved straight to `Run Agent`.
- **Recursive decomposition is forbidden.** A child issue that turns out to also be an umbrella triggers a decomposition of its own (next run). Do not multi-level decompose in one artifact.
- **Slice-ids are stable.** Each slice carries a `slice-id` field used by create-issues for idempotent retry. Once assigned, a slice-id does not change across replaning.
- **Questions are typed.** Only ask questions that change execution. Use `blocking` only when no safe child issue creation exists without an answer; those must be answered before approval. Use `defaulted` when the harness can proceed with a stated default. Use `slice-local` when the question belongs in a child issue.
- **Scope-determining questions never ship in a decomposition.** A `blocking` question whose answer would reshape *which slices exist* (not just slice contents) cannot appear in a shippable artifact, even when the agent self-fills the answer. Resolve it from codebase evidence before drafting, or halt planning with the existing `need-info` outcome surfacing only that question and replan after the operator answers. The decomposition-review rubric (Check 5) REJECTs such artifacts even when every slice is internally coherent.

## Groundedness criteria

A spec is ungrounded if any claim lacks traceable evidence. These are the criteria the reviewer uses on Check 2:

### Universal

- Acceptance Criteria verifications are runnable commands (specific test names, specific curl calls) — not "run the relevant tests."
- Blast-Radius → `Expected to change` is grep-verifiable as touched by the reported problem (imports, callers, or direct surface).
- Never-touch list names specific files or clear glob patterns — not vague domains.
- **Every file listed under "Expected to create" must actually not exist.** Co-located test files (e.g., `inbox.test.ts` next to `inbox.ts`) almost always already exist. Existing files labeled "new" is ungrounded about repo state. This is a file-existence check the deliver-planner runs during blast-radius mapping and the reviewer re-verifies.

### Bug

- `Reproduction Steps` quotes actual command + actual output, not a hypothetical. If `reproduction-status: confirmed`, there must be real command output.
- `Root Cause` cites a specific `file:line`. The line content must match the quoted snippet.
- If `reproduction-status` is `cannot-reproduce` or `need-info`, Reproduction Steps explains what is missing. A populated Root Cause despite unproven reproduction is ungrounded.

### Feature

- **Alternatives** cite real `file:line` patterns that exist and roughly match the claimed pattern.
- **Alternatives are not strawman** — each option has a plausible cost estimate + fit analysis. An option rejected with "not how we do things here" without a cited counter-example is ungrounded.
- **Picked + Reason** references concrete codebase evidence, not generic principles. "Simpler" is not a reason; "fits the pattern at `orders.ts:47`" is.

### Refactor

- **Existing tests list** — each listed test file exists and imports or calls the refactor target. Files that exist but do not exercise the target are ungrounded.
- **Existing behavior tests are obligations.** If Behavior Preservation cites an existing behavior test, the spec's Verification must include a runnable command that exercises it. Cited behavior tests are not optional human-review advice.
- **Observable invariants** in "What must be preserved" reference real behaviors — endpoint names, table names, event types that exist in the codebase.
- **Structure Improvement → Before** cites the real current structure. Named files/functions/classes exist as described.
- **Coverage gaps** are specific behaviors + specific regression tests to add (file + test name), not "add tests as needed."
- If `preservation-status: needs-coverage-first`, Coverage gaps names specific tests; the spec is approvable only if those tests are specific enough to execute against.
- `typecheck`, lint, route generation, and grep are supporting checks. They are not enough to prove behavior preservation when automatable behavior tests exist.

## Scope sanity principles

### Universal (any one is a scope failure)

- Always-touch list includes files unrelated to the reported symptom/request (widening).
- Never-touch list is vague rather than specific.
- Rabbit-Hole Patches punt decisions the deliver-planner should have made ("TBD — reviewer decides").
- Acceptance Criteria include targets beyond the issue ("while we're here, also fix X").

### Bug

- Skeleton Position claims first-slice when the testbed clearly has existing patterns to follow.

### Feature

- **Picked alternative must be the simplest reasonable.** Over-engineering (generic abstraction for a single use case, novel machinery when existing patterns exist) is a scope failure.
- **Substantially simpler alternative check.** If a simpler pattern exists in the codebase and Design Rationale did not consider it, the spec has failed scope sanity.
- **Multi-slice features acknowledge their shape.** A multi-slice feature pretending to be single-slice is a scope failure.

### Refactor

- **No observable behavior changes.** API responses, DB shapes, emitted events, or any externally observable behavior must not drift. Any AC or Structure Improvement description implying behavior change is a scope failure. This is the load-bearing check for Refactor — the most common way refactor specs fail.
- **No optionalizing behavior evidence.** A refactor cannot be `preservation-status: ready` if behavior preservation is delegated to human review while repo-native executable tests/checks exist.
- **Improvement target is concrete and measurable**, not vague. "Reduce coupling" alone fails; "Extract auth logic into `src/auth/` (currently in `routes/*.ts`)" passes.
- **No while-we're-here additions.** Scope matches the stated structural change; scope creep into behavior improvements or adjacent refactors is a failure.
- **Coverage-gap plan is specific.** Named test files + test names + behaviors they cover.

## Anti-patterns

### Universal

Other planning systems produce specs that look complete until the executor discovers they are half-specified or pointed at the wrong problem. The deliver-planner does not ship such a spec. The reviewer does not approve one.

### Bug

No spec without observed reproduction. No "Root Cause" as speculation — find the `file:line`. No scope widening beyond the bug. No stub fix disguised as a root-cause fix. No spec marked ready while any acceptance criterion lacks a runnable check.

### Feature

No spec without a cited existing pattern — or, if truly new territory, an explicit "no existing pattern" decision in Design Rationale. No strawman alternatives. No machinery for imagined future requirements — deferred options live in the Deferred subsection. No pretending a multi-slice feature is single-slice. No novel abstractions when existing patterns solve the problem.

### Refactor

No spec that changes observable behavior, even in "harmless" ways. No partial refactor — either it completes or does not start. No while-we're-here feature additions. No vague improvement targets. No commitment to a refactor before coverage exists for what must be preserved — if gaps exist, the spec commits to specific regression tests BEFORE the structural change.

## Evidence discipline

- Reproduction is a tool call that returns output, not a hypothesis.
- Design is grounded in the codebase, not in general principles.
- Coverage is grep-inventoried from tests that actually exist.
- File-existence is verified with an available file-listing tool (`find` for reviewers), not assumed.
- The spec specifies WHAT must change and WHERE, never HOW.

## Hard rules

- The deliver-planner writes exactly one file: the injected spec path. No source code, tests, migrations, or config changes.
- The deliver-spec-reviewer writes exactly one file: its verdict at the injected review path. Read-only otherwise.
- No destructive commands.
- Reviewer verdicts are strictly binary: `APPROVED` or `REJECTED`. Blocking → REJECTED with specific objections. Non-blocking → APPROVED with observations in a `notes:` field. No intermediate labels.
- Reviewer default is REJECT; approval requires positive evidence on every check.
