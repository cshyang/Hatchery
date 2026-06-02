// Agent-run control-plane invariants — run: npx tsx src/agent-runs/agent-runs.test.ts
import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import type { D1Like } from '../skills/repository';
import { createAgentRun, getAgentRun, handleAgentRunCallback } from './repository';

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
              Object.assign(row, {
                status,
                sandbox_id: sandboxId,
                branch,
                commit_sha: commitSha,
                pr_url: prUrl,
                ci_url: ciUrl,
                summary,
                error,
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
    id: () => `run-${++n}`,
    now: () => 2000 + n,
  };
}

const runInput = {
  projectId: 'P',
  sourceType: 'linear',
  sourceId: 'LIN-42',
  idempotencyKey: 'linear:issue:issue-1:run-agent',
  linearIssueId: 'issue-1',
  linearIdentifier: 'LIN-42',
  linearUrl: 'https://linear.app/acme/issue/LIN-42/fix-it',
  targetRepo: 'github.com/acme/repo',
  baseBranch: 'main',
  kit: 'coding-default',
  runtime: 'claude_code',
  sandboxProvider: 'e2b',
};

test('createAgentRun stores a project-scoped lease and dedupes by idempotency key', async () => {
  const db = new FakeD1();
  const deps = seq();

  const first = await createAgentRun(db, runInput, deps);
  const duplicate = await createAgentRun(db, { ...runInput, sourceId: 'LIN-42-again' }, deps);
  const otherProject = await createAgentRun(db, { ...runInput, projectId: 'OTHER' }, deps);

  assert.equal(first.duplicate, false);
  assert.equal(first.run.projectId, 'P');
  assert.equal(first.run.status, 'queued');
  assert.equal(first.run.runtime, 'claude_code');
  assert.equal(first.run.sandboxProvider, 'e2b');
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.run.id, first.run.id);
  assert.equal(otherProject.duplicate, false);
});

test('handleAgentRunCallback rejects missing or wrong runner token', async () => {
  const denied = await handleAgentRunCallback(
    { db: new FakeD1(), expectedToken: 'runner-secret', actualToken: 'wrong', body: { runId: 'run-1', status: 'running' } },
    seq(),
  );
  assert.equal(denied.status, 404);
});

test('handleAgentRunCallback maps running, pr_opened, completed, and failed into run state', async () => {
  const db = new FakeD1();
  const deps = seq();
  const created = await createAgentRun(db, runInput, deps);

  const running = await handleAgentRunCallback(
    {
      db,
      expectedToken: 'runner-secret',
      actualToken: 'runner-secret',
      body: { runId: created.run.id, status: 'running', sandboxId: 'sbx_1', summary: 'started' },
    },
    deps,
  );
  assert.equal(running.status, 200);
  assert.equal(running.body?.run.status, 'running');
  assert.equal(running.body?.run.sandboxId, 'sbx_1');

  const pr = await handleAgentRunCallback(
    {
      db,
      expectedToken: 'runner-secret',
      actualToken: 'runner-secret',
      body: { runId: created.run.id, status: 'pr_opened', branch: 'agent/LIN-42', commitSha: 'abc123', prUrl: 'https://github.com/acme/repo/pull/7' },
    },
    deps,
  );
  assert.equal(pr.body?.run.status, 'waiting_approval');
  assert.equal(pr.body?.run.prUrl, 'https://github.com/acme/repo/pull/7');

  const completed = await handleAgentRunCallback(
    {
      db,
      expectedToken: 'runner-secret',
      actualToken: 'runner-secret',
      body: { runId: created.run.id, status: 'completed', ciUrl: 'https://github.com/acme/repo/actions/runs/1', summary: 'ready' },
    },
    deps,
  );
  assert.equal(completed.body?.run.status, 'completed');
  assert.equal(completed.body?.run.ciUrl, 'https://github.com/acme/repo/actions/runs/1');

  const failedRun = await createAgentRun(db, { ...runInput, idempotencyKey: 'linear:issue:issue-2:run-agent', linearIssueId: 'issue-2' }, deps);
  const failed = await handleAgentRunCallback(
    {
      db,
      expectedToken: 'runner-secret',
      actualToken: 'runner-secret',
      body: { runId: failedRun.run.id, status: 'failed', error: 'tests failed' },
    },
    deps,
  );
  assert.equal(failed.body?.run.status, 'failed');
  assert.equal(failed.body?.run.error, 'tests failed');

  const readBack = await getAgentRun(db, 'P', created.run.id);
  assert.equal(readBack?.status, 'completed');
});

await run();
