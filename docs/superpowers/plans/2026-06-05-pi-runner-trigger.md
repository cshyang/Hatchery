# Pi Runner on Trigger.dev — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the coding **runner** so the loop closes end-to-end — `Linear "Run Agent" issue → Hatchery → Trigger.dev task → pi-coding-agent → PR → callback → minimal Linear reply`. Once this works, the continuation path already built (comment → continuation run) rides the same runner unchanged.

**Architecture:** The runner is a **Trigger.dev task** (durable, long-running, no default timeout) living in this repo as a `trigger/` package, deployed separately (`npx trigger.dev deploy`) from the Cloudflare worker. It runs `pi` (`@earendil-works/pi-coding-agent`) + `agent-kits/coding-default`. **Hatchery stays the source of truth** for run state (`agent_runs`); Trigger only *executes* and is referenced by a foreign `trigger_run_id`. Git branch = code truth; workspace = disposable (M0), drift-safe reuse optional later.

**Tech Stack:** TypeScript; Hatchery on Cloudflare Workers + D1; runner on Trigger.dev (`@trigger.dev/sdk`); `pi-coding-agent` CLI; `valibot` for the shared contract; `tsx` tests.

---

## ⚠️ Scope, Definition of Done, Decisions — READ FIRST

**This plan details M0a + M0b + the shared contract in full. M0c–M0f are outlined as follow-on milestones** (each becomes its own plan when reached) — per the writing-plans rule that a plan should ship one self-contained, testable slice.

**Definition of Done for this plan (M0a+M0b):** a real Linear "Run Agent" issue on **our own repo** produces a Trigger.dev run that clones, runs `pi`, opens a PR, and Hatchery shows the run `completed` with a Linear comment "PR opened: <url>". Verified live (Trigger tasks run in their runtime — the kill-test is the integration test; pure helpers are unit-tested).

**Locked decisions (from review):**
1. **Trigger = host, not truth.** `agent_runs.status` is the lifecycle; store Trigger's id as `trigger_run_id` (foreign execution id). [tasks-overview]
2. **Always set `maxDuration`** (seconds). Default ~2700s (45 min) — well under Hatchery's 3h `RUNNING_STALE_MS` reaper, because **on a maxDuration kill, `onFailure`/cleanup do NOT run** so the task can't self-report the timeout; the reaper closes it. [runs/max-duration]
3. **Keep Hatchery's outbox** — it just dispatches to Trigger instead of a raw HTTP URL, via an **idempotency key = `runId`**. [idempotency]
4. **GitHub auth:** M0b pushes with an **explicitly-temporary repo-scoped PAT** (env `RUNNER_GITHUB_PAT_TEMP`, marked TODO); **M0c** replaces it with GitHub App installation-token minting. Do NOT pretend Nango provides this.
5. **`local` WorkspaceProvider = OUR repo only.** Running `pi` + arbitrary repo tests in the Trigger container is unsafe for untrusted repos — **M0d (E2B) is mandatory before any non-our repo.**
6. **Git branch = truth; workspace = fresh clone in M0**; `workspacePolicy: "fresh" | "reuse_if_head_matches"` is in the contract but only `fresh` is implemented now.
7. **Minimal reply in M0b** (3 Linear comments: started / PR opened / failed) — NOT the full notification sweep (that's M0f).
8. **Contract uses `valibot` + `contractVersion`** (decided 2026-06-06). valibot is already resolved in the dependency tree (via `@flue/runtime`/`@flue/cli`), so the contract adds **no new dependency** — preferred over zod for that reason. Note: there is no first-party valibot usage in `src/` to mirror, so write clean valibot v1 schemas (`v.parse(Schema, x)`, `v.optional(x, default)`, `v.picklist([...])`, `v.pipe(v.string(), v.minLength(1))`).

**Preconditions — audited 2026-06-06 against primary sources (✅ confirmed / ⚠️ caveat / ❌ missing):**
- **Trigger.dev** — ✅ `@trigger.dev/sdk` `tasks.trigger()` runs in a Worker *if* you use a **type-only** import of the task (so task code isn't bundled into workerd), OR ✅ call REST `POST /api/v1/tasks/{taskIdentifier}/trigger` via `fetch` (the plan's path — avoids bundling). ✅ `defineConfig({ project, dirs, maxDuration })` field names correct; `maxDuration` in **seconds**, settable as a top-level default and a per-task override. ✅ a `maxDuration` kill skips `cleanup`/`onSuccess`/`onFailure` (so the run-fn `finally` is also unreliable on a hard kill → reaper backstop justified). ❌ **No Trigger project ref exists** — must create a project and supply its `project` ref. A `tr_dev_` key is present in `.dev.vars` (enough for a local `trigger:dev` M0a verify); a `tr_prod_` key is only needed at `deploy`. **Gates M0a.**
- **pi CLI** — ✅ installed (`@earendil-works/pi-coding-agent`, bin `pi`; `0.78.1` is `latest`, local is `0.78.0` — pin/install `0.78.1` in the container). Non-interactive = `pi -p --mode json`. ⚠️ **no `--cwd` flag** → set cwd on the spawned process. Skills → `--skill <path>` (repeatable); policy → `--append-system-prompt "$(cat policy.md)"` (literal text, **not** a path); task prompt via **stdin or `@file`**. ✅ **Model = GLM-5.1 via Z.ai** (matches the user's `~/.pi/agent/settings.json`): `--provider zai --model glm-5.1` (native provider; OpenAI-completions transport against pi's hardcoded `https://api.z.ai/api/coding/paas/v4`). **The only credential is `ZAI_API_KEY`** (verified `pi-ai/dist/env-api-keys.js:106`) — runner-container precondition. **Do NOT set `ZAI_BASE_URL`** (pi ignores it; the shell's `…/api/anthropic` value is for Claude Code). Optionally `--thinking high` to match the user's default. ✅ pi does **not** commit (it edits the working tree) → the task does git add/commit/push. **Gates M0b's pi step.** LIVE-confirm: `pi -p` exit code on failure, and no `/login` hang in a TTY-less container.
- **pi has no sub-agents / no native "kit" concept** — ⚠️ the `coding-default` kit's `agents/*.md` (scout/planner/worker/reviewer/oracle) describe a loop a single `pi -p` does **not** run. Per `docs/planning/agent-kits-pi-runner.md` the **runner** orchestrates the loop (pi is the single-shot primitive called per role). **M0b is therefore scoped to a single pi pass** (policy + skills + worker/task prompt) to prove clone→pi→PR→callback; the faithful multi-role loop is a **follow-on milestone**. (Surface this scoping — if the full loop is wanted inside M0b, that expands M0b materially.) Concrete path for the follow-on: the user already runs the loop interactively via a `pi-subagents` package + `~/.pi/agents/*.md` — the container would need that package installed and the agent personas shipped to reproduce it; the runner then drives the sub-agent flow rather than orchestrating raw `pi -p` calls per role.
- **Linear comment-write** — required scope `comments:create` (or broad `write`); a `read`-only token is rejected. ⚠️ **Cannot confirm from code**: the repo declares no scope in code (Nango-dashboard-configured) and makes **no** Linear API calls today (`postLinearComment` is greenfield). User must check the live Linear connection's *granted* scopes in the Nango dashboard and re-consent if `comments:create`/`write` is absent. **Gates only M0b Task B4.**
- **GitHub auth (M0b)** — still the explicitly-temporary `RUNNER_GITHUB_PAT_TEMP` (repo-scoped: Contents RW + Pull requests RW). Wire it into the `Env` interface at `.flue/app.ts` alongside `TRIGGER_*`.

---

## Architecture & Boundary

```
Linear/Slack ─► Hatchery (Cloudflare)                         OWNS: run state, idempotency,
                 • agent_runs ledger (+ trigger_run_id)              dispatch attempts, reply target,
                 • thin outbox  ──tasks.trigger(idempotencyKey=runId)──┐    callback acceptance
                       ▲                                               │
                       │ callbacks (running/pr_opened/completed/failed)│
                       │                                               ▼
                 Trigger.dev task "run-coding-task"   OWNS: execution, logs, long compute,
                  • maxDuration cap                          retry/cancel dashboard
                  • WorkspaceProvider.clone (fresh)
                  • run pi + agent-kits  → edits/tests
                  • commit → push → open/update PR (temp PAT → App token)
                  • POST callbacks to Hatchery
                       ▼
                 Hatchery posts the minimal Linear reply  (owns Linear token; runner has none)
```

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/agent-runs/runner-contract.ts` | **New.** valibot `RunnerDispatchSchema` + `RunnerCallbackSchema` + `RUNNER_CONTRACT_VERSION`. Imported by Hatchery producer AND the Trigger task. | Create |
| `src/agent-runs/runner-contract.test.ts` | **New.** The linchpin contract test (producer output parses; callback parses; `handleAgentRunCallback` accepts it). | Create |
| `migrations/0015_agent_run_trigger_id.sql` | **New.** `ALTER TABLE agent_runs ADD COLUMN trigger_run_id TEXT;` | Create |
| `src/agent-runs/repository.ts` | Add `trigger_run_id` to types/SELECT/row map + `updateAgentRun` input. | Modify |
| `src/agent-runs/dispatch.ts` | Replace `postToRunner` (HTTP) with `triggerCodingTask` (Trigger SDK or REST), store `triggerRunId`. Keep claim/requeue/reconcile. | Modify |
| `trigger/trigger.config.ts` | **New.** Trigger project config (project ref, default `maxDuration`, dirs). | Create |
| `trigger/run-coding-task.ts` | **New.** The `run-coding-task` task. M0a: no-op (callback round-trip). M0b: clone→pi→PR. | Create |
| `trigger/workspace/provider.ts` | **New.** `WorkspaceProvider` interface + `localWorkspace` impl (M0b). | Create |
| `trigger/github.ts` | **New.** push branch + open/update PR via GitHub REST (token from payload). | Create |
| `src/agent-runs/linear-reply.ts` | **New (M0b).** `postLinearComment` via Nango `fetchToken('linear')`; called from the callback handler on running/pr_opened/failed. | Create |
| `package.json` | Add `@trigger.dev/sdk` (valibot already present); add `trigger:dev`/`trigger:deploy` scripts; wire new tests into `npm test`. | Modify |

---

## Cross-cutting Task C1: Shared contract (the linchpin)

**Files:** Create `src/agent-runs/runner-contract.ts`, `src/agent-runs/runner-contract.test.ts`. (`valibot` already in `package.json` — no install.)

- [ ] **Step 1: valibot.** Already resolved in the tree (via `@flue/*`); confirm `valibot` is in `package.json` `dependencies` (it is, `^1.4.1`). No install needed.

- [ ] **Step 2: Write the contract** `src/agent-runs/runner-contract.ts`:
```ts
import * as v from 'valibot';

export const RUNNER_CONTRACT_VERSION = 1 as const;

export const RunnerDispatchSchema = v.object({
  contractVersion: v.literal(RUNNER_CONTRACT_VERSION),
  runId: v.pipe(v.string(), v.minLength(1)),
  projectId: v.pipe(v.string(), v.minLength(1)),
  mode: v.picklist(['initial', 'continuation']),
  targetRepo: v.pipe(v.string(), v.minLength(1)),     // https://github.com/owner/repo
  baseBranch: v.pipe(v.string(), v.minLength(1)),
  targetBranch: v.nullable(v.pipe(v.string(), v.minLength(1))),   // null = initial; non-empty PR branch = continuation
  kit: v.pipe(v.string(), v.minLength(1)),
  runtime: v.literal('pi'),
  sandboxProvider: v.picklist(['local', 'e2b']),
  workspacePolicy: v.optional(v.picklist(['fresh', 'reuse_if_head_matches']), 'fresh'),
  issue: v.nullable(v.object({ id: v.string(), identifier: v.string(), url: v.string(), title: v.string(), description: v.nullable(v.string()) })),
  feedback: v.nullable(v.string()),                    // the human comment (continuation)
  prUrl: v.nullable(v.string()),
  replyTarget: v.nullable(v.object({ surface: v.picklist(['linear', 'github']), ref: v.string() })),
  githubToken: v.pipe(v.string(), v.minLength(1)),     // short-lived, repo-scoped (temp PAT M0b → App token M0c)
  callback: v.object({ url: v.pipe(v.string(), v.url()), token: v.pipe(v.string(), v.minLength(1)) }),
});
export type RunnerDispatch = v.InferOutput<typeof RunnerDispatchSchema>;

// Mirrors the EXISTING handleAgentRunCallback body (running/pr_opened/completed/failed subset).
export const RunnerCallbackSchema = v.object({
  contractVersion: v.literal(RUNNER_CONTRACT_VERSION),
  runId: v.pipe(v.string(), v.minLength(1)),
  status: v.picklist(['running', 'pr_opened', 'completed', 'failed']),
  branch: v.optional(v.nullable(v.string())),     // accept null|undefined — cross-service JSON boundary
  commitSha: v.optional(v.nullable(v.string())),
  prUrl: v.optional(v.nullable(v.string())),
  summary: v.optional(v.nullable(v.string())),
  error: v.optional(v.nullable(v.string())),
});
export type RunnerCallback = v.InferOutput<typeof RunnerCallbackSchema>;
```

- [ ] **Step 3: Write the failing contract test** `runner-contract.test.ts` — assert a representative dispatch + callback parse, and that an unknown `contractVersion` is rejected:
```ts
import assert from 'node:assert/strict';
import * as v from 'valibot';
import { createTestRunner } from '../shared/test-utils';
import { RunnerDispatchSchema, RunnerCallbackSchema, RUNNER_CONTRACT_VERSION } from './runner-contract';

const { test, run } = createTestRunner();

test('a continuation dispatch parses against the contract', () => {
  const d = v.parse(RunnerDispatchSchema, {
    contractVersion: RUNNER_CONTRACT_VERSION, runId: 'r1', projectId: 'p1', mode: 'continuation',
    targetRepo: 'https://github.com/o/r', baseBranch: 'main', targetBranch: 'hatchery/eng-1',
    kit: 'coding-default', runtime: 'pi', sandboxProvider: 'local',
    issue: null, feedback: 'use authGuard()', prUrl: 'https://github.com/o/r/pull/5',
    replyTarget: { surface: 'linear', ref: 'ISSUE-1' }, githubToken: 'ghp_x',
    callback: { url: 'https://h.dev/__internal/agent-runs', token: 't' },
  });
  assert.equal(d.workspacePolicy, 'fresh'); // default applied
});

test('a runner callback parses against the contract', () => {
  const c = v.parse(RunnerCallbackSchema, { contractVersion: RUNNER_CONTRACT_VERSION, runId: 'r1', status: 'pr_opened', prUrl: 'https://github.com/o/r/pull/5' });
  assert.equal(c.status, 'pr_opened');
});

test('a wrong contractVersion is rejected', () => {
  assert.throws(() => v.parse(RunnerDispatchSchema, { contractVersion: 999 } as any));
});

await run();
```

- [ ] **Step 4: Run** `npx tsx src/agent-runs/runner-contract.test.ts` → PASS. Add it to `package.json` `test`.

- [ ] **Step 5: Commit** `feat: shared runner dispatch/callback contract (valibot, versioned)`.

> The producer↔contract↔consumer assertions (Hatchery's `buildRunnerDispatch` output parses; the runner's callback parses; `handleAgentRunCallback` accepts it) are added in M0a Task A2 and M0b, once those exist.

---

## Milestone M0a — Outbox → Trigger → callback (no Pi)

Prove the pipe: a queued run dispatches to a Trigger task that immediately callbacks `running` then `completed`. No coding yet.

### Task A1: `trigger_run_id` column + repository plumbing
**Files:** Create `migrations/0015_agent_run_trigger_id.sql`; Modify `src/agent-runs/repository.ts`; Test `src/agent-runs/agent-runs.test.ts`.

- [ ] **Step 1: Migration** `0015_agent_run_trigger_id.sql`:
```sql
ALTER TABLE agent_runs ADD COLUMN trigger_run_id TEXT;
```
- [ ] **Step 2: Failing test** in `agent-runs.test.ts`: `updateAgentRun({ id, triggerRunId: 'run_abc' })` persists and `getAgentRunById` returns `triggerRunId: 'run_abc'`.
- [ ] **Step 3: Plumb** `repository.ts`: add `triggerRunId: string | null` to `AgentRun`/`AgentRunRow`/`rowToAgentRun`, add `trigger_run_id` to `AGENT_RUN_SELECT` and the INSERT (default null), and add `triggerRunId?` to `updateAgentRun`'s input + its `UPDATE ... SET trigger_run_id=?` (COALESCE-style: `input.triggerRunId === undefined ? current.triggerRunId : normalizeText(input.triggerRunId)`). Extend the test `FakeD1` for the new column.
- [ ] **Step 4: Run** `npx tsx src/agent-runs/agent-runs.test.ts` → PASS. **Step 5: Commit** `feat: agent_runs.trigger_run_id (foreign execution id)`.

### Task A2: Outbox dispatches to Trigger
**Files:** Modify `src/agent-runs/dispatch.ts`; add a `buildRunnerDispatch`; Test `src/agent-runs/dispatch.test.ts` (or `agent-runs` test file).

- [ ] **Step 1:** Add `buildRunnerDispatch(run, deps): RunnerDispatch` — assembles the contract object from the run's stored `dispatchPayload` + `runId`/`projectId` + `githubToken` (from `deps.githubToken`, the temp PAT for now) + `callback` ({url: deps.hatcheryPublicUrl + '/__internal/agent-runs', token: deps.runnerToken}) + `contractVersion`. **Validate with `v.parse(RunnerDispatchSchema, ...)` before returning** (this is the producer↔contract assertion).
- [ ] **Step 2:** Replace `postToRunner` with `triggerCodingTask(deps, dispatch)`:
```ts
// POST Trigger's REST trigger endpoint via fetch (avoids bundling the SDK into the Worker).
// Path + body + response shape confirmed against Trigger REST API version 2024-04 (audited 2026-06-06).
// Returns the Trigger run id to store as trigger_run_id.
async function triggerCodingTask(deps, dispatch): Promise<{ triggerRunId: string }> {
  const res = await fetchWithTimeout(
    `${deps.triggerApiUrl}/api/v1/tasks/run-coding-task/trigger`,
    { method: 'POST',
      headers: { authorization: `Bearer ${deps.triggerSecretKey}`, 'content-type': 'application/json' },
      // ⚠️ idempotencyKey goes in body.options — NOT an HTTP header (an `idempotency-key` header is silently ignored).
      body: JSON.stringify({ payload: dispatch, options: { idempotencyKey: dispatch.runId } }) },
    { timeoutMs: RUNNER_FETCH_TIMEOUT_MS, failurePrefix: 'trigger dispatch failed', fetchImpl: deps.fetch },
  );
  // 5xx/429/network → retryable (RunnerDispatchError); 4xx → fatal. (Same mapping as before.)
  const body = await res.json();
  return { triggerRunId: body.id };   // response run id is top-level `id` (confirmed)
}
```
> Path `POST /api/v1/tasks/{taskIdentifier}/trigger`, `Authorization: Bearer <secret>`, body `{ payload, options }`, response `{ id }` — all confirmed against API version `2024-04`. **`options.idempotencyKey = runId` makes redelivery safe** (the earlier header form did nothing). [idempotency]
- [ ] **Step 3:** In `dispatchClaimedRun`, on success store `triggerRunId` (`updateAgentRun({ id, status: 'running', triggerRunId })`). Keep the transient→requeue / cap→failed logic unchanged.
- [ ] **Step 4:** Update `dispatch.test.ts` to stub the trigger HTTP and assert: success → run `running` + `trigger_run_id` set; 5xx → requeued; 4xx → failed. **Step 5: Commit** `feat: outbox dispatches coding runs to Trigger.dev`.

### Task A3: The no-op Trigger task + config
**Files:** Create `trigger/trigger.config.ts`, `trigger/run-coding-task.ts`; Modify `package.json` (deps + scripts).

- [ ] **Step 1:** `npm i @trigger.dev/sdk`. Add scripts: `"trigger:dev": "trigger.dev dev"`, `"trigger:deploy": "trigger.dev deploy"`.
- [ ] **Step 2:** `trigger/trigger.config.ts` — `defineConfig({ project: 'proj_vmlezgoianzbhanptfog', dirs: ['./trigger'], maxDuration: 2700 })`. (Field names confirmed against SDK 2026-06-06; `maxDuration` in seconds.)
- [ ] **Step 3:** `trigger/run-coding-task.ts` — the task, M0a no-op body:
```ts
import { task } from '@trigger.dev/sdk';
import * as v from 'valibot';
import { RunnerDispatchSchema, RUNNER_CONTRACT_VERSION, type RunnerCallback } from '../src/agent-runs/runner-contract';

async function callback(d: { callback: { url: string; token: string } }, body: RunnerCallback) {
  await fetch(d.callback.url, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hatchery-agent-runner-token': d.callback.token },
    body: JSON.stringify(body) });
}

export const runCodingTask = task({
  id: 'run-coding-task',
  maxDuration: 2700, // 45 min; reaper (3h) is backstop. maxDuration kill skips onFailure — see plan.
  run: async (raw) => {
    const d = v.parse(RunnerDispatchSchema, raw);              // consumer↔contract assertion
    await callback(d, { contractVersion: RUNNER_CONTRACT_VERSION, runId: d.runId, status: 'running' });
    // M0a: prove the pipe only.
    await callback(d, { contractVersion: RUNNER_CONTRACT_VERSION, runId: d.runId, status: 'completed', summary: 'pipe ok (no pi yet)' });
    return { ok: true };
  },
});
```
- [ ] **Step 4 (verify — live):** set `TRIGGER_SECRET_KEY` + Hatchery env (`TRIGGER_*`, `RUNNER_GITHUB_PAT_TEMP` placeholder), `npm run trigger:dev`, deploy Hatchery, fire one run. **Expected:** `agent_runs` goes `queued→running→completed`, `trigger_run_id` set, Trigger dashboard shows the run. **Step 5: Commit** `feat: run-coding-task (M0a pipe)`.

---

## Milestone M0b — Trigger task → local clone → Pi → PR → callback + minimal reply (OUR repo only)

### Task B1: WorkspaceProvider + local impl
**Files:** Create `trigger/workspace/provider.ts`.
- [ ] Interface + `localWorkspace` (clones into an OS temp dir on the Trigger container; **fresh only**):
```ts
export interface Workspace { dir: string; cleanup(): Promise<void>; }
export interface WorkspaceProvider {
  // policy honored later; M0 always fresh-clones targetBranch ?? baseBranch.
  acquire(opts: { repo: string; baseBranch: string; targetBranch: string | null; githubToken: string; policy: 'fresh' | 'reuse_if_head_matches' }): Promise<Workspace>;
}
export const localWorkspace: WorkspaceProvider = { /* git clone --depth … with token; checkout targetBranch if set; return {dir, cleanup: rm -rf} */ };
```
- [ ] Unit-test the URL/token construction + checkout-branch selection (pure parts). Commit `feat: local WorkspaceProvider (our-repo dogfood only)`.

### Task B2: GitHub push/PR helper
**Files:** Create `trigger/github.ts`. Push the branch and open-or-update a PR via the **GitHub REST API** (token from payload — no `gh` CLI dependency in the container). For continuation (`targetBranch` set) a PR already exists → just push (PR updates). Commit `feat: github push + open/update PR (REST, token from payload)`.

### Task B3: Real task body (clone → pi → commit → push → PR → callbacks)
**Files:** Modify `trigger/run-coding-task.ts`.

**Scope:** M0b runs a **single pi pass** (policy + skills + the task prompt) — enough to prove clone→pi→PR→callback. The full scout→planner→worker→reviewer→oracle loop (runner drives pi per role) is a **follow-on milestone**, not M0b.

- [ ] `run`: parse → callback `running` → `acquire` workspace → run `pi` as a child process **with cwd = workspace `dir`** (pi has no `--cwd` flag), invocation (audited 2026-06-06):
```bash
# prompt = feedback (continuation) else issue body, fed via stdin
cat "$PROMPT_FILE" | pi -p --mode json \
  --provider zai --model glm-5.1 \                           # GLM-5.1 via Z.ai (native provider, hardcoded endpoint)
  --thinking high \                                          # matches the user's ~/.pi default (optional)
  --no-session \                                             # ephemeral; don't write ~/.pi
  --skill agent-kits/coding-default/skills/test-evidence.md \
  --skill agent-kits/coding-default/skills/pr-summary.md \
  --append-system-prompt "$(cat agent-kits/coding-default/policy.md)"   # literal text, NOT a path
# env on the child: ZAI_API_KEY (the only credential), PI_OFFLINE=1, PI_SKIP_VERSION_CHECK=1
# do NOT set ZAI_BASE_URL — pi ignores it and uses its built-in api.z.ai/api/coding/paas/v4 endpoint
```
  → the **task** commits the working tree on a branch (`targetBranch ?? hatchery/<issue>-<short>`) → push → open/update PR → callback `pr_opened` (+prUrl) → callback `completed` (+summary). Wrap in try/catch → callback `failed` (+error). `finally` → `workspace.cleanup()`.
  > **LIVE-confirm before trusting failure handling:** does `pi -p` exit non-zero on model/tool error? If it exits 0, derive failure from the `--mode json` event stream (`agent_end`/error events) instead. Also confirm no `/login` hang in the TTY-less container (ANTHROPIC_API_KEY + PI_OFFLINE should prevent it).
- [ ] **Verify (live kill-test):** real "Run Agent" issue on **our** repo → PR opens, `agent_runs` `completed`. Commit `feat: run-coding-task runs pi and opens a PR (local, our repo)`.

### Task B4: Minimal Linear reply
**Files:** Create `src/agent-runs/linear-reply.ts`; Modify the callback path (`handleAgentRunCallback` or a thin wrapper in `.flue/app.ts`'s `/__internal/agent-runs`).
- [ ] `postLinearComment(db, env, run, text)` — resolve the Linear write token via Nango `fetchToken('linear')` (the connection for `run.projectId`); POST Linear `commentCreate` GraphQL to the issue (`run.linearIssueId`). Best-effort (never throw into the callback).
- [ ] On callback status: `running`→ "🤖 Run started", `pr_opened`→ "🤖 PR opened: <prUrl>", `failed`→ "🤖 Run failed: <short error>". Dedupe via the existing notification dedupeKey so retries don't double-post.
- [ ] **Failing test:** a `pr_opened` callback triggers exactly one `postLinearComment` with the PR url (inject a fake `postLinearComment` + fake `fetchToken`). **Verify scope:** confirm the Nango Linear token can write comments (precondition). Commit `feat: minimal Linear reply on run start/PR/fail`.

---

## M0c–M0f — outlined (each its own plan when reached)

- **M0c — GitHub App token minting.** Register a GitHub App (Contents: RW, Pull requests: RW). Hatchery mints a 1-hour installation token scoped to the target repo at dispatch time and puts it in `dispatch.githubToken`; delete `RUNNER_GITHUB_PAT_TEMP`. [GitHub App installation auth]
- **M0d — E2B WorkspaceProvider.** Implement `e2bWorkspace` behind the same interface (create sandbox, clone, exec, cleanup). **Switch `sandboxProvider` to `e2b` before any non-our repo** (security gate). Task body unchanged (it talks to `Workspace`, not E2B directly).
- **M0e — continuation mode.** Already emitted by Hatchery (`mode:'continuation'`, `targetBranch`, `feedback`). Confirm the task checks out `targetBranch` and pushes to it (PR updates); add the continuation kill-test (comment → PR gains a commit).
- **M0f — richer notification sweep.** The full `agent_run_notifications` delivery (Plan B): ticker sweeps `pending` → posts per-type Linear/Slack messages → marks `sent`. Replaces the M0b minimal reply with the general path.
- **Later — `workspacePolicy: 'reuse_if_head_matches'`** (drift-safe workspace reuse) once cold-start latency justifies it.

---

## Self-Review

**Spec coverage:** contract (C1) → trigger_run_id + outbox→Trigger (M0a) → local workspace + github + pi + minimal reply (M0b) → App token / E2B / continuation / sweep (M0c–f outlined). Matches the agreed M0a–M0f order. ✓

**Placeholder scan:** Preconditions **audited 2026-06-06** against primary sources (see the audited block above). Trigger REST path/body/response confirmed against API `2024-04` (idempotencyKey moved to `body.options` — was a header bug); `pi` CLI invocation confirmed against the installed package (provider must be pinned to anthropic; `ANTHROPIC_API_KEY` added as a precondition; no `--cwd` flag). Remaining live items (Trigger project ref, Linear granted-scope check, pi failure-exit-code) are explicit LIVE actions, not silent assumptions. ✓

**Type consistency:** `RunnerCallbackSchema` status set (running/pr_opened/completed/failed) is a subset of the existing `handleAgentRunCallback` (which also maps `pr_opened→waiting_approval`). `buildRunnerDispatch` validates with the same schema the task parses. `triggerRunId` threads repository → dispatch → row. ✓

**Boundary checks honored:** Trigger=host not truth (`trigger_run_id` foreign id); `maxDuration` set + reaper backstop (maxDuration kill skips onFailure); temp PAT explicitly temporary; local=our-repo-only; minimal reply (not sweep); valibot+contractVersion. ✓

---

## Execution Handoff

1. **Subagent-Driven (recommended)** — superpowers:subagent-driven-development. Note the **live/human steps**: provisioning the Trigger project + `TRIGGER_SECRET_KEY` (gates A3/M0a verify), the temp PAT, and the Linear-write-scope check — do these first.
2. **Inline** — superpowers:executing-plans.

Which approach?
