// workspace_load_slack_file invariants — run: npx tsx src/workspace/slack-files.test.ts

import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import type { D1Like } from '../skills/repository';
import { recordSlackConversationFiles } from '../slack/file-authorizations';
import { listWorkspaceOps, type SandboxLike } from './workspace';
import {
  maxSlackFileBytes,
  workspaceLoadSlackFile,
  workspaceSendFile,
  workspaceSlackFileTools,
  WORKSPACE_INPUTS_DIR,
  type SlackTargetResolver,
} from './slack-files';

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
                  .filter((r) => r.table === 'coordinator_workspace_ops' && r.project_id === projectId)
                  .sort((a, b) => Number(b.created_at) - Number(a.created_at))
                  .slice(0, Number(limit ?? 20)) as T[],
              };
            }
            if (query.includes('FROM slack_conversation_files')) {
              const [projectId, conversationId, fileId] = values;
              const row = db.rows.find(
                (r) =>
                  r.table === 'slack_conversation_files' &&
                  r.project_id === projectId &&
                  r.conversation_id === conversationId &&
                  r.file_id === fileId,
              );
              return { results: (row ? [{ file_id: fileId }] : []) as T[] };
            }
            return { results: [] as T[] };
          },
          async run(): Promise<{ meta: { changes: number } }> {
            if (query.startsWith('INSERT INTO coordinator_workspace_ops')) {
              const [id, projectId, conversationId, op, detailPreview, bytesIn, createdAt] = values;
              db.rows.push({
                table: 'coordinator_workspace_ops',
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
            if (query.startsWith('INSERT INTO slack_conversation_files')) {
              const [projectId, conversationId, fileId, name, mimetype, size, createdAt, updatedAt] = values;
              const existing = db.rows.find(
                (r) =>
                  r.table === 'slack_conversation_files' &&
                  r.project_id === projectId &&
                  r.conversation_id === conversationId &&
                  r.file_id === fileId,
              );
              const patch = {
                table: 'slack_conversation_files',
                project_id: projectId,
                conversation_id: conversationId,
                file_id: fileId,
                name,
                mimetype,
                size,
                updated_at: updatedAt,
              };
              if (existing) Object.assign(existing, patch);
              else db.rows.push({ ...patch, created_at: createdAt });
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
  reads: Array<{ path: string; options?: { encoding?: string } }> = [];
  files = new Map<string, string>(); // base64-encoded contents

  async exec(command: string) {
    this.execCalls.push(command);
    return { success: true, exitCode: 0, stdout: '', stderr: '' };
  }

  async writeFile(path: string, content: string, options?: { encoding?: string }) {
    this.writes.push({ path, content, options });
    return { success: true };
  }

  async readFile(path: string, options?: { encoding?: string }): Promise<{ success: boolean; content: string }> {
    this.reads.push({ path, options });
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`no such file: ${path}`);
    return { success: true, content };
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

const CONVERSATION_ID = 'slack:T1:C1:111.222';

async function allowFile(db: FakeD1, fileId = 'F123', conversationId = CONVERSATION_ID): Promise<void> {
  await recordSlackConversationFiles(db, {
    projectId: 'proj-1',
    conversationId,
    files: [{ id: fileId, name: 'report.xlsx', mimetype: 'application/vnd.ms-excel', size: 3 }],
    now: () => 123,
  });
}

test('loadSlackFile: downloads via files.info, writes base64 into /workspace/inputs, audits', async () => {
  const db = new FakeD1();
  const sandbox = new FakeSandbox();
  await allowFile(db);
  const calls: FetchCall[] = [];
  const body = new Uint8Array([104, 105, 33]); // "hi!"
  const result = await workspaceLoadSlackFile(deps(db, sandbox, fakeFetcher({ info: INFO_OK, body, calls })), {
    fileId: 'F123',
    conversationId: CONVERSATION_ID,
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
  assert.equal(audit.conversationId, CONVERSATION_ID);
  assert.ok(!JSON.stringify(db.rows).includes('xoxb-test-token'));
});

test('loadSlackFile: rejects files not attached to the conversation before Slack API calls', async () => {
  const db = new FakeD1();
  const sandbox = new FakeSandbox();
  await allowFile(db, 'F_ALLOWED');
  const calls: FetchCall[] = [];

  const result = await workspaceLoadSlackFile(deps(db, sandbox, fakeFetcher({ info: INFO_OK, calls })), {
    fileId: 'F123',
    conversationId: CONVERSATION_ID,
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'Slack file is not attached to this conversation');
  assert.equal(calls.length, 0);
  assert.equal(sandbox.execCalls.length, 0);
  assert.equal(sandbox.writes.length, 0);
});

test('loadSlackFile: conversationId is required because file ids are conversation-scoped', async () => {
  const db = new FakeD1();
  const sandbox = new FakeSandbox();
  await allowFile(db);
  const calls: FetchCall[] = [];

  const result = await workspaceLoadSlackFile(deps(db, sandbox, fakeFetcher({ info: INFO_OK, calls })), {
    fileId: 'F123',
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'conversationId is required to load Slack files');
  assert.equal(calls.length, 0);
});

test('loadSlackFile: declared oversize fails before any download or sandbox boot', async () => {
  const db = new FakeD1();
  const sandbox = new FakeSandbox();
  await allowFile(db);
  const calls: FetchCall[] = [];
  const info = { ok: true, file: { ...INFO_OK.file, size: 999 } };
  const result = await workspaceLoadSlackFile(deps(db, sandbox, fakeFetcher({ info, calls }), { WORKSPACE_MAX_SLACK_FILE_BYTES: '100' }), {
    fileId: 'F123',
    conversationId: CONVERSATION_ID,
  });

  assert.equal(result.status, 'failed');
  assert.ok(String(result.error).includes('too large'));
  assert.equal(calls.length, 1); // files.info only — no download
  assert.equal(sandbox.writes.length, 0);
});

test('loadSlackFile: actual bytes over cap fail even when declared size lies', async () => {
  const db = new FakeD1();
  const sandbox = new FakeSandbox();
  await allowFile(db);
  const info = { ok: true, file: { ...INFO_OK.file, size: 3 } };
  const body = new Uint8Array(200);
  const result = await workspaceLoadSlackFile(deps(db, sandbox, fakeFetcher({ info, body }), { WORKSPACE_MAX_SLACK_FILE_BYTES: '100' }), {
    fileId: 'F123',
    conversationId: CONVERSATION_ID,
  });
  assert.equal(result.status, 'failed');
  assert.equal(sandbox.writes.length, 0);
});

test('loadSlackFile: Slack API error and HTTP failure produce failed audits', async () => {
  const db = new FakeD1();
  const sandbox = new FakeSandbox();
  await allowFile(db, 'F404');
  await allowFile(db);
  const denied = await workspaceLoadSlackFile(deps(db, sandbox, fakeFetcher({ info: { ok: false, error: 'file_not_found' } })), {
    fileId: 'F404',
    conversationId: CONVERSATION_ID,
  });
  assert.equal(denied.status, 'failed');
  assert.ok(String(denied.error).includes('file_not_found'));

  const http = await workspaceLoadSlackFile(deps(db, sandbox, fakeFetcher({ info: INFO_OK, downloadStatus: 403 })), {
    fileId: 'F123',
    conversationId: CONVERSATION_ID,
  });
  assert.equal(http.status, 'failed');
  assert.ok(String(http.error).includes('403'));

  const audits = await listWorkspaceOps(db, 'proj-1');
  assert.equal(audits.length, 2);
  assert.ok(audits.every((a) => a.status === 'failed'));
});

test('loadSlackFile: hostile filename is sanitized into the inputs dir', async () => {
  const db = new FakeD1();
  const sandbox = new FakeSandbox();
  await allowFile(db);
  const info = { ok: true, file: { ...INFO_OK.file, name: '../../etc/passwd; rm -rf $(x).csv' } };
  const result = await workspaceLoadSlackFile(deps(db, sandbox, fakeFetcher({ info })), {
    fileId: 'F123',
    conversationId: CONVERSATION_ID,
  });
  assert.equal(result.status, 'completed');
  assert.ok(result.path!.startsWith(`${WORKSPACE_INPUTS_DIR}/F123_`));
  assert.ok(!/[^A-Za-z0-9._/-]/.test(result.path!.slice(WORKSPACE_INPUTS_DIR.length)));
  assert.ok(!result.path!.includes('..'));
});

test('workspaceSlackFileTools: gated off without db, sandbox, or token; send needs resolveTarget', () => {
  const db = new FakeD1();
  const sandbox = new FakeSandbox();
  assert.equal(workspaceSlackFileTools({ projectId: 'p' }).length, 0);
  assert.equal(workspaceSlackFileTools({ db, sandbox: () => sandbox, projectId: 'p' }).length, 0);
  assert.equal(workspaceSlackFileTools({ db, projectId: 'p', token: 't' }).length, 0);
  const loadOnly = workspaceSlackFileTools({ db, sandbox: () => sandbox, projectId: 'p', token: 't' });
  assert.deepEqual(loadOnly.map((t) => t.name), ['workspace_load_slack_file']);
  const withSend = workspaceSlackFileTools({
    db,
    sandbox: () => sandbox,
    projectId: 'p',
    token: 't',
    resolveTarget: async () => ({ channelId: 'C1', threadTs: null, token: 't' }),
  });
  assert.deepEqual(withSend.map((t) => t.name).sort(), ['workspace_load_slack_file', 'workspace_send_file']);
});

interface SendCall {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function sendFetcher(args: {
  uploadUrl?: unknown;
  uploadStatus?: number;
  complete?: unknown;
  calls?: SendCall[];
}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    args.calls?.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body });
    if (url.startsWith('https://slack.com/api/files.getUploadURLExternal')) {
      return new Response(JSON.stringify(args.uploadUrl ?? { ok: true, upload_url: 'https://upload.slack.example/u1', file_id: 'F_NEW' }));
    }
    if (url.startsWith('https://upload.slack.example/')) {
      return new Response('OK', { status: args.uploadStatus ?? 200 });
    }
    if (url.startsWith('https://slack.com/api/files.completeUploadExternal')) {
      return new Response(JSON.stringify(args.complete ?? { ok: true }));
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

function sendDeps(db: FakeD1, sandbox: FakeSandbox, fetcher: typeof fetch, args: { target?: ReturnType<SlackTargetResolver> | null; env?: Record<string, unknown> } = {}) {
  const resolveTarget: SlackTargetResolver = async () =>
    args.target === null ? null : { channelId: 'C9', threadTs: '111.222', token: 'xoxb-send-token' };
  return { db, sandbox: () => sandbox, projectId: 'proj-1', env: args.env ?? {}, resolveTarget, fetcher };
}

test('sendFile: reads base64 from sandbox, runs the 3-step external upload into the thread', async () => {
  const db = new FakeD1();
  const sandbox = new FakeSandbox();
  sandbox.files.set('/workspace/out/result.csv', btoa('a,b\n1,2\n'));
  const calls: SendCall[] = [];
  const result = await workspaceSendFile(sendDeps(db, sandbox, sendFetcher({ calls })), {
    path: '/workspace/out/result.csv',
    conversationId: 'conv-1',
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.fileId, 'F_NEW');
  assert.equal(result.name, 'result.csv');
  assert.equal(result.bytes, 8);

  assert.deepEqual(sandbox.reads[0], { path: '/workspace/out/result.csv', options: { encoding: 'base64' } });

  const [getUrl, upload, complete] = calls;
  assert.ok(String(getUrl.body).includes('filename=result.csv'));
  assert.ok(String(getUrl.body).includes('length=8'));
  assert.equal(getUrl.headers.authorization, 'Bearer xoxb-send-token');
  assert.equal(new TextDecoder().decode(upload.body as Uint8Array), 'a,b\n1,2\n');
  const completeBody = JSON.parse(String(complete.body));
  assert.equal(completeBody.channel_id, 'C9');
  assert.equal(completeBody.thread_ts, '111.222');
  assert.deepEqual(completeBody.files, [{ id: 'F_NEW', title: 'result.csv' }]);

  const [audit] = await listWorkspaceOps(db, 'proj-1');
  assert.equal(audit.op, 'send_file');
  assert.equal(audit.status, 'completed');
  assert.equal(audit.bytesOut, 8);
  assert.ok(!JSON.stringify(db.rows).includes('xoxb-send-token'));
});

test('sendFile: fails without a resolvable target, before touching the sandbox', async () => {
  const db = new FakeD1();
  const sandbox = new FakeSandbox();
  const result = await workspaceSendFile(sendDeps(db, sandbox, sendFetcher({}), { target: null }), {
    path: '/workspace/out/x.csv',
    conversationId: 'conv-x',
  });
  assert.equal(result.status, 'failed');
  assert.ok(String(result.error).includes('No Slack target'));
  assert.equal(sandbox.reads.length, 0);
});

test('sendFile: oversize, missing file, upload-step failure, and complete-step failure all audit as failed', async () => {
  const db = new FakeD1();
  const sandbox = new FakeSandbox();
  sandbox.files.set('/workspace/big.bin', btoa('x'.repeat(200)));
  const big = await workspaceSendFile(sendDeps(db, sandbox, sendFetcher({}), { env: { WORKSPACE_MAX_SLACK_FILE_BYTES: '100' } }), {
    path: '/workspace/big.bin',
  });
  assert.equal(big.status, 'failed');
  assert.ok(String(big.error).includes('too large'));

  const missing = await workspaceSendFile(sendDeps(db, sandbox, sendFetcher({})), { path: '/workspace/nope.csv' });
  assert.equal(missing.status, 'failed');

  sandbox.files.set('/workspace/ok.csv', btoa('data'));
  const httpFail = await workspaceSendFile(sendDeps(db, sandbox, sendFetcher({ uploadStatus: 500 })), { path: '/workspace/ok.csv' });
  assert.equal(httpFail.status, 'failed');
  assert.ok(String(httpFail.error).includes('500'));

  const completeFail = await workspaceSendFile(sendDeps(db, sandbox, sendFetcher({ complete: { ok: false, error: 'not_in_channel' } })), {
    path: '/workspace/ok.csv',
  });
  assert.equal(completeFail.status, 'failed');
  assert.ok(String(completeFail.error).includes('not_in_channel'));

  const audits = await listWorkspaceOps(db, 'proj-1');
  assert.equal(audits.length, 4);
  assert.ok(audits.every((a) => a.op === 'send_file' && a.status === 'failed'));
});

test('maxSlackFileBytes: default 20MB, env override, junk falls back', () => {
  assert.equal(maxSlackFileBytes(), 20_000_000);
  assert.equal(maxSlackFileBytes({ WORKSPACE_MAX_SLACK_FILE_BYTES: '5000' }), 5000);
  assert.equal(maxSlackFileBytes({ WORKSPACE_MAX_SLACK_FILE_BYTES: 'junk' }), 20_000_000);
});

await run();
