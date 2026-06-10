# autoship → pi harness port

Salvaged from the `Calibrax-ai/autoship` repo (the Claude-Code-native delivery harness)
into a pi-coding-agent kit. The methodology (plan → spec → decompose → oracle →
implement → review → ui-walk → draft PR) is the prize; the Claude Code runtime coupling
is what we translate away.

**Source of truth:** `packages/core/.claude/{agents,skills}` in autoship.
**Target layout (deployed):** the runner installs `agents/` → `<clone>/.pi/agents/` and
`skills/<name>/` → `<clone>/.pi/skills/<name>/`. pi auto-discovers both
(`.pi/agents/**/*.md`, `.pi/skills/{name}/SKILL.md`). That makes every `.pi/...`
cross-reference a real resolvable path at runtime.

## Frontmatter translation (agents)

| autoship (Claude Code)              | pi-subagents                         | rule |
|-------------------------------------|--------------------------------------|------|
| `model: "opus[1m]"`                 | *(drop the pin)*                     | inherit the parent's `--model` (zai/glm-5.1). Re-pin per-agent later if GLM underperforms a gate. |
| `effort: high`                      | `thinking: high`                     | preserve the high-effort intent |
| `tools: Read, Glob, Grep, Bash, Write` | `tools: read, grep, find, ls, bash, edit, write` | lowercase; `Glob`→`find`, `Grep`→`grep`, add `ls`; keep `edit` only for agents that modify files |
| `permissionMode: bypassPermissions` | *(drop)*                            | not a pi agent field; permission is a runner/global concern |
| `maxTurns: 80`                      | *(drop)*                            | not a pi agent field |
| *(implicit Claude Task tool)*       | `tools: ..., subagent`               | **any agent that dispatches workers must list `subagent` explicitly** (conductor, and any agent that delegates) |
| `mcp__plugin_X__tool, ...`          | `tools: ..., mcp:X`                  | pi-mcp-adapter syntax; e.g. playwright tools → `mcp:playwright`, linear → `mcp:linear` |

Add `systemPromptMode: replace` to every ported agent — autoship agents are complete
operating manuals (full system prompts), and pi custom agents default to a clean slate.
Add `inheritProjectContext: true` so they still pick up the target repo's AGENTS.md/CLAUDE.md.

Reviewer/reader agents (no file writes): `tools: read, grep, find, ls, bash`.
Implementation agents (write code): add `edit, write`.

## Frontmatter translation (skills)

None needed — autoship's `SKILL.md` frontmatter is already `name` + `description`,
exactly what pi expects. **Drop `skill.yaml`** (Claude-specific manifest; pi reads
SKILL.md frontmatter and auto-discovers `references/` + `assets/` + `scripts/` in the
directory). Copy `references/`, `assets/`, `scripts/` verbatim.

## Body translation (Claude-isms → pi)

Apply to agent bodies AND skill bodies/references:

1. `.claude/agents/<x>.md`  → `.pi/agents/<x>.md`
2. `.claude/skills/<x>/`     → `.pi/skills/<x>/`
3. Tool names in prose: `Glob` → `find`, `Grep tool` → `grep`, `Bash tool` → `bash`,
   `Write tool` → `write`/`edit`, `Read tool` → `read`.
4. Model references in prose: `opus`, `opus[1m]`, "Claude" (as the model) → "the model"
   / the configured model. Don't rewrite "Claude Code" where it names the *tool* in a
   way that no longer applies — rephrase to pi or drop.
5. MCP tool names `mcp__plugin_linear_linear__*` / `mcp__plugin_playwright_playwright__*`
   in prose → the pi-mcp-adapter equivalent (`mcp:linear`, `mcp:playwright`) or the
   relevant CLI (`linear` CLI, `agent-browser`).
6. Leave methodology prose untouched — that's the salvage. Only translate runtime nouns.

## Deferred (not in this port — flagged for the owner)

- **The GLM capability question.** Every agent was tuned for opus+high-effort. Whether
  the generator-evaluator gates hold on glm-5.1 is the open empirical question; deferred
  by decision. First live run is the test.
- **Runner wiring.** This kit is the *content*. Pointing the runner at it (conductor as
  parent system-prompt vs. nestable subagent; copying `skills/` → `.pi/skills/`;
  switching the kit from `coding-default` to `autoship`) is a separate change.
- **Conductor-as-parent vs subagent.** autoship's conductor is the *top* orchestrator.
  In pi it's either the parent system prompt or a nestable subagent (`maxSubagentDepth`).
  Ported with `subagent` in its tools so either wiring works.
- **ui-walker browser MCP.** Mapped playwright MCP → `mcp:playwright`; the runner must
  load pi-mcp-adapter + a browser MCP for ui-walking to actually function.

## Rebrand (2026-06-09) — autoship → neutral "the harness"

The `autoship` brand was dropped (no product tie). "autoship" in source above still names
the SOURCE project (`Calibrax-ai/autoship`) — that's correct provenance, left as-is.
Inside `agents/` + `skills/`, the brand is fully neutralized:

- **Names:** `autoship-controller` → `conductor`; `autoship-audit` (skill) → `audit`.
  The `deliver-` / `audit-` / `ui-` prefixes are tracks, not brand — kept.
- **Prose:** standalone "autoship" → "the harness" (165 refs), grammar-repaired.
- **Vendored skills** (`test-driven-development`, `systematic-debugging`,
  `receiving-code-review`) are MIT-licensed copies of obra/superpowers (© Jesse Vincent).
  Attribution lines are preserved verbatim — do not strip them.

### Contracts the rebrand renamed — RECONCILE at wiring (these are not cosmetic)

The conductor assumes a set of names that must line up with Hatchery's real runner:

| Harness assumes | Hatchery's runner today | reconcile |
|---|---|---|
| `.harness/issues/<id>/handoff.json` cursor (+ spec/oracle/reviews) | runner writes nothing here; reads nothing here | runner must read the handoff cursor for routing/HITL, or the control loop is dead |
| branch `harness/<id>` | `runBranchName` → `hatchery/<slug>-<short>` | pick one convention; conductor + runner must agree |
| `HARNESS_*` config keys (was `AUTOSHIP_*`) | runner uses `HATCHERY_*` / `RUNNER_*` | map or drop |
| "Runner Handoff" JSON envelope in the prompt | runner sends `RunnerDispatchSchema` + callback | conductor's handoff expectations ≠ runner's dispatch shape |
| **OpenRouter** provider + `OPENROUTER_API_KEY`; reads tier→model from `.harness/defaults.yaml` `models:` | **DONE:** runner switched to `--provider openrouter --model z-ai/glm-5.1` — coding-default keeps GLM-5.1, just via OpenRouter, so the prod pipeline's behavior is unchanged and the blast-radius is neutralized. **Remaining:** (a) set `OPENROUTER_API_KEY` in the Trigger env — replaces the zai key; runs fail without it; (b) install the kit's `defaults.yaml` → `.harness/defaults.yaml`; (c) decide the delivery conductor's own parent model (still glm-5.1 — fine if it stays mechanical, may want a stronger agentic model). Note: customer-repo content now routes through OpenRouter to the model (data-path tradeoff, accepted). |

### Also at wiring time

- **Disable pi's builtin `oracle`** for this kit. The harness uses "oracle" to mean the
  frozen acceptance contract (281 refs); pi's builtin `oracle` agent means an advisory
  critic — opposite meaning, same word. `subagents.disableBuiltins` or
  `agentOverrides.oracle.disabled: true`.
- **Kit directory** is `agent-kits/delivery/` (a repo folder, not in any agent body).

## Customization (2026-06-09)

- **Model & effort are orchestrator-decided per dispatch** (Shyang's call), via **OpenRouter**
  so any model is reachable through one key. The conductor picks a **tier** (not a model from
  the full catalog) per job class and reads tier→model from `.harness/defaults.yaml` `models:`
  — see conductor § Model & effort selection. Worker frontmatter `thinking:` is now only a
  fallback default. The kit ships a baseline `defaults.yaml` mapping all tiers to **open
  weights**, one per tier matched to need: `gate`→`deepseek/deepseek-v4-pro` (reasoning),
  `default`→`moonshotai/kimi-k2.6` (coding/agentic), `mechanical`→`xiaomi/mimo-v2.5` (cheapest).
  GLM is out — better/cheaper open models exist (Shyang's call). **Consequence:** the whole
  pipeline — gates included — now runs on open weights, so the first run validates the
  generator-evaluator gates on DeepSeek, not Opus; if a gate underperforms, bump
  `models.gate` to `qwen/qwen3.7-max` or `anthropic/claude-opus-4.8`. **Slugs + prices are
  from OpenRouter's live catalog (2026-06-09); re-verify on openrouter.ai/models.**
- **Dispatch mechanism rewritten** — the conductor previously told workers to spawn via
  `claude --agent <worker> -p … | tee` (a Claude-CLI coupling the `.claude/` path-sweep
  missed; bare `claude` as a *command*). Now it dispatches via the pi **`subagent` tool**
  (conductor § Worker dispatch / § Dispatch shape). The conductor's `tools:` already
  includes `subagent`.
- ~~Still Claude-coupled, left intentionally: the `sessionId` / `claude --resume`
  paragraph.~~ **Resolved 2026-06-10** — removed in the handoff-cursor reconciliation
  (see below); `parked_question` survives as a cursor field.
## Reconciliation + trim (2026-06-10)

The conductor was reconciled to the simplified durability design in `TARGET-STATE.md`
(handoff cursor over git-as-truth) and stripped of dead autoship surface. Changes:

- **`manifest.json` → `handoff.json`** everywhere. The rich-manifest protocol (commit
  before+after every dispatch, `step_status` machine, `artifact_hashes`,
  `idempotency_keys`, pending-mutation writes) is gone. New rule: commit a step's
  artifact + updated cursor in one commit when the step completes; never commit a
  half-finished step. Cursor shape: `{ next, done, parked_question, pr_url,
  last_comment_id }` — a hint, not truth; state is derivable from which artifacts exist.
  Add fields back only when an observed failure demands it.
- **Dropped with the manifest:** legal-phase enum + `spec_ready`/`decomposition_proposed`
  alias rewriting; `calibration_outcome` telemetry block (telemetry-only, never gated
  routing — re-add only if the decomposition-calibration measurement is actually wanted);
  `session_id` / `claude --resume` paragraph (Claude-coupled vestige).
- **Dead autoship surface cut:** `materialize` compat alias (all 6 sites), retired
  `ingest`/`extract` and `standards draft` stop-messages, deprecated v0.2-key warnings
  (run-start + preflight), 0.3.x `-<slug>` branch-glob compat.
- **Unshipped doc pointers fixed:** the kit ships agents + skills only, but the conductor
  referenced `docs/architecture/*.md` + `docs/learnings.md` from autoship. The
  load-bearing one (audit-tracker-sync status→action mapping) is now inlined in audit
  step 8; the rest are cut. References section trimmed to kit-resolvable paths.
- **Model-allocation mindset (Shyang's call):** tiers are price-agnostic knobs, not a
  cost doctrine — no standing "frontier conductor + cheap gates" assumption; allocation
  is per-task and a hard task may justify expensive everything. `defaults.yaml` gained a
  `conductor:` tier (baseline `anthropic/claude-opus-4.8`; the runner reads it for the
  pi `--model`). The no-`models:`-block fallback now names literal slugs instead of
  "strongest model you know" (anti-hallucination). Per-dispatch model choice is recorded
  in `decisions.log` (was manifest step state).
- Net: 1,111 → 1,069 lines, and the heaviest per-turn protocol text replaced by the slim
  cursor rules. `TARGET-STATE.md` was de-contradicted in the same pass (diagram, gaps,
  risks no longer mention waitpoint/reaper/atomic commits).

## Rename: plan-coherent vocabulary (2026-06-10, after the grafts below)

Shyang's call — don't inherit autoship's Scrum vocabulary. Full sweep, no compat aliases
(nothing deployed): the planning agent authors the executable contract, it doesn't
"groom" a ticket for a human.

- `deliver-pre-groomer` → **`deliver-planner`**; phase `groom` → `plan`; `regroom` →
  `replan`; `max_regroom_cycles` → `max_replan_cycles`; `states.groom` → `states.plan`;
  CLI verb `groom` → `plan`; spec frontmatter `groomed-at` → `planned-at`, `trigger:
  first-groom|regroom` → `first-plan|replan`; skill dir `deliver-grooming/` →
  **`deliver-planning/`**; Linear comment "Grooming started." → "Planning started."
- `deliver-implementation` → **`deliver-implementer`** (role-noun consistency; the
  `implementation/` artifact paths and `implementation-outcome` enum are unchanged —
  only the agent name).
- `audit-auditor` → **`audit-assessor`** (artifact-aligned: writes `assessment.md`).

Historical sections of this file were swept too; where older text says planner/plan it
originally said pre-groomer/groom — this note is the record.

## Grafts from obra/superpowers + addyosmani/agent-skills (2026-06-10)

Two Opus miners compared both repos against the kit; both independently flagged the same
structural hole — **no generator-evaluator judge on the implementation diff** (only the
conductor's mechanical triple-run + hash gate). Grafted, with sources:

- **`agents/deliver-implementation-reviewer.md`** (NEW) — two-pass judge on the diff:
  spec compliance (do-not-trust-the-report, read the code) then code quality; runs after
  `implementation-passed`, before ui-walk/verification; skip-eligible under the same
  decision test as the oracle, with an inference record. Source: superpowers
  subagent-driven-development two-stage review + requesting-code-review rubric.
- **`agents/deliver-security-reviewer.md`** (NEW) — optional security lens fanned out in
  parallel with the implementation reviewer when the diff touches auth/input/secrets/
  network/uploads/LLM-I/O. Severity → binary verdict mapping (Critical/High block;
  Medium/Low/Info are graded notes). Source: addyosmani security-auditor (MIT), adapted.
- **Implementer self-review + concerns channel** — `deliver-implementer` now
  self-reviews before reporting and gained `implementation-passed-with-concerns` +
  `concerns:` frontmatter (always routes through the implementation reviewer). Source:
  superpowers implementer-prompt (DONE_WITH_CONCERNS).
- **Graded notes** — `reviewing` skill: non-blocking notes carry `[Medium]/[Low]/[Info]`;
  Critical/High can never be notes. Feeds the PR's Human Review Checklist in priority order.
- **`skills/systematic-debugging/find-polluter.sh`** — vendored verbatim from upstream
  superpowers (MIT © Jesse Vincent, same attribution as the rest of the skill); the
  diagnostic for the `test-suite-flaky` blocker. (Vendored-skill diff vs upstream: our
  three copies are byte-identical to current upstream — nothing else to pull.)
- **Decomposition rubric Check 6** — placeholder scan + cross-slice identifier-drift
  check. Source: superpowers plan-document-reviewer.
- **Context trust tiers** — conductor pre-inject discipline: trusted (repo source) /
  verify (config, fixtures, fetched docs) / untrusted (issue bodies, API responses,
  model output); instruction-like text in the lower tiers is data, never directives.
  Echoed in implementation/ui-walker/systematic-debugging red-flag rows. Source:
  addyosmani context-engineering.
- **`Authorization Boundaries`** spec-template block (ask-first ACTIONS: new dep, schema
  migration, auth change, external service, destructive data op) + spec-review Check 3
  bullet enforcing it. Maps to Needs Attention parks in the unattended path. Source:
  addyosmani spec-driven-development "Boundaries", narrowed (file-level Ask-first
  already existed in Scope Fence).
- **Red-flags / rationalization tables** on deliver-implementer and ui-walker
  (superpowers house style — the-thought-that-precedes-the-violation).
- Also swept the remaining unshipped `docs/architecture/*` references out of the
  decomposition rubric/template/reviewer and planning skill (same bug class as the
  conductor's, fixed in the reconciliation pass).

Deliberately NOT grafted: doubt-driven-development (third review mechanism — revisit
after Step-1 evidence), performance lens (no perf-shaped issues yet),
source-driven-development + SDD cache hook (until doc-fetch volume is real), all
HITL-shaped skills (brainstorming/interview/idea-refine — dead on a headless runner),
and both repos' orchestration models (peer/user-orchestrated — our asymmetric
single-conductor star is stronger for a gated pipeline).

- **Dispatch modes & topology grafted from OpenSwarm** (conductor § Dispatch modes & topology).
  Two modes: *single-owner hand-off* (default; one worker owns the sub-task, conductor still
  gates on return) and *fan-out + synthesize* (≥2 independent workers in parallel via the
  `subagent` tool's `tasks` mode + `worktree: true`). Asymmetric topology: only the conductor
  has the `subagent` tool, so only it fans out; mis-dispatched workers return to the conductor
  rather than peer-transfer. **Adapted, not copied:** OpenSwarm's Handoff is transfer-and-*exit*
  (router leaves); our gated conductor can't exit, and recovery is hub-routed not a peer mesh —
  a gated pipeline must funnel every recovery through one gatekeeper or a misroute skips a gate.

## gated_dispatch extension (2026-06-10) — the gate as a mechanism

`extensions/gated-dispatch.ts` — a pi extension registering the `gated_dispatch` tool:
the generator→review→replan loop in code instead of conductor prompt discipline. Fresh
generator child per cycle (spawned `pi --mode json -p --no-session`, agent resolved from
`.pi/agents/`, flags mirrored from pi-subagents' arg builder), optional mechanical
`prepare` commands between legs, matching reviewers in parallel (ANY reject loops),
verdict parsed from the review ARTIFACT frontmatter (never chat text), append-only
review-NN numbering, one typed outcome: `approved | rejected-beyond-cycles |
malformed-verdict | missing-artifact | generator-error | reviewer-error | prepare-error`.

- **Dependency-free by design**: hand-written JSON-schema params (no typebox import),
  type-only pi import, own minimal frontmatter parser — loads under jiti from any target
  repo with zero resolution risk. pi-subagents exposes no public API (no `exports` in
  package.json), so nothing is imported from it — its arg/spawn conventions were
  mirrored, not depended on.
- **Verified**: helper functions unit-tested via bun (frontmatter parse, NN increment,
  objection extraction, thinking suffix); live-load test `pi -e extensions/gated-dispatch.ts
  -p "...gated_dispatch available?"` → "Yes." on pi 0.78.0.
- **Wiring**: runner installs `extensions/` → `<clone>/.pi/extensions/` (pi
  auto-discovers; local Step-1 runs get it the same way, or via `-e`). Conductor
  frontmatter `tools:` now lists `gated_dispatch`; if the runner restricts parent tools
  via `--tools`, include it there. Workers never list it (asymmetric star holds — the
  gate spawns workers via their `--tools` from frontmatter, minus subagent/gated_dispatch).
- **Doctrine note**: this moves gate MECHANICS (route, parse, loop, count) into code;
  judgment stays in reviewers; the conductor keeps goal-state diff, enum walk on the
  approved artifact, model-tier choice, park decisions. Chain remains forbidden as
  backbone. Prior art checked: pi-subagents' `review-loop.md` is a prompt telling the
  parent to do this manually — no upstream mechanism existed.
- **Upstream candidate**: genuinely generic (nothing harness-specific in the tool) —
  could be PR'd to pi-subagents or published as a pi-package later.

### gated_dispatch addendum: `generator_context: fresh | warm` (2026-06-10)

Shyang's question — "are we just chaining? should the planner's session pause/resume so
the reviewer's feedback lands in warm context?" — resolved as a knob, not a rewrite:

- Not chaining (chain = ungated piping; the gate = verdict-conditional bounded loop) and
  not free agent-to-agent messaging (the reviewer never addresses the generator; the
  verdict artifact is parsed by code, which decides what flows back — the mechanical
  chaperone IS the gate).
- Warm resume needs no live processes or pausing: pi sessions are files. Verified live:
  `pi -p --session <file>` carries conversation context across separate spawns.
- `generator_context: "warm"` makes replan cycles resume the generator's own gate-scoped
  session (objections arrive as the next message; exploration not re-paid). Default
  stays `"fresh"` — the kit's anti-anchoring doctrine ("fresh dispatch forces a real
  rewrite") — and reviewers are ALWAYS fresh. Fresh-vs-warm is an empirical question for
  Step 1: compare cycles-to-approve and approval quality per gate. Session file is
  deleted when the gate returns; durability remains git-as-truth.

## Step 2 runner wiring (2026-06-10)

`trigger/run-coding-task.ts` gained `runDelivery()`, gated on `d.kit === 'delivery'`
(coding-default path untouched). Shape: deterministic `harness/<id>` branch with
resume-from-remote (`ls-remote` → fetch+checkout if a crashed run left it), kit install
(`agents/skills/extensions` → `.pi/`, kit `defaults.yaml` → `.harness/defaults.yaml`
unless the repo ships one; ledger committable, `.pi//runs/worktrees/defaults` excluded),
conductor-as-parent (`--system-prompt` = frontmatter-stripped conductor.md written into
`.pi/`, model = `openrouter/` + `models.conductor` tier), Runner Handoff JSON envelope +
binding environment contract in the prompt (work in place, commit as you go, no
push/PR/tracker), parked-question + feedback re-injection on continuation, 40-min
timeout. Outcome-trust gate: clean `git status --porcelain` REQUIRED (the Phase-3
uncommitted-fix finding, now enforced in code), cursor read for park routing. Push +
draft PR are RUNNER-owned (v1 hybrid — keeps the GH token out of the agent env; PR body
= the conductor's outcome announcement, `[Blocked]` prefix when parked). Also: `draft`
support added to `openOrUpdatePullRequest`, `pr.md` artifact removed from the kit (the
cursor's `pr_url` + PR-by-branch lookup replaced it), both kits in `additionalFiles`.
Tests: 6 new helper tests (deliveryBranchName/deliveryIssueId/stripFrontmatter/
conductorModelFromDefaults), 21/21 pass, typecheck clean.
Prereqs to go live: control plane sends `kit: 'delivery'` + per-issue concurrencyKey on
the trigger call; `OPENROUTER_API_KEY` in the Trigger env.

## Rename: delivery → harness (2026-06-11)

The kit value and directory are now `harness`, matching the vocabulary the kit already used
everywhere else (`.harness/`, `harness/<id>` branches, `defaults.yaml` location). "delivery" was
the last autoship-era name standing. Same change flips `DEFAULT_KIT` to `harness` — this kit is
now the default execution path; `coding-default` is legacy, scheduled for deletion once the
harness kit has real-run mileage. Prose below this section predates the rename and says
"delivery kit" — read it as this kit.
