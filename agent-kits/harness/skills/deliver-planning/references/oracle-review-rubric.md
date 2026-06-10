# Oracle Review Rubric

Use this rubric when `deliver-oracle-reviewer` judges `oracle/result.md`.

## Required inputs

- `.pi/skills/reviewing/SKILL.md`
- `.pi/skills/deliver-planning/SKILL.md`
- injected `oracle/result.md`
- injected `spec.md` and latest approved spec review
- injected testbed root + every path listed under the oracle's `oracle-files:` frontmatter
- injected issue body/comments

## Checks

### Check 1 - Outcome correctness

Does `oracle-outcome` match what the evidence actually shows?

The four valid outcomes are `oracle-green`, `oracle-red-expected`, `oracle-failed`, `oracle-insufficient-evidence`. Verify the writer's outcome label is honest:

- `oracle-green` requires executed-and-passed behavioral, integration, or visual evidence. Typecheck, lint, route generation, and grep alone are supporting evidence — not green by themselves. If the only evidence is supporting and the oracle claims green, FAIL.
- `oracle-red-expected` requires the new oracle to FAIL on the missing-but-expected behavior the spec calls out. Confirm via `evidence-run` that the failing command's exit code and stderr are consistent with the missing implementation. If the failure is harness brokenness (compile error, missing fixture, broken harness path), the correct outcome is `oracle-failed`, not `oracle-red-expected`. FAIL if the writer hid harness failure under red-expected.
- `oracle-failed` and `oracle-insufficient-evidence` are valid only when the writer's evidence supports them and the `Blockers` section names a concrete obstacle.

Cross-check against the oracle-writer's own hard rules: "Do not hide a harness failure under `oracle-red-expected`" and "Do not hide missing evidence under `oracle-green`." A mismatched outcome is FAIL.

### Check 2 - Evidence sufficiency

Are material claims from the spec covered with the appropriate evidence layer, and does the chosen evidence actually close the gap?

Apply this in two passes:

**Pass A — coverage layer honesty.** For every entry in `claims-verified`, confirm `coverage:` is one of `behavioral | structural | visual | integration | supporting` and matches what the cited evidence actually demonstrates. A grep-against-source claim labeled `behavioral` is FAIL. A typecheck claim labeled `behavioral` is FAIL. A mock-only test labeled `integration` is FAIL.

**Pass B — soundness probe (mandatory).** For every AC marked `coverage: structural` in `claims-verified`, name a broken implementation that passes the oracle's check. If the answer is short and concrete, the AC is FAIL on Check 2. Examples to flag:

- `grep -E 'truncate'` defeated by `text-ellipsis` / `overflow-hidden` (same visual outcome, oracle PASS).
- `grep '<ComponentName'` matched by JSX comments, dead code, or a stub component that renders nothing.
- String enumeration of registry categories matched by a dead `type` declaration the runtime never references.
- File-existence (`ls`) check passed by an empty stub file.
- "Refs removed" grep passed by renaming the ref while keeping the underlying behavior.

**Pass C — behavior vs design discipline (mandatory).** Every frozen assertion is a permanent design lock; the implementer cannot pass verification without satisfying it. Apply the oracle-writer's two-step test (`.pi/agents/deliver-oracle-writer.md` § Assertion discipline) to each `expect(...)` in the conductor-extracted assertion list (`oracle/assertions.txt` — injected with this dispatch). For every entry:

1. **Observable behavior, or internal design?** If the asserted value is internal design (specific function/class names, helper organization, file structure, private state shape), FAIL Check 2 — the assertion belongs in code review, not in the oracle.

2. **Spec-constrained, or pinning beyond the spec?** If the spec did not explicitly constrain the specific value (`toBe(403)` when spec said only "deny"; `toBe('User is disabled')` when spec said only "denied with reason"; `toBe(<exact UUID>)` when spec said only "log the actor"), FAIL Check 2 unless the oracle-writer cites the exact spec line constraining the specificity.

Each over-pinned assertion locks the implementer into one of several valid behaviors when the spec only named the broader contract. The fix is to **loosen** (`toBeOneOf`, `toMatch`, `toBeTruthy`+type check, `toHaveProperty`) or **remove** (if internal design), not to keep the over-pin.

**Refactor oracles are the named exception.** When the spec's preservation contract makes byte-level specifics observable behavior (exact error strings, header shapes, ordering), pinning specifics IS the contract — review against the spec's stated invariants, not the general two-step test. Confirm `preservation-status: ready` or `needs-coverage-first` in the spec frontmatter before applying the exception.

UI/frontend issues require at least one behavioral or visual evidence layer (E2E spec, component test, browser/preview check, screenshot, screen recording) OR a documented runner-tooling blocker that names the exact missing capability. A UI feature whose entire AC set is `coverage: structural` plus typecheck is FAIL on Check 2 unless the spec explicitly accepts that floor and the writer's `evidence-not-run` section justifies it with concrete tooling claims.

If the spec invokes existing test infrastructure (e.g., the customer's `frontend/CLAUDE.md` § Testing chain, an existing Playwright suite at `e2e/`, a pre-existing Vitest/Jest config), the oracle must invoke it OR `evidence-not-run` must justify the omission with a runner-capability claim. Silent omission of mandated test chains is FAIL.

### Check 3 - Honesty / risk discipline

Are `evidence-not-run`, `residual-risk`, and `human-review-needed` honest reflections of the gaps, or boilerplate?

- **`evidence-not-run` specificity.** Each entry must name a concrete tooling or environment gap that prevents running the evidence. *"Runner image lacks chromium"* is actionable — the operator can choose to bake it in. *"Sandbox has no browser"* reads as inevitability and hides a deployment choice — FAIL on Check 3 if recoverable gaps are framed as physics.
- **`residual-risk` concreteness.** Items must be specific failure modes, not boilerplate. *"⌘K listener may attach twice on hot reload"* is concrete. *"Some edge cases may not be covered"* is boilerplate — FAIL.
- **`human-review-needed: true` justification.** Set true only when a real human-only check exists (visual fidelity at default zoom, content judgment, taste, copy review). Setting it as a default escape from automatable verification — when an automatable evidence path exists and was not pursued — is FAIL.
- **`evidence-not-run` impact field.** When present, the impact statement must explain why the chosen `oracle-outcome` is still defensible despite the gap, OR the outcome should be `oracle-insufficient-evidence`.
- **No duplication between blocks.** A `residual-risk` block that simply restates `evidence-not-run` is FAIL — they serve different purposes (what wasn't tested vs. what could still break despite testing).

## Output format

```markdown
---
issue: <id>
review-of: oracle/result.md
artifact-reviewed: oracle/result.md
reviewed-at: <ISO timestamp>
reviewer-sha: <testbed SHA>
verdict: APPROVED | REJECTED
failed-checks: [<Outcome correctness | Evidence sufficiency | Honesty/risk discipline; empty array when APPROVED>]
blocking-objection: null | "<highest-priority objection>"
---

# Oracle Review NN - <ISO date>

## VERDICT: APPROVED | REJECTED

## Check 1 - Outcome correctness: PASS | FAIL
<one paragraph, citing oracle-outcome and evidence-run entries that prove or disprove>

## Check 2 - Evidence sufficiency: PASS | FAIL
<one paragraph; explicitly include the soundness probe — for each structural AC, name a broken implementation that passes ("AC<n> grep `<pattern>` is defeated by <broken impl>; oracle would PASS"). Then include the behavior-vs-design pass — walk `oracle/assertions.txt` and call out any over-pinned assertions ("`tabs.spec.ts:194 expect(second).toBeFocused()` after ArrowRight — spec at brief.md:19 explicitly says 'focuses + activates'; correctly pinned" / "`auth.test.ts:42 expect(res.status).toBe(403)` — spec said 'deny' without naming a status code; FAIL — loosen to `toBeOneOf([401, 403])`").>

## Check 3 - Honesty/risk discipline: PASS | FAIL
<one paragraph, citing evidence-not-run / residual-risk / human-review-needed entries>

## Notes (non-blocking observations)
(none)

## Specific objections (only if REJECTED)
- <exact field/line and what must change>

## What the deliver-oracle-writer must do next (only if REJECTED)
- <specific rewrite instruction; the replan dispatch is fresh — the writer receives the spec + this feedback, not its prior attempt's transcript>
```

The conductor parses only the frontmatter fields for routing. The markdown body explains the verdict for humans.
