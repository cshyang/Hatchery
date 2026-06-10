# Blocker Report

<!--
Fill in every required section below. Run scripts/validate-blocker.py against the
completed file before filing. Delete this comment after filling out.
-->

**Run:** <run-id>
**Stage:** <phase name — e.g., "audit review", "deliver oracle", "deliver implementation", "deliver verification">
**Surface:** <build surface if applicable: deliver oracle | deliver implementation | deliver verification. Omit when not applicable.>
**Timestamp:** <ISO-8601, e.g., 2026-04-24T14:22:00Z>
**Filed by:** <role name — e.g., audit-assessor, audit-reviewer, deliver-oracle-writer, deliver-implementer>

## Category

<!--
Exactly one of (see references/blocker-categories.md for definitions):
- implementation-failure
- artifact-ambiguity
- oracle-contradiction
- policy-conflict

If none fit, pick the closest AND add a `## Category fit note` section below
explaining the mismatch. The taxonomy is provisional; honest misfits are more
useful than force-fits.
-->

implementation-failure

## Failing surface

<!--
A concrete path. Use one of:
- File + line: src/handlers/users.py:142
- Endpoint: DELETE /api/v1/users/{id}
- Artifact: artifacts/api-spec.json::endpoints[3]
- Oracle check: oracle/contract/users_delete.test.ts::"returns 404 when user missing"
- Environment: env var STRIPE_SECRET_KEY, port 5432, binary `docker`

Not "the users module", "some test", "the DB". Name the thing.
-->

<path or resource identifier>

## Observed behavior

<!--
Paste the raw evidence. Stderr output, failing test assertion, the two conflicting
artifact excerpts side by side. This is evidence, not a paraphrase. The conductor
routes the decision based on what's here; summaries bounce.

Minimum ~50 characters. If that's hard to meet, the blocker probably doesn't have
enough evidence yet — try one more narrow attempt first.
-->

```
<paste output, excerpts, or traces here>
```

## What was tried

<!--
One bullet per attempt. Each bullet is "Attempt N: <what you did> → <what happened>".
If no attempts have been made, this skill is being used to avoid effort rather than
to escalate after effort. Go try something narrow first.
-->

- Attempt 1: <what you did> → <what happened>
- Attempt 2: <what you did> → <what happened>
- Attempt 3: <what you did> → <what happened>

## Why each attempt was insufficient

<!--
One line per attempt in the same order. If the attempts form a diagnostic pattern
(e.g., "every fix passes the failing test but breaks a different one — the test
shape is probably wrong"), name the pattern. The conductor uses the pattern to
decide whether to authorize another slice or accept the escalation.
-->

- Attempt 1: <why the outcome didn't resolve the blocker>
- Attempt 2: <why the outcome didn't resolve the blocker>
- Attempt 3: <why the outcome didn't resolve the blocker>

## Hypothesis

<!--
Optional but usually worth including. Your best guess at root cause, explicitly
marked as guess. Not load-bearing — the conductor may ignore this entirely —
but it speeds triage when the guess is right.
-->

Guess: <root cause hypothesis>

## Smallest decision required

<!--
ONE concrete decision with a bounded answer set. Not "help me figure this out",
not "please advise". The test: can the answer be a single sentence or a pick
between two-to-four options? If yes, good. If not, the decision is too open.

Good examples:
- "Should `/admin/*` bypass tenant middleware, or is `api-spec.json` wrong to list
  those endpoints as tenant-scoped?"
- "Extend budget by 3 more iterations, or abort this slice and split it smaller?"
- "Accept `oracle/journey/checkout.test.ts` as authoritative for the Stripe
  handoff, or revise it to match `user-journeys.json` Step 4?"

Bad examples:
- "What should I do?"
- "Redesign the oracle"
- "Figure out the tenancy story"
-->

<the single concrete decision>

## Out of scope

<!--
Optional. Things that look relevant but are NOT part of this decision. Bounded
decisions resolve faster. If you find yourself writing a long list here, the
blocker is probably scoped too wide — consider splitting.
-->

- <adjacent concern that should not be conflated with the decision>
- <adjacent concern that should not be conflated with the decision>

## Category fit note

<!--
Optional. Include this section ONLY if the chosen category doesn't cleanly fit.
Name the closest category and explain the mismatch. This is how the taxonomy
improves.
-->

## Protected surfaces check

<!--
Attestation. Check each box. If any box can't be checked, this blocker is also
a protected-surface violation — file that as a separate, higher-priority report.
-->

- [ ] No accepted artifact was modified during the attempts recorded in this report.
- [ ] No oracle file was modified during the attempts recorded in this report.
- [ ] No policy default was modified during the attempts recorded in this report.
