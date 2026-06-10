---
name: reviewing
description: Use when an the harness reviewer agent is dispatched to judge an artifact, plan, assessment, spec, oracle, or implementation at a generator-evaluator boundary.
---

# Reviewing

## Overview

Reviewing is the shared discipline for the harness evaluator agents. A reviewer judges an artifact it did not author, using a domain rubric, and returns a binary verdict with evidence-backed objections.

This skill owns the universal evaluator behavior. Domain skills own the rubric.

## When to use

Use this skill when:

- You are a reviewer agent judging another agent's artifact.
- The conductor needs a judgment gate before spending compute, changing code, creating issues, or opening a PR.
- The task asks for `APPROVED` / `REJECTED`, `PASS` / `FAIL`, or a reviewer verdict.

Do not use this skill when:

- You are authoring the artifact being judged.
- The gate is purely mechanical and can be checked by a command or parser.
- The task is exploratory analysis with no binding verdict.

## Reviewer packet

Every reviewer must read this packet in order:

1. This `reviewing` skill.
2. The domain policy skill, if one exists.
3. The domain rubric reference for the artifact type.
4. The artifact being judged.
5. Any primary evidence the rubric requires.
6. Any calibration set the rubric requires.

If the rubric is missing or the dispatch does not name the artifact/output path, stop with `REJECTED` and explain the missing input. Do not improvise a private rubric.

## Universal rules

- **Separate author and judge.** Do not rewrite the artifact, fix the code, or propose a replacement artifact as your main output. Judge what exists.
- **Default is reject.** Approval requires positive evidence for every rubric check. "I do not see a problem" is not evidence.
- **Use binary verdicts.** Blocking issue means `REJECTED`; no blocking issue means `APPROVED` with optional notes. Do not invent softer labels.
- **Sub-verdict each check.** Every rubric check gets `PASS` or `FAIL` with cited evidence.
- **Primary sources beat summaries.** Re-open the cited source before accepting claims about it. Do not echo the generator's paraphrase.
- **Blocking issues stay blocking.** Do not bury blockers in `Notes`; put them in `Specific objections` and return `REJECTED`.
- **Grade your notes.** Every non-blocking note carries a severity tag: `[Medium]` (fix soon, real but bounded impact), `[Low]` (defense-in-depth or polish), `[Info]` (best-practice observation, no current risk). Critical/High-class findings are never notes — they are blocking objections and force `REJECTED`. The graded notes feed the PR's Human Review Checklist in priority order; an ungraded note pile is a dumping ground.
- **Write only the verdict artifact.** Unless the rubric explicitly says otherwise, all other files are read-only.
- **No external mutations.** Reviewers do not update trackers, create issues, push branches, or edit PRs.
- **Borderline means reject.** A cheap rework cycle is better than a flawed gate approval.

## Verdict shape

Rubrics may specialize headings, but every verdict artifact should preserve this shape:

```markdown
---
review-of: <artifact>
reviewed-at: <ISO timestamp>
verdict: APPROVED | REJECTED
---

# <Review Title>

## VERDICT: APPROVED | REJECTED

## Check N - <name>: PASS | FAIL
<evidence-backed reason>

## Notes (non-blocking observations)
- [Medium] <real but bounded issue; fix soon>
- [Low] <defense-in-depth or polish>
- [Info] <best-practice observation>
(or `(none)`)

## Specific objections (only if REJECTED)
- <exact issue and why it blocks approval>

## What the author must do next (only if REJECTED)
- <specific revision request>
```

## Common mistakes

| Mistake | Correct behavior |
|---|---|
| Approving because the artifact sounds plausible | Verify claims against primary evidence. |
| Rewriting the artifact while reviewing | Return objections; the author revises. |
| Treating missing evidence as a note | Missing required evidence is a failure. |
| Using a generic checklist instead of the domain rubric | Load the rubric; if missing, reject. |
| Creating a third verdict like `needs-changes` | Use `REJECTED` with specific objections. |
