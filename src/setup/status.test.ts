// Slack-first setup status invariants — run: npx tsx src/setup/status.test.ts

import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import type { Binding } from '../project/bindings';
import type { D1Like } from '../skills/repository';
import { buildSetupStatus, setupStatusTool } from './status';

const { test, run } = createTestRunner();

type Row = Record<string, unknown>;

class FakeD1 implements D1Like {
  connections: Row[] = [];
  routes: Row[] = [];

  prepare(sql: string) {
    const db = this;
    const query = sql.trim();
    return {
      bind(...values: unknown[]) {
        return {
          async first<T = Row>(): Promise<T | null> {
            const { results } = await this.all<T>();
            return results[0] ?? null;
          },
          async all<T = Row>(): Promise<{ results: T[] }> {
            if (query.startsWith('SELECT provider, token_ref')) {
              const [projectId] = values;
              return { results: db.connections.filter((r) => r.project_id === projectId) as T[] };
            }
            if (query.includes('FROM agent_run_routes') && query.includes('WHERE project_id=?')) {
              const [projectId] = values;
              return {
                results: db.routes
                  .filter((r) => r.project_id === projectId)
                  .sort((a, b) => Number(b.priority ?? 0) - Number(a.priority ?? 0)) as T[],
              };
            }
            return { results: [] as T[] };
          },
          async run(): Promise<unknown> {
            return {};
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
    transportBotId: 'U1',
    projectId: 'project_1',
    sandboxMode: 'virtual',
    transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
    status: 'active',
  };
}

function connection(provider: string, config: Record<string, unknown> = {}): Row {
  return {
    project_id: 'project_1',
    provider,
    token_ref: null,
    connection_ref: `conn_${provider}`,
    config_json: JSON.stringify(config),
    status: 'active',
  };
}

function route(status = 'active'): Row {
  return {
    id: 'route_1',
    project_id: 'project_1',
    provider: 'linear',
    external_key: 'EDK',
    trigger_type: 'state',
    trigger_value: 'Run Agent',
    github_owner: 'Calibrax-ai',
    github_repo: 'autoship',
    base_branch: 'main',
    kit: 'default',
    runtime: 'opencode',
    sandbox_provider: 'e2b',
    priority: 10,
    status,
  };
}

test('setup_status reports missing GitHub and Linear for a project with no active connections', async () => {
  const db = new FakeD1();
  const status = await buildSetupStatus({
    db,
    binding: binding(),
    projectId: 'project_1',
    env: {},
    intent: 'run_agent',
  });

  assert.equal(status.ready, false);
  assert.ok(status.missing.some((m) => m.provider === 'github'));
  assert.ok(status.missing.some((m) => m.provider === 'linear'));
  assert.equal(status.nextAction?.type, 'request_connection');
  assert.equal(status.nextAction?.provider, 'github');
  assert.doesNotMatch(JSON.stringify(status), /SECRET|TOKEN|NANGO/i);
});

test('setup_status reports GitHub PAT repo metadata when connected through github-pat', async () => {
  const db = new FakeD1();
  db.connections.push(connection('github', { authMode: 'pat', repo: 'Calibrax-ai/autoship', nangoIntegrationKey: 'github-pat' }));

  const status = await buildSetupStatus({
    db,
    binding: binding(),
    projectId: 'project_1',
    env: { NANGO_SECRET_KEY: 'secret' },
    targetRepo: 'Calibrax-ai/autoship',
  });

  assert.deepEqual(status.connected.find((c) => c.provider === 'github'), {
    provider: 'github',
    authMode: 'pat',
    repo: 'Calibrax-ai/autoship',
  });
});

test('setup_status reports missing Linear route when GitHub and Linear are connected', async () => {
  const db = new FakeD1();
  db.connections.push(connection('github', { authMode: 'oauth' }), connection('linear', { authMode: 'oauth' }));

  const status = await buildSetupStatus({
    db,
    binding: binding(),
    projectId: 'project_1',
    env: { NANGO_SECRET_KEY: 'secret', AGENT_RUNNER_URL: 'https://runner.example', AGENT_RUNNER_TOKEN: 'runner_secret' },
    targetRepo: 'Calibrax-ai/autoship',
    linearTeamKey: 'EDK',
  });

  assert.equal(status.ready, false);
  assert.ok(status.missing.some((m) => m.kind === 'route' && m.provider === 'linear'));
  assert.equal(status.nextAction?.type, 'activate_route');
  assert.doesNotMatch(JSON.stringify(status), /runner_secret|AGENT_RUNNER_TOKEN|NANGO_SECRET_KEY/);
});

test('setup_status reports ready when GitHub, Linear, active route, and runner config are present', async () => {
  const db = new FakeD1();
  db.connections.push(connection('github', { authMode: 'pat', repo: 'Calibrax-ai/autoship' }), connection('linear', { authMode: 'oauth' }));
  db.routes.push(route('active'));

  const status = await buildSetupStatus({
    db,
    binding: binding(),
    projectId: 'project_1',
    env: { NANGO_SECRET_KEY: 'secret', AGENT_RUNNER_URL: 'https://runner.example', AGENT_RUNNER_TOKEN: 'runner_secret' },
    targetRepo: 'Calibrax-ai/autoship',
    linearTeamKey: 'EDK',
    intent: 'run_agent',
  });

  assert.equal(status.ready, true);
  assert.deepEqual(status.missing, []);
  assert.equal(status.routes[0].status, 'active');
  assert.equal(status.routes[0].targetRepo, 'Calibrax-ai/autoship');
  assert.deepEqual(status.runner, { configured: true, runtime: 'opencode', sandboxProvider: 'e2b' });
  assert.equal(status.nextAction?.type, 'none');
});

test('setup_status tool returns structured JSON without exposing configured values', async () => {
  const db = new FakeD1();
  db.connections.push(connection('github', { authMode: 'pat', repo: 'Calibrax-ai/autoship' }), connection('linear', { authMode: 'oauth' }));
  db.routes.push(route('active'));
  const tool = setupStatusTool({
    db,
    binding: binding(),
    projectId: 'project_1',
    env: { NANGO_SECRET_KEY: 'secret', AGENT_RUNNER_URL: 'https://runner.example', AGENT_RUNNER_TOKEN: 'runner_secret' },
  });

  const out = await (tool.execute as (a: unknown) => Promise<string>)({
    targetRepo: 'Calibrax-ai/autoship',
    linearTeamKey: 'EDK',
    intent: 'run_agent',
  });
  const parsed = JSON.parse(out) as { ready: boolean; connected: unknown[]; nextAction: { type: string } };

  assert.equal(parsed.ready, true);
  assert.equal(parsed.nextAction.type, 'none');
  assert.equal(parsed.connected.length, 2);
  assert.doesNotMatch(out, /runner_secret|https:\/\/runner\.example|NANGO_SECRET_KEY|AGENT_RUNNER_TOKEN/);
});

await run();
