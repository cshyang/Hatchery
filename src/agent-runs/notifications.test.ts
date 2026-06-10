// Agent-run notification delivery invariants — run: npx tsx src/agent-runs/notifications.test.ts

import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import type { Binding } from '../project/bindings';
import type { D1Like } from '../skills/repository';
import { deliverPendingSlackRunNotifications } from './notifications';

const { test, run } = createTestRunner();

type Row = Record<string, unknown>;

class FakeD1 implements D1Like {
  runs: Row[] = [];
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
            if (query.includes('FROM agent_run_notifications') && query.includes("channel='slack'") && query.includes("status='pending'")) {
              const [limit] = values;
              return {
                results: db.notifications
                  .filter((r) => r.channel === 'slack' && r.status === 'pending')
                  .sort((a, b) => Number(a.created_at) - Number(b.created_at))
                  .slice(0, Number(limit)) as T[],
              };
            }
            if (query.includes('FROM agent_runs') && query.includes('WHERE id=?')) {
              const [id] = values;
              return { results: db.runs.filter((r) => r.id === id) as T[] };
            }
            return { results: [] as T[] };
          },
          async run(): Promise<{ meta: { changes: number } }> {
            if (query.startsWith('UPDATE agent_run_notifications')) {
              const [status, providerMessageId, error, sentAt, id] = values;
              const row = db.notifications.find((r) => r.id === id);
              if (!row) return { meta: { changes: 0 } };
              Object.assign(row, {
                status,
                provider_message_id: providerMessageId,
                error,
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

function binding(): Binding {
  return {
    provider: 'slack',
    externalAccountId: 'T1',
    externalSpaceId: 'C1',
    transportBotId: 'Ubot',
    projectId: 'project_1',
    sandboxMode: 'virtual',
    transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
    status: 'active',
  };
}

function runRow(): Row {
  return {
    id: 'run-1',
    project_id: 'project_1',
    route_id: null,
    source_type: 'linear',
    source_id: 'delivery-1',
    idempotency_key: 'linear:issue:issue-1:run-agent',
    linear_issue_id: 'issue-1',
    linear_identifier: 'EDK-42',
    linear_url: 'https://linear.app/acme/issue/EDK-42/fix-slack',
    slack_team_id: null,
    slack_channel_id: null,
    slack_thread_ts: null,
    github_owner: 'acme',
    github_repo: 'widgets',
    target_repo: 'github.com/acme/widgets',
    base_branch: 'main',
    kit: 'coding-default',
    runtime: 'pi',
    sandbox_provider: 'e2b',
    sandbox_id: null,
    trigger_run_id: null,
    status: 'waiting_approval',
    branch: 'agent/EDK-42',
    commit_sha: 'abc123',
    pr_url: 'https://github.com/acme/widgets/pull/7',
    ci_url: null,
    summary: 'Ready for review',
    error: null,
    status_note: null,
    last_event_id: null,
    last_heartbeat_at: null,
    dispatch_attempts: 1,
    last_dispatch_error: null,
    dispatched_at: 123,
    dispatch_payload: null,
    created_at: 100,
    updated_at: 200,
    completed_at: null,
  };
}

function notificationRow(): Row {
  return {
    id: 'note-1',
    project_id: 'project_1',
    run_id: 'run-1',
    channel: 'slack',
    notification_type: 'pr_opened',
    dedupe_key: 'notify:run-1:pr_opened:slack',
    target_ref: null,
    status: 'pending',
    provider_message_id: null,
    error: null,
    created_at: 1000,
    sent_at: null,
  };
}

test('deliverPendingSlackRunNotifications posts one card and marks it sent', async () => {
  const db = new FakeD1();
  db.runs.push(runRow());
  db.notifications.push(notificationRow());
  const sent: Array<{ channel: string; text: string; blocks?: unknown[] }> = [];

  const summary = await deliverPendingSlackRunNotifications(
    { db, env: { SLACK_BOT_TOKEN_DEFAULT: 'xoxb-test' } },
    {
      bindingByProject: async () => binding(),
      postMessage: async (_token, channel, text, _threadTs, options) => {
        sent.push({ channel, text, blocks: options?.blocks });
        return '123.456';
      },
      now: () => 2000,
    },
  );

  assert.deepEqual(summary, { sent: 1, failed: 0, skipped: 0 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, 'C1');
  assert.match(sent[0].text, /PR opened/);
  assert.ok(sent[0].blocks?.length);
  assert.equal(db.notifications[0].status, 'sent');
  assert.equal(db.notifications[0].provider_message_id, '123.456');
  assert.equal(db.notifications[0].sent_at, 2000);
});

test('deliverPendingSlackRunNotifications marks missing Slack binding failed without throwing', async () => {
  const db = new FakeD1();
  db.runs.push(runRow());
  db.notifications.push(notificationRow());

  const summary = await deliverPendingSlackRunNotifications(
    { db, env: {} },
    {
      bindingByProject: async () => undefined,
      postMessage: async () => {
        throw new Error('should not post');
      },
      now: () => 3000,
    },
  );

  assert.deepEqual(summary, { sent: 0, failed: 1, skipped: 0 });
  assert.equal(db.notifications[0].status, 'failed');
  assert.match(String(db.notifications[0].error), /no active Slack binding/i);
});

await run();
