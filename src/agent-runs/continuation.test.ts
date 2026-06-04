// Continuation-run core contracts — run: npx tsx src/agent-runs/continuation.test.ts
import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import type { D1Like } from '../skills/repository';
import { createAgentRun, getAgentRunById, updateAgentRun } from './repository';
import { createContinuationRun } from './continuation';

const { test, run } = createTestRunner();

type Row = Record<string, unknown>;

class FakeD1 implements D1Like {
  agentRuns: Row[] = [];
  events: Row[] = [];
  notifications: Row[] = [];
  beforeUpdateAgentRun?: (row: Row, nextStatus: unknown) => void;

  prepare(query: string) {
    const db = this;
    return {
      bind(...values: unknown[]) {
        return {
          async first<T = Row>(): Promise<T | null> {
            const { results } = await this.all<T>();
            return results[0] ?? null;
          },
          async all<T = Row>(): Promise<{ results: T[] }> {
            if (query.startsWith('SELECT') && query.includes('FROM agent_runs')) {
              if (query.includes('WHERE project_id=? AND id=?')) {
                const [projectId, id] = values;
                return { results: db.agentRuns.filter((r) => r.project_id === projectId && r.id === id) as T[] };
              }
              if (query.includes('WHERE id=?')) {
                const [id] = values;
                return { results: db.agentRuns.filter((r) => r.id === id) as T[] };
              }
              if (query.includes('WHERE project_id=? AND source_type=? AND source_id=?')) {
                const [projectId, sourceType, sourceId] = values;
                const rows = db.agentRuns
                  .filter((r) => r.project_id === projectId && r.source_type === sourceType && r.source_id === sourceId)
                  .sort((a, b) => Number(b.created_at) - Number(a.created_at));
                return { results: rows as T[] };
              }
              if (query.includes('WHERE project_id=? AND idempotency_key=?')) {
                const [projectId, idempotencyKey] = values;
                return { results: db.agentRuns.filter((r) => r.project_id === projectId && r.idempotency_key === idempotencyKey) as T[] };
              }
              if (query.includes('WHERE project_id=? AND linear_issue_id=?')) {
                const [projectId, linearIssueId] = values;
                const rows = db.agentRuns
                  .filter((r) => r.project_id === projectId && r.linear_issue_id === linearIssueId)
                  .sort((a, b) => Number(b.created_at) - Number(a.created_at));
                return { results: rows as T[] };
              }
              if (query.includes('WHERE linear_issue_id=?')) {
                const [linearIssueId] = values;
                const rows = db.agentRuns
                  .filter((r) => r.linear_issue_id === linearIssueId)
                  .sort((a, b) => Number(b.created_at) - Number(a.created_at));
                return { results: rows as T[] };
              }
              if (query.includes("status IN ('queued'")) {
                const [projectId, branch] = values;
                const activeStatuses = new Set(['queued', 'dispatching', 'running']);
                const rows = db.agentRuns
                  .filter((r) => r.project_id === projectId && r.branch === branch && activeStatuses.has(String(r.status)))
                  .sort((a, b) => Number(b.created_at) - Number(a.created_at));
                return { results: rows as T[] };
              }
              if (query.includes("WHERE status='queued'")) {
                const [limit] = values;
                const rows = db.agentRuns
                  .filter((r) => r.status === 'queued')
                  .sort((a, b) => Number(a.created_at) - Number(b.created_at))
                  .slice(0, Number(limit));
                return { results: rows as T[] };
              }
              if (query.includes("WHERE status='dispatching' AND updated_at < ?")) {
                const [cutoff, limit] = values;
                const rows = db.agentRuns
                  .filter((r) => r.status === 'dispatching' && Number(r.updated_at) < Number(cutoff))
                  .sort((a, b) => Number(a.updated_at) - Number(b.updated_at))
                  .slice(0, Number(limit));
                return { results: rows as T[] };
              }
              if (query.includes("WHERE status='running' AND COALESCE")) {
                const [cutoff, limit] = values;
                const liveness = (r: Row) => Number(r.last_heartbeat_at ?? r.dispatched_at ?? r.updated_at);
                const rows = db.agentRuns
                  .filter((r) => r.status === 'running' && liveness(r) < Number(cutoff))
                  .sort((a, b) => Number(a.updated_at) - Number(b.updated_at))
                  .slice(0, Number(limit));
                return { results: rows as T[] };
              }
            }
            if (query.startsWith('SELECT') && query.includes('FROM agent_run_events')) {
              if (query.includes('WHERE dedupe_key=?')) {
                const [dedupeKey] = values;
                return { results: db.events.filter((r) => r.dedupe_key === dedupeKey) as T[] };
              }
            }
            if (query.startsWith('SELECT') && query.includes('FROM agent_run_notifications')) {
              if (query.includes('WHERE dedupe_key=?')) {
                const [dedupeKey] = values;
                return { results: db.notifications.filter((r) => r.dedupe_key === dedupeKey) as T[] };
              }
            }
            return { results: [] as T[] };
          },
          async run(): Promise<{ meta: { changes: number } }> {
            if (query.startsWith('INSERT INTO agent_runs')) {
              const [
                id,
                projectId,
                routeId,
                sourceType,
                sourceId,
                idempotencyKey,
                linearIssueId,
                linearIdentifier,
                linearUrl,
                slackTeamId,
                slackChannelId,
                slackThreadTs,
                githubOwner,
                githubRepo,
                targetRepo,
                baseBranch,
                kit,
                runtime,
                sandboxProvider,
                sandboxId,
                status,
                branch,
                commitSha,
                prUrl,
                ciUrl,
                summary,
                error,
                statusNote,
                lastEventId,
                lastHeartbeatAt,
                dispatchPayload,
                createdAt,
                updatedAt,
                completedAt,
              ] = values;
              db.agentRuns.push({
                id,
                project_id: projectId,
                route_id: routeId,
                source_type: sourceType,
                source_id: sourceId,
                idempotency_key: idempotencyKey,
                linear_issue_id: linearIssueId,
                linear_identifier: linearIdentifier,
                linear_url: linearUrl,
                slack_team_id: slackTeamId,
                slack_channel_id: slackChannelId,
                slack_thread_ts: slackThreadTs,
                github_owner: githubOwner,
                github_repo: githubRepo,
                target_repo: targetRepo,
                base_branch: baseBranch,
                kit,
                runtime,
                sandbox_provider: sandboxProvider,
                sandbox_id: sandboxId,
                status,
                branch,
                commit_sha: commitSha,
                pr_url: prUrl,
                ci_url: ciUrl,
                summary,
                error,
                status_note: statusNote,
                last_event_id: lastEventId,
                last_heartbeat_at: lastHeartbeatAt,
                dispatch_attempts: 0,
                last_dispatch_error: null,
                dispatched_at: null,
                dispatch_payload: dispatchPayload,
                created_at: createdAt,
                updated_at: updatedAt,
                completed_at: completedAt,
              });
              return { meta: { changes: 1 } };
            }
            // Atomic claim: queued -> dispatching. Compare-and-set on status, so a row already
            // claimed (or terminal) yields changes:0 — the same guard the real SQL enforces.
            if (query.startsWith('UPDATE agent_runs') && query.includes("status='dispatching'") && query.includes("AND status='queued'")) {
              const [dispatchedAt, updatedAt, id] = values;
              const row = db.agentRuns.find((r) => r.id === id && r.status === 'queued');
              if (!row) return { meta: { changes: 0 } };
              Object.assign(row, {
                status: 'dispatching',
                dispatch_attempts: (Number(row.dispatch_attempts) || 0) + 1,
                dispatched_at: dispatchedAt,
                updated_at: updatedAt,
              });
              return { meta: { changes: 1 } };
            }
            if (query.startsWith('UPDATE agent_runs') && query.includes("SET status='queued'") && query.includes("status='dispatching'")) {
              const [lastDispatchError, updatedAt, id, leaseCutoff] = values;
              const row = db.agentRuns.find((r) => r.id === id);
              if (!row) return { meta: { changes: 0 } };
              db.beforeUpdateAgentRun?.(row, 'queued');
              if (row.status !== 'dispatching' || Number(row.updated_at) >= Number(leaseCutoff)) return { meta: { changes: 0 } };
              Object.assign(row, {
                status: 'queued',
                last_dispatch_error: lastDispatchError,
                updated_at: updatedAt,
              });
              return { meta: { changes: 1 } };
            }
            if (query.startsWith('UPDATE agent_runs') && query.includes("SET status='failed'") && query.includes("status='running'")) {
              const [error, statusNote, completedAt, updatedAt, id, heartbeatCutoff] = values;
              const row = db.agentRuns.find((r) => r.id === id);
              if (!row) return { meta: { changes: 0 } };
              db.beforeUpdateAgentRun?.(row, 'failed');
              const liveness = Number(row.last_heartbeat_at ?? row.dispatched_at ?? row.updated_at);
              if (row.status !== 'running' || liveness >= Number(heartbeatCutoff)) return { meta: { changes: 0 } };
              Object.assign(row, {
                status: 'failed',
                error,
                status_note: statusNote,
                completed_at: completedAt,
                updated_at: updatedAt,
              });
              return { meta: { changes: 1 } };
            }
            if (query.startsWith('UPDATE agent_runs')) {
              const [status, sandboxId, branch, commitSha, prUrl, ciUrl, summary, error, statusNote, lastEventId, lastHeartbeatAt, lastDispatchError, completedAt, updatedAt, id] = values;
              const row = db.agentRuns.find((r) => r.id === id);
              if (!row) return { meta: { changes: 0 } };
              db.beforeUpdateAgentRun?.(row, status);
              Object.assign(row, {
                status,
                sandbox_id: sandboxId,
                branch,
                commit_sha: commitSha,
                pr_url: prUrl,
                ci_url: ciUrl,
                summary,
                error,
                status_note: statusNote,
                last_event_id: lastEventId,
                last_heartbeat_at: lastHeartbeatAt,
                last_dispatch_error: lastDispatchError,
                completed_at: completedAt,
                updated_at: updatedAt,
              });
              return { meta: { changes: 1 } };
            }
            if (query.startsWith('INSERT INTO agent_run_events')) {
              const [id, projectId, runId, provider, eventType, providerDeliveryId, providerEntityId, dedupeKey, actorType, handling, handlingReason, payloadJson, occurredAt, receivedAt, processedAt, createdAt] = values;
              if (db.events.some((r) => r.dedupe_key === dedupeKey)) return { meta: { changes: 0 } };
              db.events.push({
                id,
                project_id: projectId,
                run_id: runId,
                provider,
                event_type: eventType,
                provider_delivery_id: providerDeliveryId,
                provider_entity_id: providerEntityId,
                dedupe_key: dedupeKey,
                actor_type: actorType,
                handling,
                handling_reason: handlingReason,
                payload_json: payloadJson,
                occurred_at: occurredAt,
                received_at: receivedAt,
                processed_at: processedAt,
                created_at: createdAt,
              });
              return { meta: { changes: 1 } };
            }
            if (query.startsWith('INSERT INTO agent_run_notifications')) {
              const [id, projectId, runId, channel, notificationType, dedupeKey, targetRef, status, providerMessageId, error, createdAt, sentAt] = values;
              if (db.notifications.some((r) => r.dedupe_key === dedupeKey)) return { meta: { changes: 0 } };
              db.notifications.push({
                id,
                project_id: projectId,
                run_id: runId,
                channel,
                notification_type: notificationType,
                dedupe_key: dedupeKey,
                target_ref: targetRef,
                status,
                provider_message_id: providerMessageId,
                error,
                created_at: createdAt,
                sent_at: sentAt,
              });
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          },
        };
      },
    };
  }
}

// Fresh counter per instance; create ONE per test and thread it through every op so run ids stay
// unique within a test (matches the seq() factory in agent-runs.test.ts) without module-level state.
function seq() {
  let n = 0;
  return {
    id: () => `run-${++n}`,
    now: () => 2000 + n,
  };
}

const runnerDeps = { runnerUrl: 'https://runner', runnerToken: 't', hatcheryPublicUrl: 'https://hatchery', fetch: async () => new Response('{}') };

test('createContinuationRun targets the parent branch and carries the feedback', async () => {
  const db = new FakeD1();
  const clock = seq();
  const { run: parent0 } = await createAgentRun(db, { projectId: 'p1', sourceType: 'linear', idempotencyKey: 'parent', targetRepo: 'https://github.com/o/r', branch: 'hatchery/eng-1' }, clock);
  await updateAgentRun(db, { id: parent0.id, status: 'waiting_approval', prUrl: 'https://github.com/o/r/pull/5' }, clock);
  const parent = (await getAgentRunById(db, parent0.id))!;

  const out = await createContinuationRun(
    db,
    { projectId: 'p1', parent, feedback: 'use the existing helper', source: { type: 'linear', id: 'deliv-1' }, replyTarget: { surface: 'linear', ref: 'ISSUE-1' } },
    { ...runnerDeps, ...clock },
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

test('createContinuationRun dedupes when a run is actively working the branch (named lossy limitation)', async () => {
  const db = new FakeD1();
  const clock = seq();
  const { run: parent } = await createAgentRun(db, { projectId: 'p1', sourceType: 'linear', idempotencyKey: 'p', targetRepo: 'r', branch: 'br-1' }, clock);
  // parent is 'queued' = actively working -> a second feedback is dropped
  const out = await createContinuationRun(db, { projectId: 'p1', parent, feedback: 'late comment', source: { type: 'linear', id: 'd2' }, replyTarget: { surface: 'linear', ref: 'I' } }, { ...runnerDeps, ...clock });
  assert.equal(out.status, 'deduped');
});

test('createContinuationRun ignores a parent with no branch yet', async () => {
  const db = new FakeD1();
  const clock = seq();
  const { run: parent } = await createAgentRun(db, { projectId: 'p1', sourceType: 'linear', idempotencyKey: 'p', targetRepo: 'r' }, clock); // branch null
  const out = await createContinuationRun(db, { projectId: 'p1', parent, feedback: 'x', source: { type: 'linear', id: 'd3' }, replyTarget: { surface: 'linear', ref: 'I' } }, { ...runnerDeps, ...clock });
  assert.equal(out.status, 'ignored');
});

await run();
