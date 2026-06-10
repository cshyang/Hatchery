// workspace_load_slack_file invariants — run: npx tsx src/workspace/slack-files.test.ts

import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import type { D1Like } from '../skills/repository';
import { listWorkspaceOps, type SandboxLike } from './workspace';
import { maxSlackFileBytes, workspaceLoadSlackFile, workspaceSlackFileTools, WORKSPACE_INPUTS_DIR } from './slack-files';

const { test, run } = createTestRunner();

type Row = Record<string, unknown>;

class FakeD1 implements D1Like {
  rows: Row[] = [];

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
            if (query.includes('FROM coordinator_workspace_ops')) {
              const [projectId, limit] = values;
              return {
                results: db.rows
                  .filter((r) => r.project_id === projectId)
                  .sort((a, b) => Number(b.created_at) - Number(a.created_at))
                  .slice(0, Number(limit ?? 20)) as T[],
              };
            }
            return { results: [] as T[] };
          },
          async run(): Promise<{ meta: { changes: number } }> {
            if (query.startsWith('INSERT INTO coordinator_workspace_ops')) {
              const [id, projectId, conversationId, op, detailPreview, bytesIn, createdAt] = values;
              db.rows.push({
                id,
                project_id: projectId,
                conversation_id: conversationId,
                op,
                detail_preview: detailPreview,
                status: 'running',
                error: null,
                result_preview: null,
                exit_code: null,
                bytes_in: bytesIn,
                bytes_out: null,
                created_at: createdAt,
                completed_at: null,
              });
              return { meta: { changes: 1 } };
            }
            if (query.startsWith('UPDATE coordinator_workspace_ops')) {
              const [status, error, resultPreview, exitCode, bytesOut, completedAt, id] = values;
              const row = db.rows.find((r) => r.id === id);
              if (row) Object.assign(row, { status, error, result_preview: resultPreview, exit_code: exitCode, bytes_out: bytesOut, completed_at: completedAt });
              return { meta: { changes: row ? 1 : 0 } };
            }
            return { meta: { changes: 0 } };
          },
        };
      },
    };
  }
}

class FakeSandbox implements SandboxLike {
  execCalls: string[] = [];
  writes: Array<{ path: string; content: string; options?: { encoding?: string } }> = [];

  async exec(command: string) {
    this.execCalls.push(command);
    return { success: true, exitCode: 0, stdout: '', stderr: '' };
  }

  async writeFile(path: string, content: string, options?: { encoding?: string }) {
    this.writes.push({ path, content, options });
    return { success: true };
  }

  async readFile(): Promise<{ success: boolean; content: string }> {
    throw new Error('unused');
  }
}

interface FetchCall {
  url: string;
  headers: Record<string, string>;
}

function fakeFetcher(args: {
  info?: unknown;
  body?: Uint8Array;
  downloadStatus?: number;
  calls?: FetchCall[];
}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    args.calls?.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.startsWith('https://slack.com/api/files.info')) {
      return new Response(JSON.stringify(args.info ?? { ok: false, error: 'not stubbed' }));
    }
    const bytes = args.body ?? new Uint8Array([1, 2, 3]);
    return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
      status: args.downloadStatus ?? 200,
    });
  }) as typeof fetch;
}

function deps(db: FakeD1, sandbox: FakeSandbox, fetcher: typeof fetch, env: Record<string, unknown> = {}) {
  return { db, sandbox: () => sandbox, projectId: 'proj-1', env, token: 'xoxb-test-token', fetcher };
}

const INFO_OK = {
  ok: true,
  file: { id: 'F123', name: 'report.xlsx', mimetype: 'application/vnd.ms-excel', size: 3, url_private_download: 'https://files.slack.com/dl/F123' },
};

test('loadSlackFile: downloads via files.info, writes base64 into /workspace/inputs, audits', async () => {
  const db = new FakeD1();
  const sandbox = new FakeSandbox();
  const calls: FetchCall[] = [];
  const body = new Uint8Array([104, 105, 33]); // "hi!"
  const result = await workspaceLoadSlackFile(deps(db, sandbox, fakeFetcher({ info: INFO_OK, body, calls })), {
    fileId: 'F123',
    conversationId: 'conv-9',
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.path, `${WORKSPACE_INPUTS_DIR}/F123_report.xlsx`);
  assert.equal(result.bytes, 3);
  assert.equal(result.mimetype, 'application/vnd.ms-excel');

  assert.ok(sandbox.execCalls[0].includes(`mkdir -p ${WORKSPACE_INPUTS_DIR}`));
  const [write] = sandbox.writes;
  assert.equal(write.options?.encoding, 'base64');
  assert.equal(write.content, btoa('hi!'));

  // Token used for both API calls, never anywhere visible.
  assert.ok(calls.every((c) => c.headers.authorization === 'Bearer xoxb-test-token'));
  const [audit] = await listWorkspaceOps(db, 'proj-1');
  assert.equal(audit.op, 'load_slack_file');
  assert.equal(audit.status, 'completed');
  assert.equal(audit.bytesOut, 3);
  assert.equal(audit.conversationId, 'conv-9');
  assert.ok(!JSON.stringify(db.rows).includes('xoxb-test-token'));
});

test('loadSlackFile: declared oversize fails before any download or sandbox boot', async () => {
  const db = new FakeD1();
  const sandbox = new FakeSandbox();
  const calls: FetchCall[] = [];
  const info = { ok: true, file: { ...INFO_OK.file, size: 999 } };
  const result = await workspaceLoadSlackFile(deps(db, sandbox, fakeFetcher({ info, calls }), { WORKSPACE_MAX_SLACK_FILE_BYTES: '100' }), {
    fileId: 'F123',
  });

  assert.equal(result.status, 'failed');
  assert.ok(String(result.error).includes('too large'));
  assert.equal(calls.length, 1); // files.info only — no download
  assert.equal(sandbox.writes.length, 0);
});

test('loadSlackFile: actual bytes over cap fail even when declared size lies', async () => {
  const db = new FakeD1();
  const sandbox = new FakeSandbox();
  const info = { ok: true, file: { ...INFO_OK.file, size: 3 } };
  const body = new Uint8Array(200);
  const result = await workspaceLoadSlackFile(deps(db, sandbox, fakeFetcher({ info, body }), { WORKSPACE_MAX_SLACK_FILE_BYTES: '100' }), {
    fileId: 'F123',
  });
  assert.equal(result.status, 'failed');
  assert.equal(sandbox.writes.length, 0);
});

test('loadSlackFile: Slack API error and HTTP failure produce failed audits', async () => {
  const db = new FakeD1();
  const sandbox = new FakeSandbox();
  const denied = await workspaceLoadSlackFile(deps(db, sandbox, fakeFetcher({ info: { ok: false, error: 'file_not_found' } })), { fileId: 'F404' });
  assert.equal(denied.status, 'failed');
  assert.ok(String(denied.error).includes('file_not_found'));

  const http = await workspaceLoadSlackFile(deps(db, sandbox, fakeFetcher({ info: INFO_OK, downloadStatus: 403 })), { fileId: 'F123' });
  assert.equal(http.status, 'failed');
  assert.ok(String(http.error).includes('403'));

  const audits = await listWorkspaceOps(db, 'proj-1');
  assert.equal(audits.length, 2);
  assert.ok(audits.every((a) => a.status === 'failed'));
});

test('loadSlackFile: hostile filename is sanitized into the inputs dir', async () => {
  const db = new FakeD1();
  const sandbox = new FakeSandbox();
  const info = { ok: true, file: { ...INFO_OK.file, name: '../../etc/passwd; rm -rf $(x).csv' } };
  const result = await workspaceLoadSlackFile(deps(db, sandbox, fakeFetcher({ info })), { fileId: 'F123' });
  assert.equal(result.status, 'completed');
  assert.ok(result.path!.startsWith(`${WORKSPACE_INPUTS_DIR}/F123_`));
  assert.ok(!/[^A-Za-z0-9._/-]/.test(result.path!.slice(WORKSPACE_INPUTS_DIR.length)));
  assert.ok(!result.path!.includes('..'));
});

test('workspaceSlackFileTools: gated off without db, sandbox, or token', () => {
  const db = new FakeD1();
  const sandbox = new FakeSandbox();
  assert.equal(workspaceSlackFileTools({ projectId: 'p' }).length, 0);
  assert.equal(workspaceSlackFileTools({ db, sandbox: () => sandbox, projectId: 'p' }).length, 0);
  assert.equal(workspaceSlackFileTools({ db, projectId: 'p', token: 't' }).length, 0);
  const tools = workspaceSlackFileTools({ db, sandbox: () => sandbox, projectId: 'p', token: 't' });
  assert.deepEqual(tools.map((t) => t.name), ['workspace_load_slack_file']);
});

test('maxSlackFileBytes: default 20MB, env override, junk falls back', () => {
  assert.equal(maxSlackFileBytes(), 20_000_000);
  assert.equal(maxSlackFileBytes({ WORKSPACE_MAX_SLACK_FILE_BYTES: '5000' }), 5000);
  assert.equal(maxSlackFileBytes({ WORKSPACE_MAX_SLACK_FILE_BYTES: 'junk' }), 20_000_000);
});

await run();
