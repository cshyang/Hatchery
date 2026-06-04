# Run Continuation via Linear Comments — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A human comment on a Linear issue that already has a run/PR spawns a *continuation run* targeting the existing PR branch, carrying the comment as the task — so the runner pushes a fix to the same PR instead of starting from scratch.

**Architecture:** "Resume" is not a mechanism — it is an ordinary `agent_run` whose `branch` is the PR branch (not `main`) and whose `dispatchPayload.mode = 'continuation'`. Same outbox, same `claimAndDispatchRun`, same reconciler. The git branch is the only checkpoint; every turn is a fresh sandbox that re-clones it (a paused E2B sandbox would be a stale cache of a mutable remote). Hatchery stays the **receipt/router** (boundary events → `agent_run_events`, state → `agent_runs`); the runner is the executor. This plan builds the **Hatchery side of the Linear surface only**.

**Tech Stack:** TypeScript, Cloudflare Workers + D1 (SQLite), Flue runtime, `tsx` test runner (`createTestRunner` + per-file `FakeD1`). No new dependencies. **No migration** — reuses existing `agent_runs` columns.

---

## ⚠️ Scope, Definition of Done, and Assumptions — READ FIRST

This plan does **not**, on its own, produce a live PR-iteration demo.

- **Definition of Done** = *Hatchery emits a correct continuation dispatch, unit-tested* (a human Linear comment on an issue with an existing branch records a boundary event and creates a `queued` continuation run whose `dispatchPayload` tells the runner to clone the PR branch), **plus** the dead-scaffolding cleanup. It is **not** "I watched a PR update from a comment."
- **End-to-end is gated on the EXTERNAL runner.** The loop only closes when the runner honors `mode: 'continuation'` (clone the existing branch, push to it, report a summary). Task 8 documents that contract; it is **not implemented in this repo.**
  - **ASSUMPTION — confirm before relying on end-to-end:** the E2B/Pi runner is yours to modify. If it is a third party's, Task 8 is an *integration request to them*, and the live loop is blocked on them, not on this plan.
- **Reply / "mirror the source" is NOT in this plan.** It is **Plan B**, because sending a Linear reply means *activating the notification-delivery subsystem*: `agent_run_notifications` rows are already created `pending` by `recordStartedNotification`, `handleAgentRunCallback`, and the reconciler — for *every* run. Any sweep that sends them lights up all of them system-wide, plus needs a Linear `commentCreate` (write token via the Nango Linear connection's `fetchToken` — confirmed reachable, scope TBD at Plan B time). In this plan, the visible feedback is the **new commit the runner pushes to the PR.**
- **PR/GitHub surface is NOT in this plan.** It is **Plan C**, gated on the Nango GitHub *forwarding* that is not wired today. It reuses this plan's `createContinuationRun` core.

### Named limitation — lossy dedupe (DOGFOOD ONLY)

A comment that arrives **while a continuation is actively working the branch** (`queued`/`dispatching`/`running`) is **dropped** (logged, status `deduped`). The running sandbox started before that comment existed and never sees it. In a real review loop ("fix X" … 30s later "also fix Y") this is common, not edge — and to a team it will feel broken.

**This is acceptable for internal dogfood only. Task 9 (record-and-defer) is REQUIRED before any team/customer use** — it is not optional. Ship v1 lossy only if speed matters and only you are using it.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/agent-runs/repository.ts` | Add `branch` to `createAgentRun`; add `findLatestRunByLinearIssue` (no projectId) + `getActiveAgentRunByBranch` queries | Modify |
| `src/agent-runs/continuation.ts` | **New.** Provider-neutral core: `buildContinuationDispatchPayload`, `createContinuationRun` (dedupe + create + dispatch thunk). Reused by Plan C. | Create |
| `src/agent-runs/linear.ts` | Add `handleLinearComment`: parse Comment event, human guard, find parent, **record `linear.comment.created` boundary event**, call core, link `last_event_id` | Modify |
| `.flue/app.ts` | Route `linear-event: Comment` → `handleLinearComment`; `Issue` → existing `handleLinearWebhook` | Modify |
| `src/agent-runs/provider-events.ts` | Remove the dead `waiting_human → wake_controller` gate in `handlingFor` | Modify |
| `src/agent-runs/provider-events.test.ts` | **Update** the `waiting_human`/`wake_controller` test → `record_only` (Task 7) | Modify |
| `src/agent-runs/continuation.test.ts` | **New.** Own in-file `FakeD1` (per existing convention). Core + dedupe tests | Create |
| `src/agent-runs/linear.test.ts` | Add `handleLinearComment` ingress + event-receipt + delivery-dedupe tests | Modify |
| `tests/fixtures/linear-comment-webhook.json` | **New.** A real captured Linear Comment body (from a DEV webhook — never prod), pinned as fixture | Create |

---

## Task 1: Pin a real Linear Comment webhook payload (DEV capture only)

Don't hand-write the payload shape from memory — capture a real one. **Do NOT log raw production Linear bodies** (comment bodies routinely contain source snippets, customer info, even credentials — `console.log(rawBody)` in prod is a secret-leak vector). Capture from a dev/throwaway source with non-sensitive text.

**Files:**
- Create: `tests/fixtures/linear-comment-webhook.json`

- [ ] **Step 1: Capture from a DEV webhook, not prod.** Pick one:
  - **(a) Dev Linear workspace → request capture.** In a non-production Linear workspace, create a webhook (Comment events) pointing at a capture endpoint (`webhook.site`, or local `flue dev` via a tunnel). Comment with **non-sensitive** text like `test: use the existing helper`. Copy the delivered body.
  - **(b) Local forge.** If you already know the rough shape, forge a signed Comment body against local `flue dev` (the flue forge harness) and refine field names against Linear's webhook docs. Capture (a) is preferred — it's ground truth.
  - In **no case** add raw-body logging to the deployed production worker.

- [ ] **Step 2: Save the captured body** verbatim to `tests/fixtures/linear-comment-webhook.json`. Confirm it contains: top-level `action: "create"`, `type: "Comment"`, `webhookTimestamp`, `data.body`, an issue id (note whether it is `data.issueId` or `data.issue.id`), and an `actor`. **If field names differ from those assumed in Tasks 4–6, the fixture wins — update those tasks to match it.**

- [ ] **Step 3: Commit**
```bash
git add tests/fixtures/linear-comment-webhook.json
git commit -m "test: pin real Linear Comment webhook fixture (dev capture)"
```

---

## Task 2: `createAgentRun` accepts an optional `branch`

A continuation must set its target branch *at creation* so the next comment's dedupe (Task 3) can find it. Today `createAgentRun` hardcodes `branch=null`.

**Files:**
- Modify: `src/agent-runs/repository.ts:236` (`createAgentRun`)
- Test: `src/agent-runs/agent-runs.test.ts`

- [ ] **Step 1: Write the failing test** in `src/agent-runs/agent-runs.test.ts` (reuse the file's existing `FakeD1` + `seq()`):
```ts
test('createAgentRun persists an explicit branch when given', async () => {
  const db = new FakeD1();
  const { run } = await createAgentRun(
    db,
    { projectId: 'p1', sourceType: 'linear', idempotencyKey: 'k-branch', targetRepo: 'https://github.com/o/r', branch: 'hatchery/eng-1' },
    seq(),
  );
  assert.equal(run.branch, 'hatchery/eng-1');
});
```

- [ ] **Step 2: Run it, expect FAIL** (branch is null).
```bash
npx tsx src/agent-runs/agent-runs.test.ts
```

- [ ] **Step 3: Add `branch?: string | null;`** to the `createAgentRun` input type (around line 257).

- [ ] **Step 4: Bind it in the INSERT.** The branch column is currently bound as a literal `null` (the value right after `'queued'`). Replace that single `null` with `normalizeText(input.branch)`. Leave `commit_sha`, `pr_url`, etc. as `null`.

- [ ] **Step 5: Run the test, expect PASS.**

- [ ] **Step 6: Commit**
```bash
git add src/agent-runs/repository.ts src/agent-runs/agent-runs.test.ts
git commit -m "feat: createAgentRun accepts an explicit branch"
```

---

## Task 3: Branch + issue lookup queries

Find the parent run by issue (project-agnostic — a comment attaches to whatever project the run belongs to), and find an *actively-working* run on a branch (the dedupe predicate — `queued`/`dispatching`/`running`, deliberately NOT `isTerminalRun`, because a `waiting_approval` PR-open run is exactly when a comment should spawn a continuation).

**Files:**
- Modify: `src/agent-runs/repository.ts`
- Test: `src/agent-runs/agent-runs.test.ts`

- [ ] **Step 1: Write the failing tests:**
```ts
test('findLatestRunByLinearIssue returns the newest run for an issue across projects', async () => {
  const db = new FakeD1();
  await createAgentRun(db, { projectId: 'p1', sourceType: 'linear', idempotencyKey: 'a', targetRepo: 'r', linearIssueId: 'ISSUE-1' }, seq());
  const found = await findLatestRunByLinearIssue(db, 'ISSUE-1');
  assert.equal(found?.projectId, 'p1');
});

test('getActiveAgentRunByBranch finds queued/dispatching/running, ignores terminal and waiting', async () => {
  const db = new FakeD1();
  const { run } = await createAgentRun(db, { projectId: 'p1', sourceType: 'linear', idempotencyKey: 'b', targetRepo: 'r', branch: 'br-1' }, seq());
  assert.equal((await getActiveAgentRunByBranch(db, 'p1', 'br-1'))?.id, run.id); // queued → active
  await updateAgentRun(db, { id: run.id, status: 'completed' }, seq());
  assert.equal(await getActiveAgentRunByBranch(db, 'p1', 'br-1'), null);          // completed → not active
});
```

- [ ] **Step 2: Run, expect FAIL** (functions not exported).

- [ ] **Step 3: Implement** in `src/agent-runs/repository.ts` (after `getLatestAgentRunByLinearIssue`):
```ts
/** Newest run for a Linear issue id, any project (a comment attaches to the run's own project). */
export async function findLatestRunByLinearIssue(db: D1Like, linearIssueId: string): Promise<AgentRun | null> {
  const row = await db
    .prepare(`SELECT ${AGENT_RUN_SELECT} FROM agent_runs WHERE linear_issue_id=? ORDER BY created_at DESC LIMIT 1`)
    .bind(linearIssueId)
    .first<AgentRunRow>();
  return row ? rowToAgentRun(row) : null;
}

/** Newest run ACTIVELY working a branch (a sandbox is live): queued/dispatching/running. Used to
 *  serialize continuations — NOT isTerminalRun, because waiting_approval (PR open, idle) must allow
 *  a new continuation. */
export async function getActiveAgentRunByBranch(db: D1Like, projectId: string, branch: string): Promise<AgentRun | null> {
  const row = await db
    .prepare(
      `SELECT ${AGENT_RUN_SELECT} FROM agent_runs
        WHERE project_id=? AND branch=? AND status IN ('queued','dispatching','running')
        ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(projectId, branch)
    .first<AgentRunRow>();
  return row ? rowToAgentRun(row) : null;
}
```

- [ ] **Step 4: Extend `FakeD1`** in `agent-runs.test.ts` to handle the two new `SELECT`s (filter by `linear_issue_id`; filter by `project_id`+`branch`+`status IN (...)`). Follow the file's existing `select(query, binds)` branch pattern.

- [ ] **Step 5: Run, expect PASS.**

- [ ] **Step 6: Commit**
```bash
git add src/agent-runs/repository.ts src/agent-runs/agent-runs.test.ts
git commit -m "feat: branch + issue lookup queries for run continuation"
```

---

## Task 4: Continuation core — `buildContinuationDispatchPayload` + `createContinuationRun`

Provider-neutral (Plan C reuses it). Builds the self-contained outbox payload and creates the run with the lossy-dedupe guard.

**Files:**
- Create: `src/agent-runs/continuation.ts`
- Test: `src/agent-runs/continuation.test.ts`

- [ ] **Step 1: Write `continuation.test.ts` with its OWN in-file `FakeD1`.** (Per this repo's convention each test file defines its own fake — model it on the one in `agent-runs.test.ts`; it must support `createAgentRun`'s INSERT + idempotency `SELECT`, `getActiveAgentRunByBranch`, `getAgentRunById`, and `updateAgentRun`.) No imports of a fake from another test file — there is no shared/exported fake.
```ts
import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { createContinuationRun } from './continuation';
import { createAgentRun, updateAgentRun } from './repository';
// --- define FakeD1 + seq() here, copied/adapted from agent-runs.test.ts ---

const { test, run } = createTestRunner();
const runnerDeps = { runnerUrl: 'https://runner', runnerToken: 't', hatcheryPublicUrl: 'https://hatchery', fetch: async () => new Response('{}') };

test('createContinuationRun targets the parent branch and carries the feedback', async () => {
  const db = new FakeD1();
  const { run: parent } = await createAgentRun(db, { projectId: 'p1', sourceType: 'linear', idempotencyKey: 'parent', targetRepo: 'https://github.com/o/r', branch: 'hatchery/eng-1' }, seq());
  await updateAgentRun(db, { id: parent.id, status: 'waiting_approval', prUrl: 'https://github.com/o/r/pull/5' }, seq());
  const fresh = await (await import('./repository')).getAgentRunById(db, parent.id);

  const out = await createContinuationRun(
    db,
    { projectId: 'p1', parent: fresh!, feedback: 'use the existing helper', source: { type: 'linear', id: 'deliv-1' }, replyTarget: { surface: 'linear', ref: 'ISSUE-1' } },
    { ...runnerDeps, ...seq() },
  );

  assert.equal(out.status, 'created');
  if (out.status !== 'created') return;
  assert.equal(out.run.branch, 'hatchery/eng-1');
  const payload = JSON.parse(out.run.dispatchPayload!);
  assert.equal(payload.mode, 'continuation');
  assert.equal(payload.targetBranch, 'hatchery/eng-1');
  assert.equal(payload.feedback, 'use the existing helper');
  assert.deepEqual(payload.replyTarget, { surface: 'linear', ref: 'ISSUE-1' });
});

test('createContinuationRun dedupes when a run is actively working the branch (NAMED lossy limitation)', async () => {
  const db = new FakeD1();
  const { run: parent } = await createAgentRun(db, { projectId: 'p1', sourceType: 'linear', idempotencyKey: 'p', targetRepo: 'r', branch: 'br-1' }, seq());
  // parent is 'queued' = actively working → a second feedback is dropped
  const out = await createContinuationRun(db, { projectId: 'p1', parent, feedback: 'late comment', source: { type: 'linear', id: 'd2' }, replyTarget: { surface: 'linear', ref: 'I' } }, { ...runnerDeps, ...seq() });
  assert.equal(out.status, 'deduped');
});

test('createContinuationRun ignores a parent with no branch yet', async () => {
  const db = new FakeD1();
  const { run: parent } = await createAgentRun(db, { projectId: 'p1', sourceType: 'linear', idempotencyKey: 'p', targetRepo: 'r' }, seq()); // branch null
  const out = await createContinuationRun(db, { projectId: 'p1', parent, feedback: 'x', source: { type: 'linear', id: 'd3' }, replyTarget: { surface: 'linear', ref: 'I' } }, { ...runnerDeps, ...seq() });
  assert.equal(out.status, 'ignored');
});

await run();
```

- [ ] **Step 2: Run, expect FAIL** (module not found).

- [ ] **Step 3: Implement `src/agent-runs/continuation.ts`:**
```ts
import type { D1Like } from '../skills/repository';
import { claimAndDispatchRun, type RunnerDispatchDeps } from './dispatch';
import { createAgentRun, getActiveAgentRunByBranch, type AgentRun, type ClockAndIds } from './repository';

export type ContinuationSurface = 'linear' | 'github';

export interface ContinuationInput {
  projectId: string;
  parent: AgentRun;
  feedback: string;                                   // the human's comment = this turn's task
  source: { type: ContinuationSurface; id: string };  // dedupe identity (delivery id)
  replyTarget: { surface: ContinuationSurface; ref: string }; // where Plan B's reply will go
}

export type ContinuationOutcome =
  | { status: 'created'; run: AgentRun; dispatch: () => Promise<unknown> }
  | { status: 'deduped'; reason: string }
  | { status: 'ignored'; reason: string };

// Self-contained outbox payload for a continuation. `mode` + `targetBranch` tell the runner: clone
// targetBranch and push to it (do NOT branch from baseBranch). runId/projectId/callback are injected
// at send time by dispatch.ts.
export function buildContinuationDispatchPayload(input: ContinuationInput): string {
  const { parent, feedback, source, replyTarget } = input;
  return JSON.stringify({
    source,
    mode: 'continuation',
    parentRunId: parent.id,
    targetRepo: parent.targetRepo,
    baseBranch: parent.baseBranch,
    targetBranch: parent.branch,
    prUrl: parent.prUrl,
    kit: parent.kit,
    runtime: parent.runtime,
    sandboxProvider: parent.sandboxProvider,
    feedback,
    replyTarget,
    linearIssue: parent.linearIssueId
      ? { id: parent.linearIssueId, identifier: parent.linearIdentifier, url: parent.linearUrl }
      : null,
  });
}

export async function createContinuationRun(
  db: D1Like,
  input: ContinuationInput,
  deps: RunnerDispatchDeps & ClockAndIds = {},
): Promise<ContinuationOutcome> {
  const { parent } = input;
  if (!parent.branch) return { status: 'ignored', reason: 'parent run has no branch yet (no PR to continue)' };

  // LOSSY DEDUPE (named limitation — see plan §Named limitation; upgrade = Task 9). A comment arriving
  // while a sandbox is actively working this branch is dropped; the running run never sees it.
  const active = await getActiveAgentRunByBranch(db, input.projectId, parent.branch);
  if (active) return { status: 'deduped', reason: `run ${active.id} is actively working branch ${parent.branch}` };

  const created = await createAgentRun(
    db,
    {
      projectId: input.projectId,
      sourceType: input.source.type,
      sourceId: input.source.id,
      idempotencyKey: `continuation:${input.source.type}:${input.source.id}`,
      linearIssueId: parent.linearIssueId,
      linearIdentifier: parent.linearIdentifier,
      linearUrl: parent.linearUrl,
      githubOwner: parent.githubOwner,
      githubRepo: parent.githubRepo,
      targetRepo: parent.targetRepo,
      baseBranch: parent.baseBranch,
      branch: parent.branch, // set at creation so the NEXT comment's dedupe finds this run
      kit: parent.kit,
      runtime: parent.runtime,
      sandboxProvider: parent.sandboxProvider,
      dispatchPayload: buildContinuationDispatchPayload(input),
    },
    deps,
  );
  if (created.duplicate) return { status: 'deduped', reason: 'this comment was already processed (idempotent)' };

  const runId = created.run.id;
  return { status: 'created', run: created.run, dispatch: () => claimAndDispatchRun(db, runId, deps, deps) };
}
```

- [ ] **Step 4: Run, expect PASS.**
```bash
npx tsx src/agent-runs/continuation.test.ts
```

- [ ] **Step 5: Commit**
```bash
git add src/agent-runs/continuation.ts src/agent-runs/continuation.test.ts
git commit -m "feat: provider-neutral run-continuation core"
```

---

## Task 5: `handleLinearComment` ingress (with boundary-event receipt)

Parse the Comment event, enforce the human-actor guard, find the parent run, **record a `linear.comment.created` boundary event** (Hatchery's architecture: boundary events live in `agent_run_events`, state in `agent_runs` — mirror `handleLinearWebhook`), dedupe on the delivery, then call the core and link `last_event_id`. Record the event only **after** confirming a parent run exists, so we don't write an event for every workspace comment on issues Hatchery never ran.

**Files:**
- Modify: `src/agent-runs/linear.ts`
- Test: `src/agent-runs/linear.test.ts`

- [ ] **Step 1: Write the failing tests** in `linear.test.ts` (sign the body as the existing Linear tests do; seed a parent run with a branch first):
```ts
test('handleLinearComment records a boundary event and spawns a continuation for a human comment', async () => {
  const db = new FakeD1();
  await createAgentRun(db, { projectId: 'p1', sourceType: 'linear', idempotencyKey: 'parent', targetRepo: 'https://github.com/o/r', linearIssueId: 'ISSUE-1', branch: 'hatchery/eng-1' }, seq());
  const raw = JSON.stringify({ action: 'create', type: 'Comment', webhookTimestamp: NOW, actor: { type: 'user', id: 'u1' }, data: { id: 'c1', body: 'use the existing helper', issueId: 'ISSUE-1' } });
  const res = await handleLinearComment(
    { db, signingSecret: SECRET, signature: await sign(SECRET, raw), deliveryId: 'deliv-1', event: 'Comment', rawBody: raw, projectsJson: undefined, nowMs: NOW },
    { runnerUrl: 'https://runner', runnerToken: 't', hatcheryPublicUrl: 'https://h', fetch: async () => new Response('{}'), ...seq() },
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.dispatchStatus, 'queued');
  assert.ok(res.dispatch);
  assert.equal(db.events.filter((e) => e.event_type === 'linear.comment.created').length, 1);
});

test('handleLinearComment dedupes a redelivered comment by delivery id', async () => {
  const db = new FakeD1();
  await createAgentRun(db, { projectId: 'p1', sourceType: 'linear', idempotencyKey: 'parent', targetRepo: 'r', linearIssueId: 'ISSUE-1', branch: 'br' }, seq());
  const raw = JSON.stringify({ action: 'create', type: 'Comment', webhookTimestamp: NOW, actor: { type: 'user' }, data: { id: 'c1', body: 'hi', issueId: 'ISSUE-1' } });
  const args = { db, signingSecret: SECRET, signature: await sign(SECRET, raw), deliveryId: 'dup-1', event: 'Comment', rawBody: raw, projectsJson: undefined, nowMs: NOW };
  await handleLinearComment(args, { ...seq() } as any);
  const second = await handleLinearComment(args, { ...seq() } as any); // same delivery id
  assert.equal(second.body.dispatchStatus, 'deduped');
});

test('handleLinearComment skips a bot comment (self-trigger guard)', async () => {
  const db = new FakeD1();
  await createAgentRun(db, { projectId: 'p1', sourceType: 'linear', idempotencyKey: 'parent', targetRepo: 'r', linearIssueId: 'ISSUE-1', branch: 'b' }, seq());
  const raw = JSON.stringify({ action: 'create', type: 'Comment', webhookTimestamp: NOW, actor: { type: 'app', name: 'Hatchery' }, data: { id: 'c2', body: 'auto', issueId: 'ISSUE-1' } });
  const res = await handleLinearComment({ db, signingSecret: SECRET, signature: await sign(SECRET, raw), deliveryId: 'd2', event: 'Comment', rawBody: raw, projectsJson: undefined, nowMs: NOW }, { ...seq() } as any);
  assert.equal(res.body.skipped, 'non-human actor');
});

test('handleLinearComment skips (no event written) when no run exists for the issue', async () => {
  const db = new FakeD1();
  const raw = JSON.stringify({ action: 'create', type: 'Comment', webhookTimestamp: NOW, actor: { type: 'user' }, data: { id: 'c3', body: 'hi', issueId: 'UNKNOWN' } });
  const res = await handleLinearComment({ db, signingSecret: SECRET, signature: await sign(SECRET, raw), deliveryId: 'd3', event: 'Comment', rawBody: raw, projectsJson: undefined, nowMs: NOW }, { ...seq() } as any);
  assert.equal(res.body.skipped, 'no run for issue');
  assert.equal(db.events.length, 0); // no workspace-wide comment noise
});
```

- [ ] **Step 2: Run, expect FAIL** (function not exported).

- [ ] **Step 3: Implement `handleLinearComment`** in `src/agent-runs/linear.ts`. Add imports (note `createAgentRunEvent` and `updateAgentRun` are already imported by this file):
```ts
import { createContinuationRun } from './continuation';
import { findLatestRunByLinearIssue } from './repository';
```
Then the handler (reuses existing `verifyLinearWebhook`, `parsePayload`, `objectField`, `optionalText`, `isNonHumanActor`, `WEBHOOK_MAX_AGE_MS`):
```ts
export async function handleLinearComment(req: LinearWebhookRequest, deps: LinearWebhookDeps): Promise<LinearWebhookResult> {
  if (!(await verifyLinearWebhook(req.signingSecret ?? '', req.rawBody, req.signature))) return { status: 404 };
  if (!req.db) return { status: 500, body: { error: 'no DB binding' } };
  if (!req.deliveryId) return { status: 400, body: { error: 'Linear-Delivery is required' } };
  if (req.event !== 'Comment') return { status: 200, body: { skipped: 'not a Comment event' } };

  try {
    const payload = parsePayload(req.rawBody);
    const timestamp = Number(payload.webhookTimestamp);
    if (!Number.isFinite(timestamp) || Math.abs((req.nowMs ?? Date.now()) - timestamp) > WEBHOOK_MAX_AGE_MS) {
      return { status: 400, body: { error: 'stale Linear webhook' } };
    }
    if (payload.action !== 'create' || payload.type !== 'Comment') return { status: 200, body: { skipped: 'not a Comment create' } };

    // Self-trigger guard: a bot/integration comment must never spawn a continuation.
    if (isNonHumanActor(payload, deps.botActorId)) return { status: 200, body: { skipped: 'non-human actor' } };

    const data = objectField(payload, 'data');
    if (!data) return { status: 400, body: { error: 'Comment data is required' } };
    const body = optionalText(data.body, 8000);
    if (!body) return { status: 200, body: { skipped: 'empty comment' } };
    const issue = objectField(data, 'issue');
    const issueId = optionalText(data.issueId, 256) ?? (issue ? optionalText(issue.id, 256) : null);
    if (!issueId) return { status: 200, body: { skipped: 'no issue id on comment' } };

    // A comment attaches to whatever run/project already owns the issue. Resolve FIRST so we don't
    // record a boundary event for comments on issues Hatchery never ran (workspace-wide noise).
    const parent = await findLatestRunByLinearIssue(req.db, issueId);
    if (!parent) return { status: 200, body: { skipped: 'no run for issue' } };

    // Boundary receipt → agent_run_events (mirrors handleLinearWebhook). Delivery-level dedupe.
    const event = await createAgentRunEvent(
      req.db,
      {
        projectId: parent.projectId,
        runId: parent.id,
        provider: 'linear',
        eventType: 'linear.comment.created',
        providerDeliveryId: req.deliveryId,
        providerEntityId: issueId,
        dedupeKey: `linear-direct:${req.deliveryId}`,
        actorType: 'human',
        handling: 'record_only',
        handlingReason: 'human comment on a run issue',
        payload,
        occurredAt: timestamp,
        processedAt: req.nowMs ?? Date.now(),
      },
      deps,
    );
    if (event.duplicate) return { status: 200, body: { dispatchStatus: 'deduped', reason: 'comment already processed' } };

    const outcome = await createContinuationRun(
      req.db,
      {
        projectId: parent.projectId,
        parent,
        feedback: body,
        source: { type: 'linear', id: req.deliveryId },
        replyTarget: { surface: 'linear', ref: issueId },
      },
      deps,
    );

    if (outcome.status === 'ignored') return { status: 200, body: { skipped: outcome.reason } };
    if (outcome.status === 'deduped') return { status: 200, body: { dispatchStatus: 'deduped', reason: outcome.reason } };

    await updateAgentRun(req.db, { id: outcome.run.id, lastEventId: event.event.id }, deps);
    return { status: 200, body: { run: outcome.run, dispatchStatus: 'queued' }, dispatch: outcome.dispatch };
  } catch (e) {
    return { status: 400, body: { error: e instanceof Error ? e.message : 'bad request' } };
  }
}
```

- [ ] **Step 4: Extend `linear.test.ts`'s `FakeD1`** to expose `db.events` and support `createAgentRunEvent` insert + its dedupe `SELECT`, plus the Task 3 queries. (If `linear.test.ts` doesn't already model `agent_run_events`, copy that branch from `provider-events.test.ts`'s fake, which does.)

- [ ] **Step 5: Run, expect PASS.**
```bash
npx tsx src/agent-runs/linear.test.ts
```

- [ ] **Step 6: Commit**
```bash
git add src/agent-runs/linear.ts src/agent-runs/linear.test.ts
git commit -m "feat: Linear comment ingress records event + spawns continuation"
```

---

## Task 6: Route Comment events in the gateway

`/linear/webhook` currently always calls `handleLinearWebhook` (which skips non-`Issue` events). Branch on the event header so Comment events reach the new handler and still dispatch off the ack path.

**Files:**
- Modify: `.flue/app.ts` (the `/linear/webhook` route, ~line 184)

- [ ] **Step 1: Read the existing route** to match its exact shape (how it reads `linear-event`, builds the request, runs `result.dispatch` via `waitUntil`).

- [ ] **Step 2: Branch on the event.** Import `handleLinearComment` alongside `handleLinearWebhook`. After building the shared request + deps:
```ts
const event = c.req.header('linear-event');
const result =
  event === 'Comment'
    ? await handleLinearComment(linearReq, linearDeps)
    : await handleLinearWebhook(linearReq, linearDeps);
if (result.dispatch) c.executionCtx.waitUntil(result.dispatch());
return c.json(result.body ?? {}, result.status as 200 | 400 | 404 | 500);
```
(Match the variable names already in the route; reuse the same `linearDeps` carrying `runnerUrl`/`runnerToken`/`hatcheryPublicUrl`/`botActorId`.)

- [ ] **Step 3: Typecheck + build.**
```bash
npm run typecheck && npm run build
```

- [ ] **Step 4: Commit**
```bash
git add .flue/app.ts
git commit -m "feat: route Linear Comment webhooks to the continuation handler"
```

---

## Task 7: Remove the dead `wake_controller`/`waiting_human` gate (and FIX its test)

The continuation-as-new-run model **replaces** the never-wired wake scaffolding (no code sets `waiting_human`; nothing consumes `handling: 'wake_controller'`). Remove the unreachable gate. **There IS a test asserting the dead behavior — it must be updated, not expected to pass.**

**Files:**
- Modify: `src/agent-runs/provider-events.ts:231` (`handlingFor`)
- Modify: `src/agent-runs/provider-events.test.ts:282` (the `wake_controller` test)

- [ ] **Step 1: Delete the dead branch** in `handlingFor` — remove:
```ts
  if (ev.eventType.includes('comment.created') && run.status === 'waiting_human') return { handling: 'wake_controller', reason: 'human comment on waiting run' };
```
and replace with a comment:
```ts
  // Human-comment continuation is handled by createContinuationRun (see continuation.ts) — Linear in
  // Plan A, GitHub PR in Plan C — NOT by a wake gate here. `waiting_human` is never set; this was dead.
```

- [ ] **Step 2: Update the test** at `provider-events.test.ts:282` (`'GitHub human comments on waiting_human runs wake the controller; bot comments are record_only'`). After the gate is gone, a GitHub issue_comment (notificationType null, completesRun false) is `record_only` for human and bot alike. Rewrite to:
```ts
test('GitHub comments are record_only (continuation is handled by createContinuationRun, not a wake gate)', async () => {
  const db = new FakeD1();
  seed(db);

  const human = await handleNangoForwardWebhook({ db, rawBody: JSON.stringify(githubIssueCommentPayload('User')) }, seq());
  const bot = await handleNangoForwardWebhook({ db, rawBody: JSON.stringify(githubIssueCommentPayload('Bot')) }, seq());

  assert.equal(human.body?.handling, 'record_only');
  assert.equal(db.events[0].handling, 'record_only');
  assert.equal(bot.body?.handling, 'record_only');
  assert.equal(db.events[1].handling, 'record_only');
});
```
(Drop the `db.agentRuns[0].status = 'waiting_human'` line — it's no longer meaningful.)

- [ ] **Step 3: Run, expect PASS.**
```bash
npx tsx src/agent-runs/provider-events.test.ts
```

- [ ] **Step 4: Commit**
```bash
git add src/agent-runs/provider-events.ts src/agent-runs/provider-events.test.ts
git commit -m "refactor: drop dead wake_controller gate; update its test to record_only"
```

---

## Task 8: Runner contract addendum (documentation — NOT code in this repo)

The loop only closes when the external runner honors continuation mode. **Confirm the runner is yours to modify (see Scope §Assumptions); if not, deliver this as an integration request.**

**Files:**
- Create/append: `docs/runner-contract.md` (or wherever the contract lives)

- [ ] **Step 1: Document the addendum.** The runner's `start` body MAY now contain:
  - `mode: 'continuation'` — do NOT branch from `baseBranch`.
  - `targetBranch: string` — clone THIS branch (the existing PR branch) and push commits back to it (updates the existing PR).
  - `prUrl: string` — the PR being iterated (context).
  - `feedback: string` — the human's comment; treat as this turn's task.
  - `replyTarget: { surface, ref }` — opaque; echo back in callbacks (for Plan B's reply routing).
  - Reaffirm: `start(runId)` stays IDEMPOTENT; emit a `completed` callback with a `summary` of what changed.

- [ ] **Step 2: Commit**
```bash
git add docs/runner-contract.md
git commit -m "docs: runner contract addendum for continuation mode"
```

---

## Task 9: Non-lossy dedupe via record-and-defer — REQUIRED before team/customer use

Removes the Named Limitation. Instead of dropping a comment that arrives mid-run: record it, and spawn a continuation when the active run finishes. **Not optional for anything beyond solo dogfood** (dropping "also fix Y" reads as broken to a team).

**Files:**
- Modify: `src/agent-runs/continuation.ts` — on `deduped`-because-active, ALSO `createAgentRunEvent` (`linear.comment.deferred`, linked to the branch + feedback) so the comment isn't lost.
- Modify: `src/agent-runs/repository.ts` `handleAgentRunCallback` — on terminal status, query deferred comment-events for that branch; if any, build a follow-up continuation folding them in.
- Test: `continuation.test.ts` — a comment during an active run is recorded, then a follow-up run is spawned when the active run completes.

- [ ] Implement before exposing continuations to anyone but yourself.

---

## Deferred — sibling plans (do NOT build here)

- **Plan B — Reply / "mirror the source" (Linear):** activate the notification-delivery subsystem. A ticker sweep sends `pending` `agent_run_notifications`; `channel: 'linear'` posts a Linear `commentCreate` (write token via the Nango Linear connection's `fetchToken`). MUST decide *which* notification types render as comments and the *exact text* of each, and accept that plain Linear-triggered runs get chattier. Reply lands on the `replyTarget` this plan already records.
- **Plan C — PR/GitHub surface:** ingress on GitHub `pull_request_review.submitted` (batched — avoids the burst races Linear can't batch) via the **Nango forwarding that is not wired today**; reply inline on the PR. Reuses `createContinuationRun` with `source.type: 'github'`. (Task 7 already made GitHub comments `record_only`, so this is the place they get wired to the core.)
- **E2B template hedge:** bake the repo toolchain + warm dep cache into a custom E2B template so the stateless re-clone cold-start is fast — at the template layer, no per-run lifecycle.

---

## Self-Review

**Spec coverage:** Linear comment ingress + boundary-event receipt (T5) → continuation run targeting PR branch (T4) with `branch` set at creation (T2) + dedupe (T3) → route (T6) → dead-scaffolding cleanup *and its test* (T7) → runner contract (T8) → non-lossy upgrade gated as required-before-team (T9). Reply, PR surface, E2B template deferred. ✓

**Placeholder scan:** no TBDs; the one genuine unknown (exact Linear Comment field names) is resolved by the Task 1 fixture before Tasks 4–6 rely on it. Test snippets are concrete (the earlier `await import ... ? parent : parent` garbage is removed; Task 4's `fresh` re-read is a real call). ✓

**Type consistency:** `createContinuationRun` returns the discriminated `ContinuationOutcome`; `handleLinearComment` maps each variant. `branch` added to `createAgentRun` input (T2) is used by T4. `RunnerDispatchDeps & ClockAndIds` matches `claimAndDispatchRun(db, runId, deps, deps)` (mirrors `handleLinearWebhook`). `createAgentRunEvent` returns `{ event, duplicate }` (matches usage). ✓

**Review fixes folded in (Codex):** (1) no prod body logging — dev capture only; (2) boundary event recorded before continuation, deduped by delivery, `last_event_id` linked; (3) test garbage removed + own in-file `FakeD1`; (4) the `wake_controller` test is *updated to `record_only`*, not expected to pass; (5) lossy dedupe marked dogfood-only, Task 9 required before team use.

---

## Execution Handoff

Two options:

1. **Subagent-Driven (recommended)** — REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Fresh subagent per task + review between. **Task 1 (capture the fixture) is a human step** (dev webhook + a real comment) — do it first.
2. **Inline Execution** — REQUIRED SUB-SKILL: superpowers:executing-plans. Batch with checkpoints.

Which approach?
