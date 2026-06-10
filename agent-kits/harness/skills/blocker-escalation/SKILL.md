---
name: blocker-escalation
description: Use when an the harness agent cannot safely continue and must stop guessing. Converts unresolved ambiguity, protected-surface conflicts, repeated-without-narrowing failures, or environment/setup failures into a structured blocker report that names the smallest concrete decision the conductor or human must make. Reach for this whenever an iteration is about to silently invent intent, rewrite the judge, or loop in place without narrowing the failure class — do not use it for writing implementation code.
---

# Blocker Escalation

## Overview

Convert an unrecoverable state into a structured blocker report so the conductor (or a human) can make the smallest decision that unblocks the loop. The skill stops the executor from guessing when it should be escalating.

The deliverable is a filled-out report matching `assets/blocker-report-template.md`, categorized against `references/blocker-categories.md`, and passing `scripts/validate-blocker.py`. Everything else in this skill exists to keep that deliverable honest.

## When to use

Use when:

- The execution loop cannot proceed safely.
- A protected artifact, oracle file, or policy default appears wrong and no patch of the implementation alone can resolve it.
- Repeated iterations are not narrowing the failure class — the same shape of failure keeps recurring, or each new attempt surfaces a different, unrelated failure.
- The environment or prerequisites prevent progress (e.g., missing env var, missing binary, port conflict).
- The task requires changing a protected surface the current agent is not allowed to touch.

Do not use when:

- The issue can be solved by a small implementation patch — fix it instead.
- The conductor has already approved a retry path for this exact failure class.
- The intent is to silently avoid an iteration. An executor that isn't sure whether to escalate should usually try one more narrow slice first, then escalate with that attempt recorded in "What was tried."

## The shape of a blocker

Every blocker report fills in `assets/blocker-report-template.md`. The template is the contract — the skill body is the discipline around filling it out honestly. Read the template before writing a blocker.

The template requires:

- A **category** from the closed enum in `references/blocker-categories.md`.
- A **failing surface** — a concrete path (file:line, endpoint, artifact, oracle check). Not "the users module"; `src/handlers/users.py:142`.
- **Observed behavior** — the raw evidence. Paste stderr, paste test output, paste the conflicting artifact excerpts. Evidence, not paraphrase.
- **What was tried** — one line per attempt with the outcome. If nothing was tried, the skill is being used to avoid effort rather than to escalate after effort.
- **Why each attempt was insufficient** — the diagnostic pattern across attempts, if any. This is what lets the conductor decide whether the blocker is the right escalation or whether one more slice is warranted.
- **Smallest decision required** — the single concrete question. "Should `/admin` bypass tenancy, or is `api-spec.json` wrong about the endpoint?" not "please advise."
- **Protected surfaces check** — a three-checkbox attestation that no accepted artifact, no oracle file, and no policy default was modified during the attempts that led to this blocker.

Optional but usually worth including:

- A **hypothesis** (explicitly marked as guess, not conclusion).
- An **out of scope** list — things that look relevant but are not the ask. Bounded decisions resolve faster than open-ended ones.

## Discipline

These rules are what make the report usable to the conductor. Violating them produces a blocker that wastes a triage pass without moving the loop forward.

1. **Evidence, not summary.** The conductor routes on evidence. A report that says "the tests failed" produces a triage round asking for the test output. Paste the output in the first report.
2. **Name the smallest decision.** "Help me figure this out" is not a decision. A decision is a question with a bounded answer set: which of these two paths, accept or revise, continue or abort. Reports that ask for unbounded help bounce back.
3. **Don't touch protected surfaces during escalation.** If you are writing a blocker because a protected surface needs changing, the blocker's whole point is to propose that change for the conductor to authorize — not to sneak the change in while you're escalating.
4. **One blocker per decision.** A report that asks for three decisions at once is three reports stapled together. Pick the one that unblocks the most and file that; the others often dissolve once it's decided.
5. **Categorize honestly.** If no category in `references/blocker-categories.md` fits, say so explicitly in the report's notes. The taxonomy was drafted before most of the failure shapes were observed; "this doesn't fit, closest is X" is valuable signal to improve the taxonomy. Don't force-fit a category — force-fit is how taxonomies go bad.

## Rationalizations

| Rationalization | Reality |
|---|---|
| "I can keep trying a little longer" | Repeated blind retries waste the run budget. If three narrow slices haven't narrowed the failure class, the failure is structural, not superficial. |
| "The blocker is probably obvious to the user" | The blocker must be explicit and actionable without conversation. The conductor may be acting without a human in the loop. |
| "I can quietly adjust the oracle / artifact to get past this" | Protected surfaces are not negotiation targets. Editing them is the failure mode the loop is designed to prevent, and it is exactly the failure mode blocker-escalation exists to route around. |
| "I'll file the report and also try the fix anyway" | The fix-while-escalating pattern corrupts "what was tried." File, then wait for the decision. If the conductor authorizes the fix, do it then. |
| "The category doesn't quite fit but close enough" | Force-fit is how taxonomies rot. State the mismatch in the report; let the taxonomy grow from real observations. |

## Red flags

- The report says only "stuck" or "this isn't working" without concrete evidence.
- Root cause is mixed with guesswork — the hypothesis is presented as fact.
- The requested human action is broader than necessary ("redesign the oracle" rather than "which of these two oracle layers is authoritative for endpoint X").
- A protected file was modified during the escalation itself.
- The blocker's category was chosen by convenience rather than by fit.
- The report contains no "What was tried" entries — this skill is for escalating after effort, not instead of it.

## Verification

Run `scripts/validate-blocker.py <path-to-report>`. The script mechanically checks:

- Category is a known value.
- Failing surface names a concrete path.
- Observed behavior contains enough content to be evidence rather than a stub.
- At least one "Attempt N:" entry is present under What was tried.
- Smallest decision required doesn't use vague phrasing ("help me", "please advise", "stuck").
- All three Protected-surfaces checkboxes are ticked.

A report that passes the lint is not automatically a good report — but a report that fails the lint is definitely not ready to file. Judgment criteria (is the decision really the smallest one? is the evidence actually localized?) live with the conductor reviewer, not with the script.

In addition, independent of the script:

- No protected surface was modified during the attempts recorded in the report.
- The report addresses one decision, not several.
- The category is either a clean fit or the mismatch is explicitly named.
