---
name: ui-walking/failure-taxonomy
description: Closed taxonomy of failure shapes a ui-walker can encounter, and what each one means for the next move.
---

# Failure Taxonomy

When a journey cannot complete cleanly, the walker must classify the failure into one of the categories below and record it in `verdict.json[journey].failure_kind` plus a short `failure_note`. The taxonomy is closed: if a failure does not fit, write `failure_kind: "uncategorized"` and describe it explicitly so the taxonomy can be improved.

## Categories

### `action-step-broken`

An action step (click, fill, select) could not be executed because the target selector did not appear within the wait budget, or the action raised an error from the browser tool.

- **Likely cause**: implementation regression, selector drift, race condition.
- **Walker move**: record the failed step, screenshot the page state at failure, stop the journey, mark the verdict's observed block with `failure_kind: action-step-broken`.
- **Downstream meaning** (conductor's job, not walker's): probably `verification-failed`, route fix to `deliver-implementer`.

### `expected-state-absent`

All steps executed, but an `expected` observation the oracle declared is not present in the actual state.

- **Likely cause**: implementation didn't produce the contracted output, or oracle is wrong.
- **Walker move**: record full observed state, screenshot the relevant region, mark `failure_kind: expected-state-absent`.
- **Downstream meaning**: conductor compares observed vs. expected and decides whether `verification-failed` (implementation) or `oracle-rewrite-needed` (oracle).

### `ambient-error-surfaced`

The journey's explicit expectations all met, but ambient observations (console error, network 5xx, uncaught exception) surfaced.

- **Likely cause**: real bug masked by happy-path navigation, or noisy logging that should be suppressed.
- **Walker move**: complete the journey, record ambient errors verbatim in `verdict.json[journey].ambient_errors`, do NOT downgrade the journey's `observed` block.
- **Downstream meaning**: conductor decides whether ambient errors are tolerable or escalating.

### `app-did-not-boot`

The application did not become reachable at the configured base URL within the boot budget, or the start command exited.

- **Likely cause**: missing env var, port conflict, broken start command in `defaults.yaml`, dependency install failed.
- **Walker move**: do NOT attempt any journey. Write a `blocker-escalation` report with category `environment` and include the start command's stderr.
- **Downstream meaning**: conductor halts, operator decides.

### `auth-fixture-missing`

The journey requires an authenticated context and the fixture reference is missing, empty, or invalid.

- **Walker move**: skip the journey, write a `blocker-escalation` report with category `policy`, name the missing fixture.
- **Downstream meaning**: standards/defaults need a value; not a code bug.

### `non-determinism`

Three back-to-back runs of the same journey on the same app commit produced different `observed` blocks.

- **Walker move**: include all three observed blocks under `runs: [...]` in the verdict, mark `failure_kind: non-determinism` for the journey.
- **Downstream meaning**: conductor marks the journey `flaky` and routes the next dispatch to `deliver-oracle-writer` (timing/entropy fix), matching the existing flakiness pattern in `verification`.

### `tooling-broken`

The bound Playwright MCP (or equivalent) tool itself errored in a way that doesn't fit `action-step-broken` — server unreachable, browser crashed, screenshot capture failed.

- **Walker move**: capture whatever evidence is available, write a `blocker-escalation` report with category `environment`, do not retry indefinitely.
- **Downstream meaning**: infrastructure issue; conductor routes to operator.

### `uncategorized`

The failure does not fit the categories above.

- **Walker move**: record the failure verbatim, describe what doesn't fit, and file a follow-up note suggesting how the taxonomy should evolve.

## What this taxonomy is for

The categories exist so the conductor can mechanically route follow-up work without re-reading the entire transcript. They are NOT verdicts; they are *failure shapes*. The verdict (pass/fail/insufficient) is computed by the conductor from `observed` vs. `expected` plus the failure_kind hint.
