// workspace_load_slack_file: pull a user-attached Slack file into the project sandbox.
//
// The bot token stays in the Worker — the tool resolves the download URL via files.info and
// streams bytes into the container as base64, so the container never sees a credential and the
// model never sees url_private. The container only boots when the model actually loads a file.

import { defineTool, Type, type ToolDefinition } from '@flue/runtime';
import type { D1Like } from '../skills/repository';
import { safeJson } from '../shared/bounded';
import { beginWorkspaceOp, type SandboxFactory, type WorkspaceDeps } from './workspace';

export const WORKSPACE_INPUTS_DIR = '/workspace/inputs';

const DEFAULT_MAX_SLACK_FILE_BYTES = 20_000_000;

export interface SlackFileDeps extends WorkspaceDeps {
  token: string;
  fetcher?: typeof fetch;
}

export interface LoadSlackFileResult {
  opId: string;
  status: 'completed' | 'failed';
  path: string | null;
  name: string | null;
  mimetype: string | null;
  bytes: number;
  error: string | null;
  durationMs: number;
}

interface SlackFilesInfoResponse {
  ok: boolean;
  error?: string;
  file?: {
    id?: string;
    name?: string;
    mimetype?: string;
    size?: number;
    url_private_download?: string;
    url_private?: string;
  };
}

export function maxSlackFileBytes(env: Record<string, unknown> = {}): number {
  const value = env.WORKSPACE_MAX_SLACK_FILE_BYTES;
  if (typeof value !== 'string' && typeof value !== 'number') return DEFAULT_MAX_SLACK_FILE_BYTES;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_SLACK_FILE_BYTES;
}

export async function workspaceLoadSlackFile(
  deps: SlackFileDeps,
  params: { fileId: string; conversationId?: string },
): Promise<LoadSlackFileResult> {
  const fetcher = deps.fetcher ?? fetch;
  const cap = maxSlackFileBytes(deps.env);
  const fileId = params.fileId?.trim() ?? '';
  const op = await beginWorkspaceOp(deps, {
    op: 'load_slack_file',
    detail: fileId || '(missing file id)',
    conversationId: params.conversationId,
    bytesIn: 0,
  });

  const fail = async (message: string): Promise<LoadSlackFileResult> => {
    const failed = await op.failFile(fileId, message);
    return { opId: failed.opId, status: 'failed', path: null, name: null, mimetype: null, bytes: 0, error: failed.error, durationMs: failed.durationMs };
  };

  if (!fileId) return fail('fileId is required');

  try {
    const infoRes = await fetcher(`https://slack.com/api/files.info?file=${encodeURIComponent(fileId)}`, {
      headers: { authorization: `Bearer ${deps.token}` },
    });
    const info = (await infoRes.json()) as SlackFilesInfoResponse;
    if (!info.ok || !info.file) return fail(`Slack files.info failed: ${info.error ?? 'unknown error'}`);

    const declaredSize = typeof info.file.size === 'number' ? info.file.size : null;
    if (declaredSize !== null && declaredSize > cap) {
      return fail(`file is too large (${declaredSize} bytes > ${cap} bytes)`);
    }

    const url = info.file.url_private_download ?? info.file.url_private;
    if (!url) return fail('Slack file has no downloadable URL');

    const download = await fetcher(url, { headers: { authorization: `Bearer ${deps.token}` } });
    if (!download.ok) return fail(`Slack file download failed: HTTP ${download.status}`);
    const buffer = await download.arrayBuffer();
    // Slack's declared size can lie (or be absent); the actual bytes are the contract.
    if (buffer.byteLength > cap) return fail(`file is too large (${buffer.byteLength} bytes > ${cap} bytes)`);

    const name = sanitizeFileName(info.file.name, fileId);
    const path = `${WORKSPACE_INPUTS_DIR}/${fileId}_${name}`;
    const sandbox = deps.sandbox();
    await sandbox.exec(`mkdir -p ${WORKSPACE_INPUTS_DIR}`);
    const written = await sandbox.writeFile(path, toBase64(buffer), { encoding: 'base64' });
    if (!written.success) return fail('sandbox write failed');

    const completedAt = await op.complete({
      resultPreview: `loaded ${buffer.byteLength} bytes to ${path}`,
      exitCode: null,
      bytesOut: buffer.byteLength,
    });
    return {
      opId: op.id,
      status: 'completed',
      path,
      name: info.file.name ?? name,
      mimetype: info.file.mimetype ?? null,
      bytes: buffer.byteLength,
      error: null,
      durationMs: completedAt - op.startedAt,
    };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export function workspaceSlackFileTools(args: {
  db?: D1Like;
  sandbox?: SandboxFactory;
  projectId: string;
  env?: Record<string, unknown>;
  token?: string;
  fetcher?: typeof fetch;
}): ToolDefinition[] {
  if (!args.db || !args.sandbox || !args.token) return [];
  const deps: SlackFileDeps = {
    db: args.db,
    sandbox: args.sandbox,
    projectId: args.projectId,
    env: args.env,
    token: args.token,
    fetcher: args.fetcher,
  };
  return [
    defineTool({
      name: 'workspace_load_slack_file',
      description:
        `Download a file the user attached in Slack into this project's sandbox container under ${WORKSPACE_INPUTS_DIR}/, returning its container path. Use the file ids listed in attachedFiles on the current Dispatch Input. Size cap ~20MB. After loading, process the file with workspace_exec (python3 with pandas is available).`,
      parameters: Type.Object({
        fileId: Type.String({ description: 'Slack file id from attachedFiles, e.g. F0123456789.' }),
        conversationId: Type.Optional(Type.String({ description: 'Copy from the current Dispatch Input when available.' })),
      }),
      async execute(params) {
        return safeJson(await workspaceLoadSlackFile(deps, params as { fileId: string; conversationId?: string }));
      },
    }),
  ];
}

function sanitizeFileName(name: string | undefined, fallback: string): string {
  const base = (name ?? '').split('/').pop()?.split('\\').pop() ?? '';
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 100);
  return safe || fallback;
}

function toBase64(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < view.length; i += chunk) {
    binary += String.fromCharCode(...view.subarray(i, i + chunk));
  }
  return btoa(binary);
}
