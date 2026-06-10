# Audit Assessment Review Rubric

Use this rubric when `audit-reviewer` judges `assessment.md`.

## Required inputs

- `.pi/skills/reviewing/SKILL.md`
- `.pi/skills/audit/SKILL.md`
- `.pi/skills/audit/assets/assessment-template.md`
- `.pi/skills/audit/references/external-exposure.md` when external exposure is enabled
- injected `assessment.md`
- `<run-dir>/prior-issues.json` when injected (Check 6 reads this directly to validate annotations)
- `.harness/standards.yaml` when present

## Checks

### Check 1 - Well-formedness

Does the assessment conform to `assets/assessment-template.md`?

Required frontmatter keys must be present, including `external-url` and `external-exposure`. Required sections must be present, including External exposure findings. Every required checklist row from the skill must be present. Issue-candidate field count is conditional on tracker:

- **No tracker (no `prior-issues.json` injected)** — every candidate must populate exactly the **nine canonical fields**. Tracker fields (`prior-issue-status`, `prior-issue-reasoning`) must be **absent**. A candidate that includes them anyway is `FAIL`.
- **Tracker configured (`prior-issues.json` present)** — every candidate must populate the nine canonical fields **plus** `prior-issue-status`. `prior-issue-reasoning` is required whenever the status is non-`new`.

Missing, renamed, collapsed, or placeholder checklist rows are `FAIL`.

### Check 2 - Groundedness

Every `PASS` / `FAIL` claim must cite concrete evidence. Checklist summary uses only `PASS`, `FAIL`, or `UNVERIFIED`.

If `.harness/standards.yaml` exists, stack-sensitive recommendations must reflect it. If the repo lacks a standard and evidence does not constrain the path, the gap is `decision-required`, not an invented standard. `.env.example` is evidence, not policy.

Pay special attention to external production exposure, security basics, tenant isolation, role/RBAC boundaries, background jobs/queues/webhooks, and performance/scalability. A `PASS` on one of these rows requires positive evidence that the surface is production-ready or concrete evidence that the surface does not apply. Omitted searches or vague statements like "not relevant" are `FAIL`.

### Check 3 - Verdict correctness

Does the top-level verdict follow `SKILL.md` Verdict thresholds?

A verdict looser than the evidence supports is `FAIL`. Any `P0` or launch-critical `UNVERIFIED` must be `do-not-ship`. `ship` requires no `P0`, no `P1`, and no launch-critical `UNVERIFIED`.

### Check 4 - Issue-candidate quality

Candidates must be bounded, not vague epics. Unrelated fixes must not be collapsed together. `execution-ready` is valid only when standards or current repo shape constrain the implementation path. `decision-required` is required when the capability gap is real but the implementation path is not chosen. If a candidate would force `deliver` to invent the platform choice, this check is `FAIL`.

### Check 5 - External probe safety

If `external-exposure: enabled`, the assessment must show that probes stayed within `references/external-exposure.md`:

- only configured URL / same-origin paths
- default methods limited to `GET`, `HEAD`, `OPTIONS`
- login `POST` only when explicitly enabled
- no destructive or state-changing probes
- sensitive response values redacted
- unsafe useful probes listed as skipped rather than executed

If the assessment reports `DELETE`, `PUT`, `PATCH`, non-login `POST`, fuzzing, credential guessing, password reset, file upload, or other state-changing behavior, this check is `FAIL` even if the finding is real.

### Check 6 - Tracker-sync annotation correctness (conditional)

**Apply this check only when `prior-issues.json` is present in the run dir.** If `prior-issues.json` is absent (tracker not configured), **omit Check 6 from `review.md` entirely** — do not emit a "no tracker configured" passing line. The output format below shows where the conditional section goes.

Per candidate, validate:

- `prior-issue-status` is present and uses the allowed enum: `new`, `duplicate-of-open: <identifier>`, `related-to: <identifier>`, `closed-match: <identifier>`. Anything else is `FAIL`.
- For non-`new`: the cited `<identifier>` actually exists in `prior-issues.json` (either `open[]` or `closed[]`). A hallucinated id is `FAIL`.
- For non-`new`: `prior-issue-reasoning` is present, references concrete evidence from both the candidate and the cited prior issue's `body_summary`, and is not vague ("similar topic", "related area", "same general space" — all `FAIL`).
- `duplicate-of-open: <id>`: the cited issue's state is in `prior-issues.json` open states. If the cited issue is in `closed[]`, the auditor should have used `closed-match` instead — `FAIL`.
- `related-to: <id>`: the link is substantive (shared subsystem or causal chain), not just a shared word.
- `closed-match: <id>`: cited issue is within the 180-day window in `closed[]`, AND the candidate's evidence shows the gap is currently present. The reasoning must state the regression hypothesis explicitly.

False-`new` sweep: for every candidate marked `new`, scan `prior-issues.json` once for obvious matches the auditor missed (title-phrase overlap, same problem subsystem, evidence pointing at a file the prior issue already names). Any clear missed duplicate is `FAIL` with the missed identifier listed.

If `FAIL`, the reviewer's objection lists each candidate index plus the specific annotation problem so the auditor can correct without regenerating the whole assessment.

## Output format

```markdown
---
run: <run-id>
review-of: assessment.md
reviewed-at: <ISO timestamp>
verdict: APPROVED | REJECTED
---

# Audit Review

## VERDICT: APPROVED | REJECTED

## Check 1 - Well-formedness: PASS | FAIL
<reason>

## Check 2 - Groundedness: PASS | FAIL
<reason>

## Check 3 - Verdict correctness: PASS | FAIL
<reason>

## Check 4 - Issue-candidate quality: PASS | FAIL
<reason>

## Check 5 - External probe safety: PASS | FAIL
<reason>

<!-- Include the section below ONLY when prior-issues.json was present (tracker configured).
     Omit entirely for markdown-first audits. -->

## Check 6 - Tracker-sync annotation correctness: PASS | FAIL
<reason>

## Notes (non-blocking observations)
(none)

## Specific objections (only if REJECTED)
- <exact issue>

## What the auditor must do next (only if REJECTED)
- <specific revision>
```
