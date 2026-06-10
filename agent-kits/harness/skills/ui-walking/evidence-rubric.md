---
name: ui-walking/evidence-rubric
description: What counts as proof in a ui-walker evidence pack.
---

# Evidence Rubric

Three rules. Every claim in `verdict.json` and `report.md` must satisfy them.

## Rule 1 — Every claim is anchored

A claim is `verdict.json[journey].observed.<key>: <value>`. Every claim must be reproducible from the transcript + screenshots in the same evidence pack. If a reviewer can't trace the claim back to:

- a transcript line showing the observation was captured, AND
- (when visible) a screenshot showing the observed state,

then the claim is unanchored and the verdict is invalid. Re-run the journey; do not paper over the gap.

## Rule 2 — Raw, not paraphrased

Record the observed value, not your description of it.

- ✅ `"visible_text_at": {"selector": "[data-testid=error]", "text": "Email is required"}`
- ❌ `"observed": "an error appeared"`

- ✅ `"console_errors": [{"text": "Uncaught TypeError: Cannot read 'foo' of undefined", "source": "app.js:42"}]`
- ❌ `"console_errors": ["there were some console errors"]`

Paraphrase is the conductor's job, not the walker's.

## Rule 3 — Absence is also evidence

If the oracle expects an error to NOT appear, the walker must record what it *did* see at that location — not just write `"error_present": false`. Negative claims need positive evidence:

```json
"observed": {
  "no_required_error": {
    "selector": "[data-testid=error]",
    "present": false,
    "screenshot_ref": "screenshots/007.png",
    "label": "no-error-after-valid-submit"
  }
}
```

The screenshot is the proof that the selector was checked and the element was absent.

## What the report.md must contain per journey

- The journey name and intent (copied from the oracle, not paraphrased)
- A bulleted list of the steps executed, each with the screenshot reference for the resulting state
- The observed state for each oracle-declared expectation, copied verbatim from `verdict.json`
- The ambient errors section: console errors, network errors >= 400, page errors. If empty, say `none`. Do not omit the section.
- A `flakiness` note if multiple runs disagreed
- A `blockers` note if anything was escalated via `blocker-escalation`

The report is a human-readable view onto the same data the conductor machine-reads. They must agree. If `verdict.json` says one thing and `report.md` says another, the evidence pack is corrupt and the journey must be re-executed.

## What does NOT count as evidence

- "It looked right" — no screenshot, not evidence
- "The test passed" — there is no test; there is observed state vs. expected state
- "I tried that and it didn't work" — replace with the action + observation + screenshot
- Screenshots without transcript references — orphan files. Every screenshot must be linked from the transcript.
- A pass verdict from the walker itself — the walker does not issue verdicts. The conductor does.
