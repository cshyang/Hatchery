// Slack slash-command dispatch (/hatchery <subcommand>) — run: npx tsx src/slack/commands.test.ts
import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import type { D1Like } from '../skills/repository';
import type { Binding } from '../project/bindings';
import { parseSlashCommandPayload, runSlashCommand } from './commands';
import { listRecentAgentRuns } from '../agent-runs/repository';

const { test, run } = createTestRunner();

type Row = Record<string, unknown>;

// Pattern-matched fake for the read-only queries the slash commands issue.
class FakeD1 implements D1Like {
  connections: Row[] = [];
  reminders: Row[] = [];
  skills: Row[] = [];
  agentRuns: Row[] = [];

  prepare(query: string) {
    const db = this;
    return {
      bind(...values: unknown[]) {
        return {
          async run(): Promise<unknown> {
            throw new Error(`unexpected write in slash command: ${query}`);
          },
          async first<T = Row>(): Promise<T | null> {
            const { results } = await this.all<T>();
            return results[0] ?? null;
          },
          async all<T = Row>(): Promise<{ results: T[] }> {
            if (query.includes('FROM connections')) {
              const [projectId] = values;
              return { results: db.connections.filter((r) => r.project_id === projectId) as T[] };
            }
            if (query.includes('FROM reminders')) {
              const [projectId] = values;
              const rows = db.reminders
                .filter((r) => r.project_id === projectId)
                .sort((a, b) => (a.next_run as number) - (b.next_run as number));
              return { results: rows as T[] };
            }
            if (query.includes('FROM skills')) {
              const [globalId, projectId] = values;
              const rows = db.skills.filter(
                (r) => (r.project_id === globalId || r.project_id === projectId) && r.state === 'active',
              );
              return { results: rows as T[] };
            }
            if (query.includes('FROM agent_runs') && query.includes('ORDER BY created_at DESC')) {
              const [projectId, limit] = values as [string, number];
              const rows = db.agentRuns
                .filter((r) => r.project_id === projectId)
                .sort((a, b) => (b.created_at as number) - (a.created_at as number))
                .slice(0, limit);
              return { results: rows as T[] };
            }
            throw new Error(`unexpected query: ${query}`);
          },
        };
      },
    };
  }
}

const binding: Binding = {
  provider: 'slack',
  externalAccountId: 'T1',
  externalSpaceId: 'C1',
  transportBotId: 'U1',
  projectId: 'proj-1',
  sandboxMode: 'virtual',
  transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
  status: 'active',
};

function agentRunRow(over: Row = {}): Row {
  return {
    id: 'run-aaaaaaaa',
    project_id: 'proj-1',
    route_id: null,
    source_type: 'linear',
    source_id: null,
    idempotency_key: 'k',
    linear_issue_id: null,
    linear_identifier: null,
    linear_url: null,
    slack_team_id: null,
    slack_channel_id: null,
    slack_thread_ts: null,
    github_owner: null,
    github_repo: null,
    target_repo: 'org/repo',
    base_branch: 'main',
    kit: 'coding-default',
    runtime: 'cli',
    sandbox_provider: 'trigger',
    sandbox_id: null,
    trigger_run_id: null,
    status: 'running',
    branch: null,
    commit_sha: null,
    pr_url: null,
    ci_url: null,
    summary: null,
    error: null,
    status_note: null,
    last_event_id: null,
    last_heartbeat_at: null,
    dispatch_attempts: 0,
    last_dispatch_error: null,
    dispatched_at: null,
    dispatch_payload: null,
    created_at: 1000,
    updated_at: 1000,
    completed_at: null,
    ...over,
  };
}

// ── payload parsing ───────────────────────────────────────────────────────────

test('parseSlashCommandPayload decodes the form-encoded slash payload', () => {
  const raw =
    'token=x&team_id=T1&channel_id=C1&user_id=U2&command=%2Fhatchery&text=runs+all&response_url=https%3A%2F%2Fhooks.slack.com%2Fr';
  const p = parseSlashCommandPayload(raw);
  assert.equal(p.command, '/hatchery');
  assert.equal(p.text, 'runs all');
  assert.equal(p.teamId, 'T1');
  assert.equal(p.channelId, 'C1');
  assert.equal(p.userId, 'U2');
});

test('parseSlashCommandPayload tolerates missing fields', () => {
  const p = parseSlashCommandPayload('command=%2Fhatchery');
  assert.equal(p.text, '');
  assert.equal(p.teamId, '');
});

// ── help / unknown ────────────────────────────────────────────────────────────

test('help lists every subcommand', async () => {
  const out = await runSlashCommand('help', { binding, env: {} });
  for (const cmd of ['status', 'runs', 'reminders', 'skills', 'help']) {
    assert.ok(out.includes(`/hatchery ${cmd}`), `help should mention /hatchery ${cmd}`);
  }
});

test('empty text behaves like help', async () => {
  const out = await runSlashCommand('', { binding, env: {} });
  assert.ok(out.includes('/hatchery status'));
});

test('unknown subcommand points at help', async () => {
  const out = await runSlashCommand('frobnicate', { binding, env: {} });
  assert.ok(out.includes('frobnicate'));
  assert.ok(out.includes('/hatchery help'));
});

// ── status ────────────────────────────────────────────────────────────────────

test('status reports project, default model, and unconfigured wiring', async () => {
  const out = await runSlashCommand('status', { binding, env: {} });
  assert.ok(out.includes('proj-1'));
  assert.ok(out.includes('openrouter/xiaomi/mimo-v2.5-pro'));
  assert.ok(out.includes('default'));
  assert.ok(/Linear ingress.*not configured/.test(out));
  assert.ok(/Trigger\.dev runner.*not configured/.test(out));
});

test('status reports a pinned model and configured wiring', async () => {
  const pinned: Binding = { ...binding, model: 'openrouter/moonshotai/kimi-k2.6' };
  const env = { LINEAR_WEBHOOK_SECRET: 's', TRIGGER_SECRET_KEY: 's', NANGO_SECRET_KEY: 's' };
  const out = await runSlashCommand('status', { binding: pinned, env });
  assert.ok(out.includes('openrouter/moonshotai/kimi-k2.6'));
  assert.ok(out.includes('pinned'));
  assert.ok(!/Linear ingress.*not configured/.test(out));
});

test('status lists connection states from D1 + env', async () => {
  const db = new FakeD1();
  db.connections.push({
    project_id: 'proj-1',
    provider: 'github',
    token_ref: 'GH_TOKEN',
    connection_ref: null,
    config_json: null,
    status: 'active',
  });
  const out = await runSlashCommand('status', { binding, db, env: { GH_TOKEN: 'tok' } });
  assert.ok(/github.*connected/.test(out));
});

// ── runs ──────────────────────────────────────────────────────────────────────

test('runs with no history says so', async () => {
  const db = new FakeD1();
  const out = await runSlashCommand('runs', { binding, db, env: {} });
  assert.ok(/no agent runs/i.test(out));
});

test('runs lists recent runs newest-first with identifier, status, and PR link', async () => {
  const db = new FakeD1();
  db.agentRuns.push(
    agentRunRow({ id: 'run-old00000', linear_identifier: 'ENG-1', status: 'completed', created_at: 1000 }),
    agentRunRow({
      id: 'run-new00000',
      linear_identifier: 'ENG-2',
      status: 'running',
      pr_url: 'https://github.com/org/repo/pull/7',
      created_at: 2000,
    }),
  );
  const out = await runSlashCommand('runs', { binding, db, env: {} });
  assert.ok(out.indexOf('ENG-2') < out.indexOf('ENG-1'), 'newest run should be listed first');
  assert.ok(out.includes('running'));
  assert.ok(out.includes('https://github.com/org/repo/pull/7'));
});

test('runs without a db explains the limitation', async () => {
  const out = await runSlashCommand('runs', { binding, env: {} });
  assert.ok(/database/i.test(out));
});

// ── reminders ─────────────────────────────────────────────────────────────────

test('reminders lists rows with next-run time and paused marker', async () => {
  const db = new FakeD1();
  db.reminders.push(
    {
      project_id: 'proj-1',
      id: 'standup',
      kind: 'heartbeat',
      cron: '0 9 * * *',
      every_ms: null,
      next_run: Date.UTC(2026, 5, 10, 1, 0), // 09:00 KL
      payload: '{}',
      enabled: 1,
    },
    {
      project_id: 'proj-1',
      id: 'weekly',
      kind: 'report',
      cron: null,
      every_ms: 604800000,
      next_run: Date.UTC(2026, 5, 14, 1, 0),
      payload: '{}',
      enabled: 0,
    },
  );
  const out = await runSlashCommand('reminders', { binding, db, env: {} });
  assert.ok(out.includes('standup'));
  assert.ok(out.includes('2026-06-10 09:00'));
  assert.ok(/weekly.*paused/.test(out));
});

test('reminders with none says so', async () => {
  const db = new FakeD1();
  const out = await runSlashCommand('reminders', { binding, db, env: {} });
  assert.ok(/no reminders/i.test(out));
});

// ── skills ────────────────────────────────────────────────────────────────────

test('skills lists the active catalog', async () => {
  const db = new FakeD1();
  db.skills.push({
    project_id: 'proj-1',
    name: 'release-notes',
    description: 'Draft release notes from merged PRs',
    state: 'active',
  });
  const out = await runSlashCommand('skills', { binding, db, env: {} });
  assert.ok(out.includes('release-notes'));
  assert.ok(out.includes('Draft release notes from merged PRs'));
});

test('skills with none says so', async () => {
  const db = new FakeD1();
  const out = await runSlashCommand('skills', { binding, db, env: {} });
  assert.ok(/no skills/i.test(out));
});

// ── repository: listRecentAgentRuns ───────────────────────────────────────────

test('listRecentAgentRuns returns newest-first capped at limit', async () => {
  const db = new FakeD1();
  db.agentRuns.push(
    agentRunRow({ id: 'r1', created_at: 1000 }),
    agentRunRow({ id: 'r2', created_at: 3000 }),
    agentRunRow({ id: 'r3', created_at: 2000 }),
    agentRunRow({ id: 'other', project_id: 'proj-2', created_at: 9000 }),
  );
  const runs = await listRecentAgentRuns(db, 'proj-1', 2);
  assert.deepEqual(
    runs.map((r) => r.id),
    ['r2', 'r3'],
  );
});

run();
