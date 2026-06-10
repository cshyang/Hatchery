---
name: ui-walking
description: Use when an the harness worker must drive a running application's UI to produce verification evidence against an oracle's UI journeys. The skill governs how to launch the app safely, walk a journey as the oracle declares it, observe the resulting state, and capture screenshots + transcript + structured observed-state JSON the conductor can mechanically compare against expected state. Reach for it whenever an oracle declares a `ui_journeys` block and a worker is being asked to execute it. Do not use it to invent journeys, to judge UX freely, or to author the oracle itself.
---

# UI Walking

## Overview

Drive a running application's UI to produce **oracle-anchored verification evidence**. The oracle declares the journeys and the expected observable state at each step; the walker executes the journey and records what the app actually showed. The walker does not decide whether the app is correct — the oracle (via the conductor's verification step) does.

The deliverable is a per-journey evidence pack written to the issue's `ui-walker/` directory:

- `report.md` — human-readable summary, one section per journey, with screenshot links
- `transcript.jsonl` — append-only record of every action and observation
- `screenshots/` — numbered PNGs referenced from the transcript
- `verdict.json` — machine-readable observed state per journey, ready for the conductor to compare against oracle expectations

Everything else in this skill exists to keep that evidence pack honest.

## Posture

**You are the executor, not the judge.** The oracle declares correctness; you record reality. When the app does something surprising, your job is to capture it as observed state and let the conductor decide whether that observed state matches the expected state. Do not silently retry, do not "fix" by clicking around, do not infer intent. Observed reality is the artifact.

This is **not** dogfooding. A future heuristic mode will dogfood; v1 is oracle compliance.

## When to use

Use when:

- The oracle for a slice declares a `ui_journeys` block (or equivalent browser-check evidence) and the conductor has dispatched you to execute it.
- The journey is concrete: explicit steps, explicit expected observable state.
- The application can be launched in a deterministic way (start command + base URL known).

Do not use when:

- No oracle exists yet — the walker is the runtime sibling of `deliver-implementer`, not a substitute for `deliver-oracle-writer`.
- The "journey" is described in narrative prose without concrete steps. Escalate via `blocker-escalation` (category: oracle-insufficient) so the oracle writer rewrites it.
- The expectation is purely aesthetic ("looks nice", "feels modern"). v1 has no UX-judgment mode.

## The shape of a journey execution

Each journey runs in a clean browser context (no cookies/storage from prior journeys unless the oracle explicitly says to chain). For each declared step:

1. Execute the action (`navigate`, `click`, `fill`, `wait`, `press`, etc.) using the bound browser tooling.
2. Wait for stability — `networkidle` or an explicit selector the oracle names.
3. Record the action in `transcript.jsonl` with a timestamp.
4. Capture a screenshot to `screenshots/NNN.png` after each meaningful state change.
5. Observe state required by the oracle's `expected` block (visible text, attribute, URL, console errors, network errors, presence/absence of selector) and record it under that journey's `observed` field in `verdict.json`.

When the journey's last step completes, capture a final screenshot and write the journey's section of `report.md` summarizing what was observed, with screenshot references inline.

The walker does NOT compute pass/fail. It records observed state. The conductor's verification step compares `verdict.json[<journey>].observed` against the oracle's `expected` for that journey.

## Discipline

These rules are what make the evidence pack usable to the conductor. Violating them produces evidence that wastes a verification pass or, worse, lets a regression ship.

1. **Observe, don't judge.** Do not write `status: pass` into `verdict.json` based on your interpretation. Write the raw observed values. The conductor computes the verdict.
2. **Every observation has a screenshot.** If `verdict.json` claims `visible_text: "Required"`, there must be a screenshot referenced from the transcript that shows that text. Unanchored claims are not evidence.
3. **Capture console + network errors always, even when the journey "succeeds."** A journey that succeeds *with* a 500 in the network log is evidence the conductor wants to see. Silent suppression is a bug.
4. **One journey per clean context.** Cross-journey state leaks make verdicts non-reproducible. Default to a fresh browser context per journey. The oracle must explicitly opt in to chaining.
5. **Do not modify the application or test data to make a journey pass.** That is `deliver-implementer`'s scope, not yours. If the journey cannot be executed because the app is broken, that *is* the verdict — record it and stop.
6. **Escalate on infrastructure failures.** If the app won't boot, auth fixture is missing, or the browser tool errors before navigation, write a `blocker-escalation` report. Do not invent workarounds.

## Rationalizations

These thoughts should make you stop and re-check the discipline:

| Thought | Reality |
|---|---|
| "The button is clearly broken but I can click it via a different path" | Then the journey as the oracle declared it failed. Record that. Don't reroute. |
| "The expected text is missing but the page looks right" | Record observed state. The conductor decides. Your "looks right" is not evidence. |
| "There's a console error but the flow finished" | Always record the console error. The conductor may treat it as a failure even if the flow finished. |
| "I'll just retry once, the app must be loading slowly" | Retry only if the oracle's wait condition explicitly allows it. Otherwise observe and record. |
| "I'll skip the screenshot, the transcript is enough" | No. Screenshots are the proof. The transcript references them; both are required. |

## Required artifacts (must all be present)

- `ui-walker/report.md`
- `ui-walker/transcript.jsonl` — one JSON object per line, append-only, with `ts`, `journey`, `action` or `observation`, and `screenshot_ref` when relevant
- `ui-walker/screenshots/NNN.png` — at least one screenshot per journey; numbering monotonic across the whole run
- `ui-walker/verdict.json` — machine-readable observed state, schema in `references/verdict-schema.md`

## Related

- `journey-execution.md` — lifecycle of a single journey
- `evidence-rubric.md` — what counts as proof
- `failure-taxonomy.md` — closed set of failure shapes
- `.pi/skills/blocker-escalation/` — when the walker cannot proceed

## verdict.json shape (v1 reference)

The conductor reads this. Be precise.

```json
{
  "schema_version": "ui-walker/v1",
  "issue_id": "FRD-162",
  "run_id": "2026-05-18T12-00-00Z",
  "journeys": [
    {
      "name": "submit-empty-form-shows-required",
      "intent": "User clicks Submit on empty Name field and sees Required error",
      "context": "fresh",
      "steps_executed": 2,
      "observed": {
        "visible_text_at": {
          "selector": "[data-testid=name-error]",
          "text": "Required",
          "screenshot_ref": "screenshots/004.png"
        },
        "url": "/signup",
        "url_unchanged_from_step_0": true
      },
      "ambient_errors": {
        "console_errors": [],
        "network_errors_4xx_5xx": [],
        "page_errors": []
      },
      "failure_kind": null,
      "failure_note": null,
      "runs": null
    }
  ]
}
```

`failure_kind` is null on a clean run, or one of the strings from `failure-taxonomy.md`. `runs` is null unless multi-run determinism was checked, in which case it's an array of observed blocks.
