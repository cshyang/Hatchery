import type { D1Like } from '../skills/repository';
import { claimAndDispatchRun, type RunnerDispatchDeps } from './dispatch';
import { createAgentRun, getActiveAgentRunByBranch, type AgentRun, type ClockAndIds } from './repository';

export type ContinuationSurface = 'linear' | 'github';

export interface ContinuationInput {
  projectId: string;
  parent: AgentRun;
  feedback: string;                                   // the human's comment = this turn's task
  source: { type: ContinuationSurface; id: string };  // dedupe identity (delivery id)
  replyTarget: { surface: ContinuationSurface; ref: string }; // where a future reply goes
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
    linearIssue:
      parent.linearIssueId && parent.linearIdentifier && parent.linearUrl
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

  // LOSSY DEDUPE (named limitation; upgrade is a later task). A comment arriving while a sandbox is
  // actively working this branch is dropped; the running run never sees it.
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
