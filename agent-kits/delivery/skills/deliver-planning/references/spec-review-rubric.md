# Spec Review Rubric

Use this rubric when `deliver-spec-reviewer` judges `spec.md`.

## Required inputs

- `.pi/skills/reviewing/SKILL.md`
- `.pi/skills/deliver-planning/SKILL.md`
- `.pi/skills/deliver-planning/assets/spec-template.md`
- injected `spec.md`
- injected issue body/comments
- injected testbed root

## Checks

### Check 1 - Well-formedness

Does the spec conform to `assets/spec-template.md`?

Verify all required frontmatter keys are present, including the type-specific status field. All seven universal sections must be populated with non-placeholder content. Blast-Radius must use four buckets. Outcome must be one line around 15 words. Type-specific sections required by `SKILL.md` Spec schema must be present and populated.

For Feature, check conditional subsections required by blast-radius shape: migrations in blast-radius -> Migration Plan; db/schema changes -> Schema Diff; queue/worker files created -> Failure Modes; existing API routes changed -> Backward Compatibility; runtime risk -> Constraints.

For Refactor, check all three Behavior Preservation subsections: What must be preserved, Preservation Proof, Structure Improvement.

A missing or placeholder required field is `FAIL`. (Invented status values are not your check — the conductor catches enum violations mechanically before you are dispatched. See `conductor.md` § Enum validation.)

### Check 2 - Groundedness

Is every claim grounded in observed output, cited code, or cited issue content?

Apply `SKILL.md` Groundedness criteria, universal plus the matching type section. Verification is **exhaustive, not sampled** — every `file:line` citation must be opened with `Read` and confirmed. Spot-checking is the failure mode this rubric exists to catch.

**Mandatory citation checklist.** Before writing the verdict body, enumerate every cited `file:line` reference in `spec.md` (Root Cause, Alternatives, Existing tests, Structure Improvement -> Before, Blast-Radius -> Expected to create / Expected to change, Concrete Example, Acceptance Criteria runnable commands). For each, open the file at the cited range with `Read` and emit a checklist line in the output's `## Citation verification checklist` section:

```
- <where in spec> → `<file:line-range>` — verified ✓ (<concrete readback of content>)
- <where in spec> → `<file:line-range>` — mismatch: <actual state>
- <where in spec> → `<file:line-range>` — missing: file does not exist at testbed SHA
- <Blast-Radius "Expected to create" entry> → glob check — does not exist ✓ / exists (mark FAIL)
```

A verdict without the checklist — or with fewer entries than the spec has citations — is invalid; the conductor treats it as malformed and routes to replan. Uniform "verified ✓" entries with no parenthetical readback are also invalid.

**Reading discipline:** read the cited range, not just the file. A claim "Root Cause: `orders.ts:47`" requires `Read(orders.ts, offset=47, limit=N)` and confirming the quoted snippet matches.

**Specific check rules:**

- For every file in Blast-Radius -> Expected to create, use `find` to confirm it does not already exist. Existing file labeled as new is `FAIL`.
- For Feature Alternatives, confirm each cited `file:line` exists and roughly matches the claimed pattern. Strawman rejections with no cited counter-example are `FAIL`.
- For Refactor executable behavior evidence, confirm each listed test/evidence file exists and imports, calls, or exercises the refactor target. If a refactor cites existing behavior tests but omits a runnable command that exercises them, `FAIL`.

Any unverifiable claim, mismatched citation, or hallucinated invariant is `FAIL`. Minor citation imprecision (line off by a few LOC) where the underlying claim still holds may PASS but goes in `## Notes (non-blocking observations)` with the corrected anchor.

**Pass A — External library citations (mandatory when `External Library Claims` section is present).** For every entry in the spec's `External Library Claims` section, verify the cited source actually grounds the claim:

- **Docs URL:** open with `fetch_content` (or read the cached docs in `node_modules/<package>/README.md` / `docs/` when offline). The cited URL must be a primary source (the library's own docs, RFC, or specification — not a Stack Overflow answer or a blog post). The fetched content must literally describe the behavior the spec claims; paraphrases that don't match the source FAIL.
- **`file:line` in vendored source / node_modules:** open with `Read` at the cited range. The code must literally implement what the claim says.
- **Executable probe command:** record the command and the spec's claimed expected output. (Running it is not your job — that's the conductor's baseline-runnability check below. Your job is to verify the command + expected output are well-formed and probe what the claim states.)

A claim with no `Source:` field is `FAIL`. A claim citing a non-primary source (Stack Overflow, Medium, GitHub Discussions outside the library's own repo) is `FAIL`. A claim whose source does not literally match the claim is `FAIL`.

**Pass B — Baseline runnability (mandatory).** The conductor has run every runnable command the spec cites and written results to the injected `baseline-runnability.txt` path. Walk the file. For each entry:

- **Refactor specs (`type: Refactor`):** any command cited under `Preservation Proof → Executable behavior evidence` that shows `FAIL` at baseline is the documented `REF-001` Groundedness blind spot — `FAIL` on Check 2 unless the spec explicitly lists this command under `Coverage gaps (require regression tests BEFORE refactor lands)` instead of as covering evidence. A spec cannot claim a test "covers" an invariant when the test does not pass at baseline.
- **Bug specs (`type: Bug`):** the AC verification command should typically `FAIL` at baseline in a way that matches the reported symptom. If baseline is unexpectedly green, that contradicts `reproduction-status: confirmed`; `FAIL` on Check 2.
- **Feature specs (`type: Feature`):** AC verification commands typically `FAIL` at baseline (the feature doesn't exist yet — `oracle-red-expected` shape). Unexpected baseline green is non-blocking but warrants a `Notes` entry asking whether the AC is too weak to discriminate.
- **`NOT_RUN` entries:** if the conductor flagged a command as destructive or timed out, surface it in `Notes` with the recovery instruction (sandbox / split / rewrite). Not blocking on its own.

Specs that cite no runnable commands (rare; only certain doc-only or pure-typing-change refactors) skip Pass B with an explicit note.

### Check 3 - Scope sanity

Does the spec's scope match what was asked, without widening, deferring, or over-engineering?

Apply `SKILL.md` Scope sanity principles, universal plus the matching type section. Load-bearing checks:

- Feature: grep for simpler existing patterns that could solve the stated problem. If one exists and Design Rationale did not consider it, `FAIL`.
- Feature: if the spec is single-slice but the issue has multi-slice indicators, `FAIL`.
- Refactor: any hint of observable behavior drift is `FAIL`.
- Refactor: coverage-gap plan must name specific test files, test names, and behaviors.
- Refactor: typecheck, lint, route generation, and grep are supporting checks. They cannot be the only preservation proof when automatable behavior tests exist.
- Refactor: behavior preservation delegated to human review while executable repo-native tests/checks exist is `FAIL`.
- Authorization boundaries surfaced: if the design plausibly requires an ask-first action (new runtime dependency, DB schema migration, auth/permission change, new external service call, destructive data operation) and the spec has neither an `Authorization Boundaries` entry nor an `Assumptions` line covering it, `FAIL` — the unattended build would either cross the boundary silently or stall without a pre-declared park trigger.
- Hidden product judgment is a scope failure. If the body shows the planner made a product call that a human might reasonably override (e.g. picked one of multiple plausible interpretations of user intent, decided who should have access, set a cap or threshold) and that call is not surfaced in `Assumptions`, `FAIL`. An empty `Assumptions` section on a Feature touching auth, money, customer data, or external egress is suspicious and warrants a closer read.

## Output format

```markdown
---
issue: <id>
review-of: spec.md
artifact-reviewed: spec.md
reviewed-at: <ISO timestamp>
reviewer-sha: <testbed SHA>
verdict: APPROVED | REJECTED
failed-checks: [<Well-formedness | Groundedness | Scope sanity; empty array when APPROVED>]
blocking-objection: null | "<highest-priority objection>"
---

# Spec Review NN - <ISO date>

## VERDICT: APPROVED | REJECTED

## Citation verification checklist

<exhaustive list of every cited file:line in spec.md, one line each, with verified/mismatch/missing status and a parenthetical naming what was actually read. Missing this section, or having fewer entries than the spec has citations, makes the verdict invalid — see Check 2.>

- <where in spec> → `<file:line-range>` — verified ✓ (<concrete content readback>)
- ...

## Check 1 - Well-formedness: PASS | FAIL
<one paragraph, citing specific sections or fields>

## Check 2 - Groundedness: PASS | FAIL
<one paragraph, citing specific claims and whether they verify. Then two named sub-passes:>

### Pass A — External library citations
<for each `External Library Claims` entry, name the source kind (URL / file:line / probe) and the verification result; or "(no External Library Claims section — skipped)">

### Pass B — Baseline runnability
<walk `baseline-runnability.txt` entries; call out any cited "covering" command (Refactor) that failed at baseline, or any AC command whose baseline result contradicts the spec's stated status (Bug confirmed but AC green; or Feature/Refactor with surprise outcomes). Quote the command + exit code. Specs that cite no runnable commands skip this pass with an explicit note.>

## Check 3 - Scope sanity: PASS | FAIL
<one paragraph>

## Notes (non-blocking observations)
(none)

## Specific objections (only if REJECTED)
- <exact field/line and what must change>

## What the deliver-planner must do next (only if REJECTED)
- <specific replan instruction>
```

The conductor parses only the frontmatter fields for routing. The markdown body explains the verdict for humans.
