// Nango-forwarded provider event invariants — run: npx tsx src/agent-runs/provider-events.test.ts
import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import type { D1Like } from '../skills/repository';
import { handleNangoForwardWebhook } from './provider-events';

const { test, run } = createTestRunner();

type Row = Record<string, unknown>;

class FakeD1 implements D1Like {
  connections: Row[] = [];
  agentRuns: Row[] = [];
  events: Row[] = [];
  notifications: Row[] = [];

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
            if (query.includes('FROM connections')) {
              if (query.includes('connection_ref=?')) {
                const [connectionRef] = values;
                return { results: db.connections.filter((r) => r.connection_ref === connectionRef && r.status === 'active') as T[] };
              }
            }
            if (query.includes('FROM agent_runs')) {
              if (query.includes('pr_url=?')) {
                const [projectId, prUrl] = values;
                return { results: db.agentRuns.filter((r) => r.project_id === projectId && r.pr_url === prUrl) as T[] };
              }
              if (query.includes('branch=?')) {
                const [projectId, branch] = values;
                return { results: db.agentRuns.filter((r) => r.project_id === projectId && r.branch === branch) as T[] };
              }
              if (query.includes('commit_sha=?')) {
                const [projectId, commitSha] = values;
                return { results: db.agentRuns.filter((r) => r.project_id === projectId && r.commit_sha === commitSha) as T[] };
              }
              if (query.includes('WHERE id=?')) {
                const [id] = values;
                return { results: db.agentRuns.filter((r) => r.id === id) as T[] };
              }
            }
            if (query.includes('FROM agent_run_events')) {
              if (query.includes('WHERE dedupe_key=?')) {
                const [dedupeKey] = values;
                return { results: db.events.filter((r) => r.dedupe_key === dedupeKey) as T[] };
              }
            }
            if (query.includes('FROM agent_run_notifications')) {
              if (query.includes('WHERE dedupe_key=?')) {
                const [dedupeKey] = values;
                return { results: db.notifications.filter((r) => r.dedupe_key === dedupeKey) as T[] };
              }
            }
            return { results: [] as T[] };
          },
          async run(): Promise<{ meta: { changes: number } }> {
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
            if (query.startsWith('UPDATE agent_runs')) {
              const [status, sandboxId, branch, commitSha, prUrl, ciUrl, summary, error, statusNote, lastEventId, lastHeartbeatAt, completedAt, updatedAt, id] = values;
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
                completed_at: completedAt,
                updated_at: updatedAt,
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
    id: () => `id-${++n}`,
    now: () => 20_000 + n,
  };
}

function seed(db: FakeD1) {
  db.connections.push({ project_id: 'P', provider: 'github', connection_ref: 'conn_gh', status: 'active' });
  db.agentRuns.push({
    id: 'run-1',
    project_id: 'P',
    route_id: 'route-1',
    source_type: 'linear',
    source_id: 'linear-delivery-1',
    idempotency_key: 'linear:issue:issue-1:state:Run Agent',
    linear_issue_id: 'issue-1',
    linear_identifier: 'EDK-1',
    linear_url: 'https://linear.app/acme/issue/EDK-1',
    slack_team_id: null,
    slack_channel_id: null,
    slack_thread_ts: null,
    github_owner: 'acme',
    github_repo: 'repo',
    target_repo: 'https://github.com/acme/repo',
    base_branch: 'main',
    kit: 'coding-default',
    runtime: 'opencode',
    sandbox_provider: 'e2b',
    sandbox_id: 'sbx_1',
    status: 'waiting_approval',
    branch: 'agent/EDK-1',
    commit_sha: 'abc123',
    pr_url: 'https://github.com/acme/repo/pull/7',
    ci_url: null,
    summary: null,
    error: null,
    status_note: null,
    last_event_id: null,
    last_heartbeat_at: null,
    created_at: 1,
    updated_at: 1,
    completed_at: null,
  });
  db.notifications.push({
    id: 'existing-notification',
    project_id: 'P',
    run_id: 'run-1',
    channel: 'linear',
    notification_type: 'pr_opened',
    dedupe_key: 'notify:run-1:pr_opened:linear',
    target_ref: 'issue-1',
    status: 'pending',
    provider_message_id: null,
    error: null,
    created_at: 1,
    sent_at: null,
  });
}

function githubPrPayload(action: string, merged = false) {
  return {
    type: 'forward',
    connectionId: 'conn_gh',
    providerConfigKey: 'github',
    payload: {
      action,
      headers: { 'X-GitHub-Delivery': 'gh-delivery-1', 'X-GitHub-Event': 'pull_request' },
      pull_request: {
        id: 987,
        number: 7,
        html_url: 'https://github.com/acme/repo/pull/7',
        merged,
        head: { ref: 'agent/EDK-1', sha: 'abc123' },
      },
      sender: { type: 'User', login: 'octo' },
    },
  };
}

function githubIssueCommentPayload(senderType = 'User') {
  return {
    type: 'forward',
    connectionId: 'conn_gh',
    providerConfigKey: 'github',
    payload: {
      action: 'created',
      headers: { 'X-GitHub-Delivery': `gh-comment-${senderType}`, 'X-GitHub-Event': 'issue_comment' },
      issue: {
        id: 55,
        pull_request: { html_url: 'https://github.com/acme/repo/pull/7' },
      },
      comment: { id: 123, body: 'Added the missing context.' },
      sender: { type: senderType, login: senderType === 'Bot' ? 'hatchery[bot]' : 'octo' },
    },
  };
}

test('Nango github forward resolves connection_ref, records event, correlates run, and dedupes notification echoes', async () => {
  const db = new FakeD1();
  seed(db);

  const result = await handleNangoForwardWebhook({ db, rawBody: JSON.stringify(githubPrPayload('opened')) }, seq());
  const duplicate = await handleNangoForwardWebhook({ db, rawBody: JSON.stringify(githubPrPayload('opened')) }, seq());

  assert.equal(result.status, 200);
  assert.equal(result.body?.handled, true);
  assert.equal(result.body?.event?.eventType, 'github.pull_request.opened');
  assert.equal(db.events.length, 1);
  assert.equal(db.events[0].dedupe_key, 'nango-forward:conn_gh:github:gh-delivery-1');
  assert.equal(db.events[0].run_id, 'run-1');
  assert.equal(db.events[0].handling, 'notify');
  assert.equal(duplicate.body?.duplicate, true);
  assert.equal(db.notifications.filter((n) => n.notification_type === 'pr_opened').length, 1, 'GitHub echo does not double notify after runner callback');
});

test('Nango github forward treats github-pat as an integration key, not the provider', async () => {
  const db = new FakeD1();
  seed(db);
  const payload = githubPrPayload('opened');
  payload.providerConfigKey = 'github-pat';

  const result = await handleNangoForwardWebhook({ db, rawBody: JSON.stringify(payload) }, seq());

  assert.equal(result.status, 200);
  assert.equal(result.body?.handled, true);
  assert.equal(db.events[0].provider, 'github');
  assert.equal(db.events[0].dedupe_key, 'nango-forward:conn_gh:github:gh-delivery-1');
});

test('Nango github pull_request merged completes the correlated run', async () => {
  const db = new FakeD1();
  seed(db);

  const result = await handleNangoForwardWebhook({ db, rawBody: JSON.stringify(githubPrPayload('closed', true)) }, seq());

  assert.equal(result.status, 200);
  assert.equal(db.events[0].event_type, 'github.pull_request.merged');
  assert.equal(db.agentRuns[0].status, 'completed');
  assert.equal(db.agentRuns[0].last_event_id, db.events[0].id);
  assert.equal(db.notifications.filter((n) => n.notification_type === 'completed').length, 1);
});

test('GitHub human comments on waiting_human runs wake the controller; bot comments are record_only', async () => {
  const db = new FakeD1();
  seed(db);
  db.agentRuns[0].status = 'waiting_human';

  const human = await handleNangoForwardWebhook({ db, rawBody: JSON.stringify(githubIssueCommentPayload('User')) }, seq());
  const bot = await handleNangoForwardWebhook({ db, rawBody: JSON.stringify(githubIssueCommentPayload('Bot')) }, seq());

  assert.equal(human.body?.handling, 'wake_controller');
  assert.equal(db.events[0].handling, 'wake_controller');
  assert.equal(bot.body?.handling, 'record_only');
  assert.equal(db.events[1].handling, 'record_only');
});

test('Nango unknown connection and unattributed payloads are acknowledged but not acted on', async () => {
  const db = new FakeD1();
  seed(db);

  const unknown = await handleNangoForwardWebhook({ db, rawBody: JSON.stringify({ ...githubPrPayload('opened'), connectionId: 'missing' }) }, seq());
  const rawForward = await handleNangoForwardWebhook({ db, rawBody: JSON.stringify({ action: 'opened', pull_request: { html_url: 'https://github.com/acme/repo/pull/7' } }) }, seq());

  assert.equal(unknown.status, 200);
  assert.equal(unknown.body?.ignored, 'unknown connection');
  assert.equal(rawForward.status, 200);
  assert.equal(rawForward.body?.ignored, 'unattributed forward');
  assert.equal(db.events.length, 0);
  assert.equal(db.agentRuns[0].status, 'waiting_approval');
});

await run();
