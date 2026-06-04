// Linear agent-run ingress invariants — run: npx tsx src/agent-runs/linear.test.ts
import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import type { D1Like } from '../skills/repository';
import { handleLinearComment, handleLinearWebhook, parseLinearAgentProjects, verifyLinearWebhook } from './linear';
import { createAgentRun } from './repository';

const { test, run } = createTestRunner();

type Row = Record<string, unknown>;

class FakeD1 implements D1Like {
  agentRuns: Row[] = [];
  routes: Row[] = [];
  events: Row[] = [];
  notifications: Row[] = [];
  ops: string[] = [];

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
              if (query.includes("status IN ('queued','dispatching','running')")) {
                const [projectId, branch] = values;
                const activeStatuses = new Set(['queued', 'dispatching', 'running']);
                const rows = db.agentRuns
                  .filter((r) => r.project_id === projectId && r.branch === branch && activeStatuses.has(String(r.status)))
                  .sort((a, b) => Number(b.created_at) - Number(a.created_at));
                return { results: rows as T[] };
              }
            }
            if (query.startsWith('SELECT') && query.includes('FROM agent_run_routes')) {
              if (query.includes("status='active'")) {
                const [provider, externalKey, triggerType, triggerValue] = values;
                return {
                  results: db.routes
                    .filter(
                      (r) =>
                        r.provider === provider &&
                        r.external_key === externalKey &&
                        r.trigger_type === triggerType &&
                        r.trigger_value === triggerValue &&
                        r.status === 'active',
                    )
                    .sort((a, b) => Number(b.priority ?? 0) - Number(a.priority ?? 0)) as T[],
                };
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
              db.ops.push('agent_run');
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
            if (query.startsWith('UPDATE agent_runs')) {
              const [status, sandboxId, branch, commitSha, prUrl, ciUrl, summary, error, statusNote, lastEventId, lastHeartbeatAt, lastDispatchError, completedAt, updatedAt, id] = values;
              const row = db.agentRuns.find((r) => r.id === id);
              if (!row) return { meta: { changes: 0 } };
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
              db.ops.push('event');
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

function seq() {
  let n = 0;
  return {
    id: () => `run-${++n}`,
    now: () => 2_000_000 + n,
  };
}

async function hmac(signingKey: string, raw: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(signingKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const SECRET = 'linear-secret';
const NOW = 2_000_000;
const sign = (secret: string, raw: string) => hmac(secret, raw);

function issuePayload(stateName = 'Run Agent', previousStateName = 'Backlog') {
  return {
    action: 'update',
    type: 'Issue',
    webhookTimestamp: 2_000_000,
    organizationId: 'org-1',
    data: {
      id: 'issue-1',
      identifier: 'LIN-42',
      title: 'Fix auth bug',
      description: 'Use a workflow and open a PR.',
      url: 'https://linear.app/acme/issue/LIN-42/fix-auth-bug',
      team: { id: 'team-1', key: 'LIN', name: 'Linear Team' },
      state: { id: 'state-1', name: stateName },
    },
    updatedFrom: {
      state: { id: 'state-0', name: previousStateName },
    },
  };
}

function issuePayloadWithPreviousStateId(stateName = 'Run Agent') {
  return {
    ...issuePayload(stateName),
    updatedFrom: {
      stateId: 'state-0',
    },
  };
}

const projectsJson = JSON.stringify({
  LIN: {
    projectId: 'P',
    targetRepo: 'github.com/acme/repo',
    baseBranch: 'main',
    kit: 'coding-default',
    runtime: 'pi',
    sandboxProvider: 'e2b',
    runStateName: 'Run Agent',
  },
});

function addActiveRoute(db: FakeD1, runtime = 'pi') {
  db.routes.push({
    id: 'route-1',
    project_id: 'P',
    provider: 'linear',
    external_key: 'LIN',
    trigger_type: 'state',
    trigger_value: 'Run Agent',
    github_owner: 'acme',
    github_repo: 'repo',
    base_branch: 'main',
    kit: 'coding-default',
    runtime,
    sandbox_provider: 'e2b',
    priority: 0,
    status: 'active',
    created_by_type: 'admin',
    created_by: 'admin-1',
    reason: 'test route',
    created_at: 1,
    updated_at: 1,
    activated_by: 'admin-1',
    activated_at: 1,
    disabled_by: null,
    disabled_at: null,
  });
}

test('parseLinearAgentProjects accepts team key/id project config and defaults runtime fields', () => {
  const parsed = parseLinearAgentProjects(JSON.stringify({ LIN: { projectId: 'P', targetRepo: 'github.com/acme/repo' } }));
  assert.equal(parsed.get('LIN')?.projectId, 'P');
  assert.equal(parsed.get('LIN')?.baseBranch, 'main');
  assert.equal(parsed.get('LIN')?.runtime, 'pi');
  assert.equal(parsed.get('LIN')?.sandboxProvider, 'e2b');
});

test('parseLinearAgentProjects clearly fails legacy non-Pi runtime config', () => {
  assert.throws(
    () =>
      parseLinearAgentProjects(
        JSON.stringify({
          LIN: { projectId: 'P', targetRepo: 'github.com/acme/repo', runtime: 'opencode' },
        }),
      ),
    /runtime "opencode" is not supported/i,
  );
});

test('verifyLinearWebhook accepts raw-body HMAC and rejects wrong signatures', async () => {
  const raw = JSON.stringify(issuePayload());
  const signature = await hmac('linear-secret', raw);
  assert.equal(await verifyLinearWebhook('linear-secret', raw, signature), true);
  assert.equal(await verifyLinearWebhook('linear-secret', raw, signature.toUpperCase()), true);
  assert.equal(await verifyLinearWebhook('linear-secret', raw, 'deadbeef'), false);
  assert.equal(await verifyLinearWebhook('', raw, signature), false);
});

test('handleLinearWebhook rejects missing/wrong signature and stale timestamps', async () => {
  const raw = JSON.stringify(issuePayload());
  const stale = JSON.stringify({ ...issuePayload(), webhookTimestamp: 1_000_000 });
  const staleSig = await hmac('linear-secret', stale);

  const missing = await handleLinearWebhook(
    { db: new FakeD1(), signingSecret: 'linear-secret', signature: undefined, deliveryId: 'delivery-1', event: 'Issue', rawBody: raw, projectsJson, nowMs: 2_000_000 },
    { fetch: async () => new Response('{}'), runnerUrl: 'https://runner.example/run', runnerToken: 'runner-secret', ...seq() },
  );
  assert.equal(missing.status, 404);

  const bad = await handleLinearWebhook(
    { db: new FakeD1(), signingSecret: 'linear-secret', signature: 'wrong', deliveryId: 'delivery-1', event: 'Issue', rawBody: raw, projectsJson, nowMs: 2_000_000 },
    { fetch: async () => new Response('{}'), runnerUrl: 'https://runner.example/run', runnerToken: 'runner-secret', ...seq() },
  );
  assert.equal(bad.status, 404);

  const old = await handleLinearWebhook(
    { db: new FakeD1(), signingSecret: 'linear-secret', signature: staleSig, deliveryId: 'delivery-1', event: 'Issue', rawBody: stale, projectsJson, nowMs: 2_000_000 },
    { fetch: async () => new Response('{}'), runnerUrl: 'https://runner.example/run', runnerToken: 'runner-secret', ...seq() },
  );
  assert.equal(old.status, 400);
  assert.match(String(old.body?.error), /stale/i);
});

test('handleLinearWebhook creates one agent_run and dispatches expected E2B Pi payload', async () => {
  const db = new FakeD1();
  const raw = JSON.stringify(issuePayload());
  const signature = await hmac('linear-secret', raw);
  const sent: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];

  const result = await handleLinearWebhook(
    { db, signingSecret: 'linear-secret', signature, deliveryId: 'delivery-1', event: 'Issue', rawBody: raw, projectsJson, nowMs: 2_000_000 },
    {
      runnerUrl: 'https://runner.example/run',
      runnerToken: 'runner-secret',
      hatcheryPublicUrl: 'https://hatchery.example',
      fetch: (async (url: unknown, init: unknown) => {
        sent.push({ url: String(url), init: init as RequestInit, body: JSON.parse(String((init as RequestInit).body)) });
        return new Response(JSON.stringify({ sandboxId: 'sbx_1' }), { status: 202 });
      }) as typeof fetch,
      ...seq(),
    },
  );

  assert.equal(result.status, 200);
  assert.equal(result.body?.dispatchStatus, 'queued', 'webhook records the run and defers dispatch off the ack path');
  assert.equal(db.agentRuns.length, 1);
  assert.equal(db.agentRuns[0].status, 'queued');
  assert.equal(sent.length, 0, 'nothing sent to the runner until the deferred dispatch runs');

  await result.dispatch?.();

  assert.equal(db.agentRuns[0].status, 'running');
  assert.equal(db.agentRuns[0].sandbox_id, 'sbx_1');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://runner.example/run');
  assert.equal((sent[0].init.headers as Record<string, string>)['x-hatchery-agent-runner-token'], 'runner-secret');
  assert.equal(JSON.stringify(sent[0].body).includes('runner-secret'), false);
  assert.deepEqual(sent[0].body.callback, {
    url: 'https://hatchery.example/__internal/agent-runs',
    authHeader: 'x-hatchery-agent-runner-token',
  });
  assert.equal(sent[0].body.runtime, 'pi');
  assert.equal(sent[0].body.kit, 'coding-default');
  assert.equal(sent[0].body.sandboxProvider, 'e2b');
  assert.equal((sent[0].body.linearIssue as Record<string, unknown>).identifier, 'LIN-42');
});

test('handleLinearWebhook matches active route config and writes event before dispatching run', async () => {
  const db = new FakeD1();
  addActiveRoute(db);
  const raw = JSON.stringify(issuePayload());
  const signature = await hmac('linear-secret', raw);
  const sent: { body: Record<string, unknown> }[] = [];

  const result = await handleLinearWebhook(
    { db, signingSecret: 'linear-secret', signature, deliveryId: 'delivery-route-1', event: 'Issue', rawBody: raw, projectsJson: undefined, nowMs: 2_000_000 },
    {
      runnerUrl: 'https://runner.example/run',
      runnerToken: 'runner-secret',
      fetch: (async (_url: unknown, init: unknown) => {
        sent.push({ body: JSON.parse(String((init as RequestInit).body)) });
        return new Response(JSON.stringify({ sandboxId: 'sbx_route' }), { status: 202 });
      }) as typeof fetch,
      ...seq(),
    },
  );

  assert.equal(result.status, 200);
  assert.equal(result.body?.dispatchStatus, 'queued');
  assert.equal(db.events.length, 1);
  assert.equal(db.events[0].event_type, 'linear.issue.state_changed');
  assert.equal(db.events[0].provider_delivery_id, 'delivery-route-1');
  assert.equal(db.agentRuns[0].route_id, 'route-1');
  assert.equal(db.agentRuns[0].github_owner, 'acme');
  assert.equal(db.agentRuns[0].github_repo, 'repo');
  assert.equal(db.ops.indexOf('event') < db.ops.indexOf('agent_run'), true, 'event receipt is written before run lease');

  await result.dispatch?.();
  assert.equal(sent[0].body.targetRepo, 'https://github.com/acme/repo');
  assert.equal(db.agentRuns[0].status, 'running');
});

test('handleLinearWebhook clearly fails legacy active route runtime before dispatch', async () => {
  const db = new FakeD1();
  addActiveRoute(db, 'opencode');
  const raw = JSON.stringify(issuePayload());
  const signature = await hmac('linear-secret', raw);
  let calls = 0;

  const result = await handleLinearWebhook(
    { db, signingSecret: 'linear-secret', signature, deliveryId: 'delivery-legacy-route', event: 'Issue', rawBody: raw, projectsJson: undefined, nowMs: 2_000_000 },
    {
      runnerUrl: 'https://runner.example/run',
      runnerToken: 'runner-secret',
      fetch: (async () => {
        calls++;
        return new Response('{}', { status: 202 });
      }) as typeof fetch,
      ...seq(),
    },
  );

  assert.equal(result.status, 400);
  assert.match(String(result.body?.error), /agent_run_routes runtime "opencode" is not supported/i);
  assert.equal(calls, 0);
  assert.equal(db.agentRuns.length, 0);
});

test('handleLinearWebhook dedupes duplicate deliveries and repeated issue payloads', async () => {
  const db = new FakeD1();
  const raw = JSON.stringify(issuePayload());
  const signature = await hmac('linear-secret', raw);
  let calls = 0;
  const deps = {
    runnerUrl: 'https://runner.example/run',
    runnerToken: 'runner-secret',
    fetch: (async () => {
      calls++;
      return new Response('{}', { status: 202 });
    }) as typeof fetch,
    ...seq(),
  };

  const first = await handleLinearWebhook(
    { db, signingSecret: 'linear-secret', signature, deliveryId: 'delivery-1', event: 'Issue', rawBody: raw, projectsJson, nowMs: 2_000_000 },
    deps,
  );
  const duplicateDelivery = await handleLinearWebhook(
    { db, signingSecret: 'linear-secret', signature, deliveryId: 'delivery-1', event: 'Issue', rawBody: raw, projectsJson, nowMs: 2_000_000 },
    deps,
  );
  const repeatedIssue = await handleLinearWebhook(
    { db, signingSecret: 'linear-secret', signature, deliveryId: 'delivery-2', event: 'Issue', rawBody: raw, projectsJson, nowMs: 2_000_000 },
    deps,
  );

  assert.equal(first.body?.dispatchStatus, 'queued');
  assert.equal(duplicateDelivery.body?.dispatchStatus, 'deduped');
  assert.equal(repeatedIssue.body?.dispatchStatus, 'deduped');
  assert.equal(db.agentRuns.length, 1);
  assert.equal(duplicateDelivery.dispatch, undefined, 'a deduped delivery carries no dispatch');
  assert.equal(repeatedIssue.dispatch, undefined);

  await first.dispatch?.();
  assert.equal(calls, 1, 'only the first delivery ever reaches the runner');
});

test('handleLinearWebhook treats Linear stateId updates as state transitions', async () => {
  const db = new FakeD1();
  const raw = JSON.stringify(issuePayloadWithPreviousStateId());
  const signature = await hmac('linear-secret', raw);
  let calls = 0;

  const result = await handleLinearWebhook(
    { db, signingSecret: 'linear-secret', signature, deliveryId: 'delivery-state-id', event: 'Issue', rawBody: raw, projectsJson, nowMs: 2_000_000 },
    {
      runnerUrl: 'https://runner.example/run',
      runnerToken: 'runner-secret',
      fetch: (async () => {
        calls++;
        return new Response(JSON.stringify({ sandboxId: 'sandbox-1' }), { status: 202 });
      }) as typeof fetch,
      ...seq(),
    },
  );

  assert.equal(result.body?.dispatchStatus, 'queued');
  assert.equal(db.agentRuns.length, 1);
  await result.dispatch?.();
  assert.equal(calls, 1);
});

test('handleLinearWebhook ignores non-Run-Agent state changes and requeues a transient dispatch failure', async () => {
  const ignoredRaw = JSON.stringify(issuePayload('In Progress', 'Backlog'));
  const ignoredSig = await hmac('linear-secret', ignoredRaw);
  const ignored = await handleLinearWebhook(
    { db: new FakeD1(), signingSecret: 'linear-secret', signature: ignoredSig, deliveryId: 'delivery-ignored', event: 'Issue', rawBody: ignoredRaw, projectsJson, nowMs: 2_000_000 },
    { fetch: async () => new Response('{}'), runnerUrl: 'https://runner.example/run', runnerToken: 'runner-secret', ...seq() },
  );
  assert.deepEqual(ignored.body, { skipped: 'not a Run Agent transition' });

  const db = new FakeD1();
  const raw = JSON.stringify(issuePayload());
  const signature = await hmac('linear-secret', raw);
  const failed = await handleLinearWebhook(
    { db, signingSecret: 'linear-secret', signature, deliveryId: 'delivery-fail', event: 'Issue', rawBody: raw, projectsJson, nowMs: 2_000_000 },
    {
      fetch: async () => new Response(JSON.stringify({ error: 'down' }), { status: 503 }),
      runnerUrl: 'https://runner.example/run',
      runnerToken: 'runner-secret',
      ...seq(),
    },
  );
  assert.equal(failed.body?.dispatchStatus, 'queued');
  await failed.dispatch?.();
  assert.equal(db.agentRuns[0].status, 'queued', 'a transient 503 requeues for the reconciler, not a terminal fail');
  assert.equal(db.agentRuns[0].dispatch_attempts, 1);
  assert.match(String(db.agentRuns[0].last_dispatch_error), /503/);
});

// Self-trigger guard + rerun gate
test('handleLinearWebhook records a non-human actor transition but never dispatches a run', async () => {
  const db = new FakeD1();
  const raw = JSON.stringify({ ...issuePayload(), actor: { id: 'bot-actor', type: 'application', name: 'Hatchery' } });
  const signature = await hmac('linear-secret', raw);
  let calls = 0;

  const result = await handleLinearWebhook(
    { db, signingSecret: 'linear-secret', signature, deliveryId: 'delivery-bot', event: 'Issue', rawBody: raw, projectsJson, nowMs: 2_000_000 },
    {
      runnerUrl: 'https://runner.example/run',
      runnerToken: 'runner-secret',
      fetch: (async () => {
        calls++;
        return new Response('{}', { status: 202 });
      }) as typeof fetch,
      ...seq(),
    },
  );

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { skipped: 'non-human actor; recorded only' });
  assert.equal(result.dispatch, undefined);
  assert.equal(db.agentRuns.length, 0, 'no run created for a bot-driven transition');
  assert.equal(db.events.at(-1)?.handling, 'record_only');
  assert.equal(db.events.at(-1)?.actor_type, 'provider_bot');
  assert.equal(calls, 0);
});

test('handleLinearWebhook re-runs an issue once the prior run is terminal, but dedupes while it is active', async () => {
  const db = new FakeD1();
  const raw = JSON.stringify(issuePayload());
  const signature = await hmac('linear-secret', raw);
  const deps = {
    runnerUrl: 'https://runner.example/run',
    runnerToken: 'runner-secret',
    fetch: (async () => new Response(JSON.stringify({ sandboxId: 'sbx' }), { status: 202 })) as typeof fetch,
    ...seq(),
  };

  // First trigger → one run, dispatched to running.
  const first = await handleLinearWebhook(
    { db, signingSecret: 'linear-secret', signature, deliveryId: 'd1', event: 'Issue', rawBody: raw, projectsJson, nowMs: 2_000_000 },
    deps,
  );
  await first.dispatch?.();
  assert.equal(db.agentRuns.length, 1);
  assert.equal(db.agentRuns[0].status, 'running');

  // Re-entering the trigger state while the run is still active dedupes (no second run).
  const whileActive = await handleLinearWebhook(
    { db, signingSecret: 'linear-secret', signature, deliveryId: 'd2', event: 'Issue', rawBody: raw, projectsJson, nowMs: 2_000_000 },
    deps,
  );
  assert.equal(whileActive.body?.dispatchStatus, 'deduped');
  assert.equal(db.agentRuns.length, 1);

  // Once it's terminal, a fresh transition mints a new run.
  db.agentRuns[0].status = 'completed';
  const rerun = await handleLinearWebhook(
    { db, signingSecret: 'linear-secret', signature, deliveryId: 'd3', event: 'Issue', rawBody: raw, projectsJson, nowMs: 2_000_000 },
    deps,
  );
  assert.equal(rerun.body?.duplicate, false);
  assert.equal(db.agentRuns.length, 2, 'terminal prior run → rerun allowed');
});

test('handleLinearWebhook does not create a rerun from the same Linear delivery replayed after terminal', async () => {
  const db = new FakeD1();
  const raw = JSON.stringify(issuePayload());
  const signature = await hmac('linear-secret', raw);
  const deps = {
    runnerUrl: 'https://runner.example/run',
    runnerToken: 'runner-secret',
    fetch: (async () => new Response(JSON.stringify({ sandboxId: 'sbx' }), { status: 202 })) as typeof fetch,
    ...seq(),
  };

  const first = await handleLinearWebhook(
    { db, signingSecret: 'linear-secret', signature, deliveryId: 'd1', event: 'Issue', rawBody: raw, projectsJson, nowMs: 2_000_000 },
    deps,
  );
  await first.dispatch?.();
  db.agentRuns[0].status = 'completed';

  const replay = await handleLinearWebhook(
    { db, signingSecret: 'linear-secret', signature, deliveryId: 'd1', event: 'Issue', rawBody: raw, projectsJson, nowMs: 2_000_000 },
    deps,
  );

  assert.equal(replay.body?.dispatchStatus, 'deduped');
  assert.equal(replay.dispatch, undefined);
  assert.equal(db.agentRuns.length, 1);
});

test('handleLinearComment records a boundary event and spawns a continuation for a human comment', async () => {
  const db = new FakeD1();
  await createAgentRun(db, { projectId: 'p1', sourceType: 'linear', idempotencyKey: 'parent', targetRepo: 'https://github.com/o/r', linearIssueId: 'ISSUE-1', branch: 'hatchery/eng-1' }, seq());
  // Parent must be in waiting_approval (PR open, idle) so continuation is not blocked by active-branch dedupe.
  db.agentRuns[0].status = 'waiting_approval';
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
  db.agentRuns[0].status = 'waiting_approval';
  const raw = JSON.stringify({ action: 'create', type: 'Comment', webhookTimestamp: NOW, actor: { type: 'user' }, data: { id: 'c1', body: 'hi', issueId: 'ISSUE-1' } });
  const args = { db, signingSecret: SECRET, signature: await sign(SECRET, raw), deliveryId: 'dup-1', event: 'Comment', rawBody: raw, projectsJson: undefined, nowMs: NOW };
  await handleLinearComment(args, { ...seq() });
  const second = await handleLinearComment(args, { ...seq() }); // same delivery id
  assert.equal(second.body.dispatchStatus, 'deduped');
});

test('handleLinearComment skips a bot comment (self-trigger guard)', async () => {
  const db = new FakeD1();
  await createAgentRun(db, { projectId: 'p1', sourceType: 'linear', idempotencyKey: 'parent', targetRepo: 'r', linearIssueId: 'ISSUE-1', branch: 'b' }, seq());
  const raw = JSON.stringify({ action: 'create', type: 'Comment', webhookTimestamp: NOW, actor: { type: 'app', name: 'Hatchery' }, data: { id: 'c2', body: 'auto', issueId: 'ISSUE-1' } });
  const res = await handleLinearComment({ db, signingSecret: SECRET, signature: await sign(SECRET, raw), deliveryId: 'd2', event: 'Comment', rawBody: raw, projectsJson: undefined, nowMs: NOW }, { ...seq() });
  assert.equal(res.body.skipped, 'non-human actor');
});

test('handleLinearComment skips (no event written) when no run exists for the issue', async () => {
  const db = new FakeD1();
  const raw = JSON.stringify({ action: 'create', type: 'Comment', webhookTimestamp: NOW, actor: { type: 'user' }, data: { id: 'c3', body: 'hi', issueId: 'UNKNOWN' } });
  const res = await handleLinearComment({ db, signingSecret: SECRET, signature: await sign(SECRET, raw), deliveryId: 'd3', event: 'Comment', rawBody: raw, projectsJson: undefined, nowMs: NOW }, { ...seq() });
  assert.equal(res.body.skipped, 'no run for issue');
  assert.equal(db.events.length, 0);
});

test('handleLinearComment parses the provisional real-shape fixture', async () => {
  const fixture = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync('tests/fixtures/linear-comment-webhook.json', 'utf8')));
  const ts = fixture.webhookTimestamp;
  const db = new FakeD1();
  await createAgentRun(db, { projectId: 'p1', sourceType: 'linear', idempotencyKey: 'parent', targetRepo: 'r', linearIssueId: fixture.data.issueId, branch: 'br' }, seq());
  // Set to waiting_approval so continuation is not blocked by active-branch dedupe.
  db.agentRuns[0].status = 'waiting_approval';
  const raw = JSON.stringify(fixture);
  const res = await handleLinearComment({ db, signingSecret: SECRET, signature: await sign(SECRET, raw), deliveryId: 'fx-1', event: 'Comment', rawBody: raw, projectsJson: undefined, nowMs: ts }, { runnerUrl: 'https://r', runnerToken: 't', hatcheryPublicUrl: 'https://h', fetch: async () => new Response('{}'), ...seq() });
  assert.equal(res.body.dispatchStatus, 'queued');
});

await run();
