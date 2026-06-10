---
issue: <id>
issue-rev: <short hash or timestamp of issue body at time of plan>
planned-at: <ISO timestamp>
trigger: first-plan | replan
artifact: spec
conductor-status: ready | need-info
type: Bug | Feature | Refactor
# Bug only:
reproduction-status: confirmed | cannot-reproduce | need-info
# Feature only:
design-status: drafted | need-info
# Refactor only:
preservation-status: ready | needs-coverage-first | need-info
# `conductor-status` is for conductor routing:
# - ready when downstream review/build can continue
# - need-info when the issue must park in Needs Attention
# The type-specific status enums above are strictly binary/ternary — no other values are valid.
# Do not invent `ready`, `proposed`, `in-progress`, or any other label for the type-specific fields.
---

# Outcome
<one-line user-visible result; for Refactor, one-line description of the structural improvement>

# Acceptance Criteria
- AC1 — <observable predicate>. Verification: `<runnable command>`
- AC2 — ...

# Scope Fence
Always-touch:  <specific files>
Ask-first:     <specific files>
Never-touch:   <specific files or patterns>

# Authorization Boundaries          [optional — include when the build could plausibly cross one]
Ask-first actions — if the implementation turns out to require one of these, the conductor
parks at Needs Attention instead of proceeding:
- <e.g. new runtime dependency | DB schema migration | auth/permission change | new external service call | destructive data operation | spend/quota change>

# Rabbit-Hole Patches
- "<question an executor would otherwise guess>" — <answer with reason>

# Assumptions                       [optional — omit if none]
- <product / business judgment the planner made on its own that a human might want to override at the Ready→Building gate>
- ...

# Blast-Radius Manifest
Expected to create:  <new files>
Expected to change:  <existing files>
May change:          <existing files>
Must not change:     <existing files or patterns>

# Skeleton Position
<single-slice: first | N+1, following pattern at file:line>
OR
<multi-slice: oracle-plan decomposes into N steps; each step follows <pattern>>

# Concrete Example
<input → output, evidence snippet, or before/after code>

# Intended Layout                  [Frontend/UI only]
<concise ASCII sketch of the main screen, panel, or component arrangement; expose hierarchy, navigation, tab/sidebar placement, empty states, and primary actions>

# External Library Claims          [optional — include when spec relies on third-party behavior]
<every claim about how an external library, framework, runtime, browser, OS, or third-party service behaves — anything not in the testbed's own source tree. Each entry must cite a primary source the reviewer can verify cheaply.>
- "<exact claim about external behavior the spec relies on>"
  Source: <one of: docs URL with anchor | `file:line` in node_modules / vendored source | executable probe command + expected output>
- "<next claim>"
  Source: <...>

# Failure Modes                    [optional — include when runtime risk exists]
<bulleted list of failure scenarios the change must handle or explicitly defer>

# Reproduction Steps               [Bug only]
Command:   <the exact command you ran>
Observed:  <what came back>
Expected:  <what the issue says should happen>

# Root Cause                       [Bug only]
<file:line> — quote the offending snippet
<causal chain: why this produces the observed symptom>

# Design Rationale                 [Feature required; Refactor optional]
## Alternatives
- **A**: <description>. Cost: <cost>. Fit: <cite file:line>. Tradeoff: <wins/loses>.
- **B**: ...

## Picked + Reason
<A | B>. Reason: <why, citing simplicity + fit>.

## Constraints                     [when runtime/infra shape]
## Migration Plan                  [when schema changes]
## Backward Compatibility          [when changing APIs or data]
## Rollback Plan                   [when risky]
## Schema Diff                     [when DB change]
## Deferred                        [always optional]

# Behavior Preservation            [Refactor only]
## What must be preserved
- Observable:    <API responses, DB state, events, side effects>
- Non-observable: <performance, ordering, concurrency>

## Preservation Proof
Executable behavior evidence:
  - Command: `<runnable command that exercises preserved behavior>`
    Files:
      - <test file, fixture, or evidence artifact>
    Claims: <preserved behaviors this evidence covers>
Coverage gaps (require regression tests BEFORE refactor lands):
  - <behavior not currently tested> — test to add: <file + name>
  - ...
Verification: `<all behavior evidence commands plus supporting validation>`

## Structure Improvement
Before:      <current shape>
After:       <target shape>
Axis:        <coupling | readability | testability | complexity | performance | security>
Measurable:  <metric or criterion for "done">
