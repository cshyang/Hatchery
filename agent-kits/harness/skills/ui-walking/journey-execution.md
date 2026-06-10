---
name: ui-walking/journey-execution
description: How to execute a single oracle-declared journey safely and reproducibly.
---

# Journey Execution

A journey is a named sequence of `steps` plus an `expected` observable state. The oracle authors the journey; the walker executes it.

## Inputs (per journey)

From the oracle's `ui_journeys` entry:

- `name` — stable identifier for the journey (used as the directory key in `verdict.json`)
- `intent` — one-line plain-English purpose, for the human reader
- `steps` — ordered actions: `navigate`, `click`, `fill`, `select`, `press`, `wait_for`, `wait_ms`, `hover`, `screenshot_label`
- `expected` — observable state required when the steps complete
- `auth` (optional) — reference to an auth fixture if a logged-in context is required
- `context` (optional) — `fresh` (default) or `chain_from: <prior-journey-name>`

## Lifecycle

1. **Prepare context.** Default: open a fresh browser context (no cookies, no storage). If the oracle says `context: chain_from: <name>`, resume from the prior journey's end state instead. If `auth` is set, apply the auth fixture (cookie, header, or login flow) before navigating.

2. **Execute steps.** Run each step in order, waiting for stability between steps. Default stability: `networkidle` or `domcontentloaded`. If the oracle names an explicit `wait_for` selector or condition, use that instead. Always prefer the oracle's wait condition over your default.

3. **Record every action.** Each step appends one line to `transcript.jsonl`:

   ```json
   {"ts": "2026-05-18T12:00:00Z", "journey": "submit-empty-form-shows-required", "action": {"kind": "click", "selector": "button[type=submit]"}}
   ```

4. **Capture screenshots.** After every step that changes visible state (navigate, click, form submit, modal open/close), capture `screenshots/NNN.png` and append a `screenshot_ref` line to the transcript:

   ```json
   {"ts": "2026-05-18T12:00:01Z", "journey": "submit-empty-form-shows-required", "screenshot_ref": "screenshots/004.png", "label": "after-submit"}
   ```

5. **Collect expected observations.** When all steps are done, gather each observation the oracle's `expected` block declares. See `references/observation-types.md` for the closed set. Record observations under `verdict.json[journey].observed`.

6. **Always collect ambient errors.** Independent of the oracle's `expected`, always record:
   - Every `console.error` and `console.warning` seen during the journey
   - Every network request with status >= 400
   - Every uncaught page error

   These go into `verdict.json[journey].ambient_errors`. The conductor can elevate them to failures even when the explicit expectations passed.

## Determinism

The walker must produce the same `observed` block for the same `(app commit, journey, fixtures)` triple on at least three back-to-back runs. If it doesn't, the journey is flaky. Flakiness is not the walker's job to suppress; it is the walker's job to expose. Record the inter-run variance in the report and let the conductor mark the journey `flaky` so the next dispatch routes to `deliver-oracle-writer` for an entropy/timing fix (matching the existing flakiness pattern in `verification`).

## What the walker does NOT do

- Compute `status: pass | fail`. The walker records observed state only. Status is the conductor's verdict.
- Mutate the application, test data, or oracle.
- Retry indefinitely. One retry is acceptable only if the oracle's wait condition allows it. Beyond that, record the failure to converge and escalate.
- Interpret intent beyond what the oracle stated. If the oracle says "expect URL = /dashboard" and the URL is /dashboard?welcome=1, that is a fact for the conductor to interpret, not for the walker to soft-pass.
