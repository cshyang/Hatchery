// Linear agent-run ingress invariants — run: npx tsx src/agent-runs/linear.test.ts
import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import type { D1Like } from '../skills/repository';
import { handleLinearWebhook, parseLinearAgentProjects, verifyLinearWebhook } from './linear';

const { test, run } = createTestRunner();

type Row = Record<string, unknown>;

class FakeD1 implements D1Like {
  agentRuns: Row[] = [];

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
              if (query.includes('WHERE project_id=? AND idempotency_key=?')) {
                const [projectId, idempotencyKey] = values;
                return { results: db.agentRuns.filter((r) => r.project_id === projectId && r.idempotency_key === idempotencyKey) as T[] };
              }
            }
            return { results: [] as T[] };
          },
          async run(): Promise<{ meta: { changes: number } }> {
            if (query.startsWith('INSERT INTO agent_runs')) {
              const [
                id,
                projectId,
                sourceType,
                sourceId,
                idempotencyKey,
                linearIssueId,
                linearIdentifier,
                linearUrl,
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
                createdAt,
                updatedAt,
              ] = values;
              db.agentRuns.push({
                id,
                project_id: projectId,
                source_type: sourceType,
                source_id: sourceId,
                idempotency_key: idempotencyKey,
                linear_issue_id: linearIssueId,
                linear_identifier: linearIdentifier,
                linear_url: linearUrl,
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
                created_at: createdAt,
                updated_at: updatedAt,
              });
              return { meta: { changes: 1 } };
            }
            if (query.startsWith('UPDATE agent_runs')) {
              const [status, sandboxId, branch, commitSha, prUrl, ciUrl, summary, error, updatedAt, id] = values;
              const row = db.agentRuns.find((r) => r.id === id);
              if (!row) return { meta: { changes: 0 } };
              Object.assign(row, { status, sandbox_id: sandboxId, branch, commit_sha: commitSha, pr_url: prUrl, ci_url: ciUrl, summary, error, updated_at: updatedAt });
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

const projectsJson = JSON.stringify({
  LIN: {
    projectId: 'P',
    targetRepo: 'github.com/acme/repo',
    baseBranch: 'main',
    kit: 'coding-default',
    runtime: 'claude_code',
    sandboxProvider: 'e2b',
    runStateName: 'Run Agent',
  },
});

test('parseLinearAgentProjects accepts team key/id project config and defaults runtime fields', () => {
  const parsed = parseLinearAgentProjects(JSON.stringify({ LIN: { projectId: 'P', targetRepo: 'github.com/acme/repo' } }));
  assert.equal(parsed.get('LIN')?.projectId, 'P');
  assert.equal(parsed.get('LIN')?.baseBranch, 'main');
  assert.equal(parsed.get('LIN')?.runtime, 'claude_code');
  assert.equal(parsed.get('LIN')?.sandboxProvider, 'e2b');
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

test('handleLinearWebhook creates one agent_run and dispatches expected E2B Claude Code payload', async () => {
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
  assert.equal(result.body?.dispatchStatus, 'dispatched');
  assert.equal(db.agentRuns.length, 1);
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
  assert.equal(sent[0].body.runtime, 'claude_code');
  assert.equal(sent[0].body.sandboxProvider, 'e2b');
  assert.equal((sent[0].body.linearIssue as Record<string, unknown>).identifier, 'LIN-42');
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

  assert.equal(first.body?.dispatchStatus, 'dispatched');
  assert.equal(duplicateDelivery.body?.dispatchStatus, 'deduped');
  assert.equal(repeatedIssue.body?.dispatchStatus, 'deduped');
  assert.equal(db.agentRuns.length, 1);
  assert.equal(calls, 1);
});

test('handleLinearWebhook ignores non-Run-Agent state changes and records dispatch failure', async () => {
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
  assert.equal(failed.body?.dispatchStatus, 'failed');
  assert.equal(db.agentRuns[0].status, 'failed');
  assert.match(String(db.agentRuns[0].error), /503/);
});

await run();
