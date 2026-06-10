# Breakdown Review Rubric

Use this rubric when `deliver-decomposition-reviewer` judges the breakdown artifact in `decomposition.md`.

## Required inputs

- `.pi/skills/reviewing/SKILL.md`
- `.pi/skills/deliver-planning/SKILL.md`
- `.pi/skills/deliver-planning/assets/decomposition-template.md`
- injected `decomposition.md`
- injected issue body/comments (the umbrella issue)
- injected testbed root

## Checks

### Check 1 — Groundedness

Is every slice grounded in observed code, cited paths, and verifiable evidence?

The reviewer verifies, not re-derives. Verification is **exhaustive, not sampled** — every `file:line` citation in the artifact must be opened with `Read` and confirmed against the cited claim. Spot-checking is the failure mode this rubric exists to catch.

**Mandatory citation checklist.** Before writing the verdict body, enumerate every cited `file:line` reference in `decomposition.md` (slice Scope, slice Evidence, slice Dependencies, surfaced concerns, decomposition-rationale, Cuts considered). For each one, open the file at the cited range with `Read` and emit a checklist line:

```
- <where in artifact> → `<file:line-range>` — verified ✓ (<what was read matches: e.g. "file is 556 lines, matches">)
- <where in artifact> → `<file:line-range>` — mismatch: <actual state — e.g. "file is 342 lines, decomposition says ~225 LOC; relevant test block is at lines 130-225, not the whole file">
- <where in artifact> → `<file:line-range>` — missing: file does not exist at testbed SHA
```

This checklist is a load-bearing output section of the review (see output format below). A verdict without the checklist — or with a checklist that has fewer entries than the artifact has citations — is invalid; the conductor treats it as malformed and routes to replan. Uniform "verified ✓" entries with no concrete content in the parenthetical are also invalid — the parenthetical must show what was actually read.

**Reading discipline:** read the cited range, not just the file. A claim "FRD-161a evidence: `gl.tsx:1050-1057`" requires `Read(gl.tsx, offset=1050, limit=8)` and confirming the read content matches the claimed pattern (`InspectorTab` usage at that range). Reading only the file's first 50 lines and saying "verified ✓" is the failure mode.

**Verdict rules:**

- Any unverifiable claim, hallucinated file path, or surfaced concern that can't be grepped to confirmation is `FAIL`.
- Speculative slices with no `file:line` evidence ("we'll probably need to refactor the auth layer") are `FAIL`.
- For surfaced concerns about related issue state ("Linear says FRD-162 is Done but PageShell doesn't exist on main"), grep the testbed for the claimed primitive. Confirm the state-lie reproduces. A surfaced concern that doesn't reproduce is `FAIL`.
- Citation imprecision (line range off by a few LOC, file count approximate) where the underlying claim still holds may PASS but must be called out in `## Notes (non-blocking observations)` with the corrected anchor — the slice-planner will re-anchor on next planning.

### Check 2 — Slice sizing & cut justification

Is the decomposition's cut honestly justified, and is each slice a bounded change a competent implementer can ship in one PR?

**Cut justification (umbrella level):**

- `decomposition-rationale` frontmatter field must exist and name a specific constraint (context window, validation budget, observability dependency, independent acceptance boundaries). Generic "this is a big feature" rationale is `FAIL`.
- **Cuts considered** section must exist with two distinct cuts named and one picked. A decomposition with only one cut shown — or two cuts where one is an obvious strawman — is `FAIL` (this is the artifact-as-rationalization smell the rubric exists to catch). The picked cut's "Reason" must cite a specific constraint that breaks the alternative; "simpler" or "fits better" without specifics is `FAIL`.
- **Shippability test on picked cut** must be present and honest. For each slice, the artifact states whether shipping it alone (and the others never shipping) leaves the product better, same, or worse. A slice that leaves the product worse than today is wrongly cut → `FAIL` (the slice boundary breaks the user-visible contract).
- Per-slice `Alternative considered:` line must exist for every slice. Either name a real alternative cut and why this one won, or state `none` with a one-line reason the boundary is forced. Blank or boilerplate ("none considered") is `FAIL`.

**Slice sizing:**

- Wildly oversized slices ("migrate every route at once," "rewrite the auth subsystem") are `FAIL`. The threshold is judgment, not a number — but a slice that touches 10+ files across unrelated modules is a smell.
- Wildly undersized slices ("rename a single function" as its own slice when it's part of a larger structural change) are `FAIL`. The threshold is whether it deserves its own ticket lifecycle, not its own commit.
- A decomposition that produces 1 slice is suspect — either the issue wasn't actually an umbrella, or the decomposition didn't decompose. Either way `FAIL`.
- A decomposition with > ~12 slices is suspect — that's epic-scale, not bounded-change-scale. Consider whether the umbrella itself is too big to scope as one Linear parent. Note as a `notes:` observation, not necessarily `FAIL`.

### Check 3 — Dependency correctness

Does the DAG reflect real dependencies in the codebase?

- If Slice C uses primitives written in Slice B, the DAG must show C depends on B. False independence (claiming slices can run in parallel when they share primitives) is `FAIL`.
- The DAG must be acyclic. A cycle is `FAIL`.
- Independent slices must actually be independent — grep for shared imports, shared state mutations, shared route surfaces. If two "independent" slices touch the same file, they're not independent — `FAIL`.
- Foundational slices (design system primitives, shell, infra) should appear at the top of the DAG with downstream slices depending on them. A decomposition that puts feature work before its dependencies is `FAIL`.

### Check 4 — Surfaced concerns load-bearing

Are surfaced concerns things the operator needs to decide before slices dispatch?

Load-bearing concerns:

- **State lies** — Linear says X is Done but the artifact doesn't exist on the base branch
- **Missing primitives** — slice depends on a component/utility/type that doesn't yet exist
- **Exclusions with rationale** — files or routes deliberately omitted from the decomposition, with reason
- **Cross-slice ambiguity** — operator must decide an interpretation before any slice can be specced

Non-load-bearing (FAIL when present):

- Generic technical debt callouts ("we should also clean up X someday")
- Telemetry wishlists ("we could add metrics here")
- Future-proofing musings ("when we eventually move to microservices...")
- Anything that doesn't change a slice's content or order

Surfaced concerns that are load-bearing but ungrounded fail Check 1, not Check 4. Surfaced concerns that are out-of-scope speculation fail Check 4.

### Check 5 — Question discipline

Do operator questions reduce execution uncertainty without blocking materialization unnecessarily?

- Every question in `Operator questions` must have `type: blocking | defaulted | slice-local`.
- `blocking` questions must be answered before approval. An APPROVED decomposition with unresolved blocking questions is invalid.
- **Scope-determining blocking questions cannot ship.** If a `blocking` question's answer would change *which slices exist* (not just slice contents) — for example, "is this an IA-only redesign or also a visual refresh?" where the second answer would require a different umbrella with different slices — REJECT, even if the answer field is filled in by the agent. Scope-determining questions must be resolved *before* the decomposition is drafted: either resolve from codebase evidence and record the resolution, or halt planning with the existing `need-info` outcome surfacing only that question and replan after the operator answers. A decomposition contingent on an unresolved umbrella-shape question is invalid even when every slice is internally coherent.
- `defaulted` questions must include a concrete default and explain its effect on slices, dependencies, or child issue contents. If no safe default exists, the question is blocking.
- `slice-local` questions must name the child slice(s) that should inherit the question. A question that changes parent slice boundaries is not slice-local.
- Broad preference questions that do not change execution are `FAIL`; move them to `Notes`.
- The handoff language must match the question state. Do not say "block create-issues" when all remaining questions are defaulted or slice-local.

### Check 6 — Placeholder & identifier consistency

Is the artifact finished prose, and do the slices agree on every shared name?

- **Placeholder scan (mechanical):** grep the artifact for `TODO`, `TBD`, `FIXME`, `???`, `<placeholder`, `[fill`, `to be determined`. Any hit in a slice Scope, Evidence, Dependencies, or question field is `FAIL` — an unfinished plan cannot be approved. Hits in `Notes`-style prose may pass with a note.
- **Cross-slice identifier consistency:** enumerate every function, component, type, route, table, or file name that appears in two or more slices. Each shared identifier must be spelled identically everywhere (slice A creating `clearLayers()` while slice B calls `clearFullLayers()` is the failure this check exists for — the drift only surfaces at slice-implementation time, as a wrong-name build break or a duplicate implementation). Any drifted identifier is `FAIL`, citing both spellings and their slice locations.
- A consumer slice naming a contract its producer slice never defines (and that doesn't exist in the codebase at the testbed SHA) is the same defect — `FAIL`.

## Output format

```markdown
---
issue: <id>
review-of: decomposition.md
artifact-reviewed: decomposition.md
reviewed-at: <ISO timestamp>
reviewer-sha: <testbed SHA>
verdict: APPROVED | REJECTED
failed-checks: [<Groundedness | Slice sizing | Dependency correctness | Surfaced concerns | Question discipline | Placeholder & identifier consistency; empty array when APPROVED>]
blocking-objection: null | "<highest-priority objection>"
---

# Plan Review NN — <ISO date>

## VERDICT: APPROVED | REJECTED

## Citation verification checklist

<exhaustive list of every cited file:line in the artifact, one line each, with verified/mismatch/missing status and a parenthetical naming what was actually read. Missing this section, or having fewer entries than the artifact has citations, makes the verdict invalid — see Check 1.>

- <where in artifact> → `<file:line-range>` — verified ✓ (<concrete content readback>)
- ...

## Check 1 — Groundedness: PASS | FAIL
<one paragraph summarizing what the citation checklist shows; specific objections about hallucinated paths, missing files, or state-lies that don't reproduce go here>

## Check 2 — Slice sizing & cut justification: PASS | FAIL
<one paragraph covering both halves: (1) is the cut honestly justified — `decomposition-rationale` cites a real constraint, `Cuts considered` shows two non-strawman cuts with a named-constraint reason for the pick, shippability test is honest for each slice, every slice has a real `Alternative considered:` line; and (2) is each slice's sizing reasonable>

## Check 3 — Dependency correctness: PASS | FAIL
<one paragraph, naming dependency edges that disagree with the codebase>

## Check 4 — Surfaced concerns load-bearing: PASS | FAIL
<one paragraph, naming any non-load-bearing concerns>

## Check 5 — Question discipline: PASS | FAIL
<one paragraph, confirming no unresolved blocking questions remain and that defaulted/slice-local questions are correctly typed>

## Check 6 — Placeholder & identifier consistency: PASS | FAIL
<one paragraph: placeholder scan result, and the list of shared identifiers checked across slices with any drifted spellings cited>

## Notes (non-blocking observations)
(none)

## Specific objections (only if REJECTED)
- <exact slice or section and what must change>

## What the deliver-planner must do next (only if REJECTED)
- <specific replan instruction>
```

The conductor parses only the frontmatter fields for routing. The markdown body explains the verdict for humans.
