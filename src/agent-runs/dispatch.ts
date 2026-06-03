// Transactional-outbox dispatch + reconciler for agent runs.
//
// The agent_runs row IS the durable ticket. Two callers drive it through the same primitives here:
//   1. The Linear webhook — immediate best-effort dispatch (via waitUntil), so a healthy run starts now.
//   2. The ticker reconciler — the durability backstop: it (re)dispatches queued runs, reclaims runs
//      stuck mid-dispatch (a dispatcher that claimed then died), and times out runs whose runner went
//      dark. Flue's generated entry drops scheduled(), so the cron lives on the external ticker worker.
//
// The claim (queued -> dispatching) is an atomic compare-and-set (repository.claimRunForDispatch), so
// the immediate path and a reconciler tick can race safely — only one wins and dispatches.
//
// RUNNER CONTRACT (external assumptions this code can't enforce — keep the runner honest):
//   1. start(runId) is IDEMPOTENT. A run stuck in `dispatching` (the ->running write failed after the
//      runner accepted) is reclaimed at the lease and re-dispatched, so the runner may receive the same
//      runId twice. It must return the existing sandbox, not start a second job.
//   2. The runner emits callbacks (any status) as it works. Each bumps last_heartbeat_at; a runner that
//      goes silent past RUNNING_STALE_MS is presumed dead and failed. No callbacks → coarse liveness only.

import { fetchWithTimeout, jsonMessageOrText } from '../providers/http';
import type { D1Like } from '../skills/repository';
import { createAgentRunNotification } from './events';
import {
  claimRunForDispatch,
  failStaleRunningRun,
  listDispatchableRuns,
  listStaleDispatchingRuns,
  listStaleRunningRuns,
  requeueStaleDispatchingRun,
  updateAgentRun,
  type AgentRun,
  type ClockAndIds,
} from './repository';

export const DISPATCH_MAX_ATTEMPTS = 5; // after this many failed starts, the run is terminally failed
export const DISPATCH_LEASE_MS = 90_000; // a `dispatching` row older than this is a crashed dispatcher → reclaim
// Coarse liveness, NOT a tight heartbeat. Every runner callback bumps last_heartbeat_at, but a long
// coding stretch can run for an hour+ with no intermediate callback, so this window must comfortably
// exceed the longest plausible silent run. For tighter detection the runner must emit periodic
// heartbeat callbacks (any callback counts). Tune down once it does.
export const RUNNING_STALE_MS = 3 * 60 * 60_000; // 3h silent → presumed dead
export const RECONCILE_DISPATCH_LIMIT = 10; // queued runs dispatched per tick (bounds work)
export const RECONCILE_SWEEP_LIMIT = 50; // stale rows reclaimed/timed-out per tick
const RUNNER_FETCH_TIMEOUT_MS = 12_000;

export interface RunnerDispatchDeps {
  runnerUrl?: string;
  runnerToken?: string;
  hatcheryPublicUrl?: string;
  fetch?: typeof fetch;
}

export interface DispatchResult {
  dispatched: boolean;
  status: AgentRun['status'] | 'skipped';
  reason?: string;
}

// A runner failure that knows whether retrying could help. 5xx/429/timeout/network = transient (requeue);
// 4xx = the request itself is wrong (terminal).
class RunnerDispatchError extends Error {
  retryable: boolean;
  constructor(message: string, opts: { retryable: boolean }) {
    super(message);
    this.name = 'RunnerDispatchError';
    this.retryable = opts.retryable;
  }
}

function runnerCallbackUrl(hatcheryPublicUrl: string | undefined): string | undefined {
  if (!hatcheryPublicUrl) return undefined;
  return `${hatcheryPublicUrl.replace(/\/+$/, '')}/__internal/agent-runs`;
}

// Reconstruct the runner request from the self-contained row: the source snapshot was persisted at
// create time; runId + callback are injected here (runId isn't known until the row exists; the callback
// URL is env-derived so we never want a stale stored copy).
function buildRunnerBody(run: AgentRun, callbackUrl: string | undefined): Record<string, unknown> {
  const stored = run.dispatchPayload ? (JSON.parse(run.dispatchPayload) as Record<string, unknown>) : {};
  return {
    ...stored,
    runId: run.id,
    projectId: run.projectId,
    callback: {
      ...(callbackUrl ? { url: callbackUrl } : { path: '/__internal/agent-runs' }),
      authHeader: 'x-hatchery-agent-runner-token',
    },
  };
}

async function postToRunner(deps: RunnerDispatchDeps, body: unknown): Promise<{ sandboxId?: string | null }> {
  let res: Response;
  try {
    res = await fetchWithTimeout(
      deps.runnerUrl!,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hatchery-agent-runner-token': deps.runnerToken! },
        body: JSON.stringify(body),
      },
      {
        timeoutMs: RUNNER_FETCH_TIMEOUT_MS,
        timeoutMessage: `agent runner timed out after ${RUNNER_FETCH_TIMEOUT_MS}ms`,
        failurePrefix: 'agent runner dispatch failed',
        fetchImpl: deps.fetch,
      },
    );
  } catch (e) {
    // timeout / network — retrying may well succeed
    throw new RunnerDispatchError(e instanceof Error ? e.message : 'agent runner dispatch failed', { retryable: true });
  }
  const textBody = await res.text();
  if (!res.ok) {
    const retryable = res.status >= 500 || res.status === 429;
    throw new RunnerDispatchError(`agent runner ${res.status}: ${jsonMessageOrText(textBody, 160)}`, { retryable });
  }
  try {
    const parsed = JSON.parse(textBody) as { sandboxId?: unknown };
    return { sandboxId: typeof parsed.sandboxId === 'string' ? parsed.sandboxId : null };
  } catch {
    return {};
  }
}

// Send a CLAIMED run (already in `dispatching`) to the runner and record the outcome:
//   success            -> running (+ sandbox)
//   transient failure  -> requeue, until attempts hit the cap, then fail
//   permanent failure  -> failed
async function dispatchClaimedRun(
  db: D1Like,
  run: AgentRun,
  deps: RunnerDispatchDeps,
  clock: ClockAndIds,
): Promise<DispatchResult> {
  const callbackUrl = runnerCallbackUrl(deps.hatcheryPublicUrl);
  try {
    const result = await postToRunner(deps, buildRunnerBody(run, callbackUrl));
    await updateAgentRun(db, { id: run.id, status: 'running', sandboxId: result.sandboxId ?? null }, clock);
    return { dispatched: true, status: 'running' };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'agent runner dispatch failed';
    const retryable = e instanceof RunnerDispatchError ? e.retryable : true;
    const overCap = run.dispatchAttempts >= DISPATCH_MAX_ATTEMPTS;
    if (!retryable || overCap) {
      const reason = overCap
        ? `dispatch failed after ${run.dispatchAttempts} attempts: ${message}`
        : message;
      await updateAgentRun(db, { id: run.id, status: 'failed', error: reason, lastDispatchError: message }, clock);
      return { dispatched: false, status: 'failed', reason: message };
    }
    await updateAgentRun(db, { id: run.id, status: 'queued', lastDispatchError: message }, clock);
    return { dispatched: false, status: 'queued', reason: message };
  }
}

/**
 * Claim a queued run and dispatch it. Safe to call from the webhook (immediate) AND the reconciler:
 * the atomic claim guarantees only one wins. Leaves the run queued (for the ticker to retry) when the
 * runner isn't configured, so a transient deploy-time config gap self-heals instead of killing the run.
 */
export async function claimAndDispatchRun(
  db: D1Like,
  runId: string,
  deps: RunnerDispatchDeps,
  clock: ClockAndIds = {},
): Promise<DispatchResult> {
  if (!deps.runnerUrl || !deps.runnerToken) {
    return { dispatched: false, status: 'skipped', reason: 'agent runner is not configured' };
  }
  const claimed = await claimRunForDispatch(db, runId, clock);
  if (!claimed) return { dispatched: false, status: 'skipped', reason: 'run was not claimable (already dispatching/terminal)' };
  return dispatchClaimedRun(db, claimed, deps, clock);
}

export interface ReconcileSummary {
  reclaimed: number; // stuck `dispatching` returned to queued
  timedOut: number; // `running` past the heartbeat window, failed
  dispatched: number; // queued runs started this tick
  failed: number; // queued runs over the attempt cap, failed
  skipped: number; // claim lost / not configured
}

/**
 * One reconcile pass. Order matters: reclaim stuck dispatching → queued FIRST so the dispatch step
 * below picks them up in the same tick; time out dead runners; then dispatch the queued backlog.
 */
export async function reconcileAgentRuns(
  db: D1Like,
  deps: RunnerDispatchDeps,
  clock: ClockAndIds = {},
): Promise<ReconcileSummary> {
  const now = clock.now?.() ?? Date.now();
  const summary: ReconcileSummary = { reclaimed: 0, timedOut: 0, dispatched: 0, failed: 0, skipped: 0 };

  // 1. Reclaim dispatchers that claimed then died — the lease expired.
  const dispatchLeaseCutoff = now - DISPATCH_LEASE_MS;
  for (const run of await listStaleDispatchingRuns(db, dispatchLeaseCutoff, RECONCILE_SWEEP_LIMIT)) {
    const reclaimed = await requeueStaleDispatchingRun(db, run.id, dispatchLeaseCutoff, clock);
    if (reclaimed) summary.reclaimed++;
  }

  // 2. Time out running runs whose runner went dark.
  const heartbeatCutoff = now - RUNNING_STALE_MS;
  for (const run of await listStaleRunningRuns(db, heartbeatCutoff, RECONCILE_SWEEP_LIMIT)) {
    const failed = await failStaleRunningRun(db, run.id, heartbeatCutoff, clock);
    if (!failed) continue;
    await createAgentRunNotification(
      db,
      {
        projectId: failed.projectId,
        runId: failed.id,
        channel: 'linear',
        notificationType: 'failed',
        dedupeKey: `notify:${failed.id}:failed:linear`,
        targetRef: failed.linearIssueId ?? failed.linearIdentifier ?? null,
        status: 'pending',
      },
      clock,
    ).catch(() => {});
    summary.timedOut++;
  }

  // 3. Dispatch the queued backlog (including anything just reclaimed in step 1). Run the batch in
  // PARALLEL: each dispatch is a runner HTTP call with a 12s timeout, so doing 10 sequentially could
  // blow the Worker request budget. Claims are atomic (CAS), so parallel dispatch is safe.
  const outcomes = await Promise.all(
    (await listDispatchableRuns(db, RECONCILE_DISPATCH_LIMIT)).map(async (run): Promise<'dispatched' | 'failed' | 'skipped'> => {
      if (run.dispatchAttempts >= DISPATCH_MAX_ATTEMPTS) {
        await updateAgentRun(
          db,
          { id: run.id, status: 'failed', error: `dispatch failed after ${run.dispatchAttempts} attempts`, lastDispatchError: run.lastDispatchError ?? 'attempt cap reached' },
          clock,
        );
        return 'failed';
      }
      const result = await claimAndDispatchRun(db, run.id, deps, clock);
      return result.dispatched ? 'dispatched' : result.status === 'failed' ? 'failed' : 'skipped';
    }),
  );
  for (const outcome of outcomes) summary[outcome]++;

  return summary;
}
