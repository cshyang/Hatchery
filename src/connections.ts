// The connection broker (ADR 0003). Owns per-project credential resolution, the tool-gating
// decision, and the propose-half of human-approved writes. Vendors (REST today, MCP/Composio
// later) are swappable behind resolveConnection — the agent, gating, and approval flow don't change.
//
// Closes over (db, projectId) like skills.ts/memory.ts — projectId is the isolation boundary.
// Secret VALUES are ciphertext in D1; only this module decrypts, in memory, at use.

import { defineTool, Type, type ToolDefinition } from '@flue/runtime';
import type { D1Like } from './skills';
import { encryptSecret, decryptSecret, fingerprint, argsHash } from './crypto';
import { githubReadTools } from './github';

export interface ConnectionState {
  provider: string;
  status: 'pending' | 'connected' | 'revoked';
  fingerprint: string | null;
  config: Record<string, unknown>;
}

/** All connections for a project (metadata only — never the secret). Drives gating + the prompt block. */
export async function connectionState(db: D1Like, projectId: string): Promise<ConnectionState[]> {
  const { results } = await db
    .prepare('SELECT provider, status, fingerprint, config_json FROM connections WHERE project_id=? ORDER BY provider')
    .bind(projectId)
    .all<{ provider: string; status: string; fingerprint: string | null; config_json: string | null }>();
  return (results ?? []).map((r) => ({
    provider: r.provider,
    status: r.status as ConnectionState['status'],
    fingerprint: r.fingerprint,
    config: r.config_json ? (JSON.parse(r.config_json) as Record<string, unknown>) : {},
  }));
}

/** Resolve a project's plaintext secret for a provider, or null if not connected. The ONLY
 *  decrypt path. `keyHex` = MASTER_ENCRYPTION_KEY. Returns config too (e.g. the pinned repo). */
export async function resolveConnection(
  db: D1Like,
  projectId: string,
  provider: string,
  keyHex: string,
): Promise<{ secret: string; config: Record<string, unknown> } | null> {
  const row = await db
    .prepare("SELECT secret_ciphertext, config_json FROM connections WHERE project_id=? AND provider=? AND status='connected'")
    .bind(projectId, provider)
    .first<{ secret_ciphertext: string | null; config_json: string | null }>();
  if (!row?.secret_ciphertext) return null;
  const secret = await decryptSecret(row.secret_ciphertext, keyHex);
  return { secret, config: row.config_json ? (JSON.parse(row.config_json) as Record<string, unknown>) : {} };
}

/** Provision/replace a project's credential (operator, out-of-band — ADR D11). Encrypts before
 *  the write; plaintext exists only in this call. Stores a display fingerprint, never the value. */
export async function upsertConnection(
  db: D1Like,
  projectId: string,
  provider: string,
  secret: string,
  keyHex: string,
  config: Record<string, unknown> = {},
  createdBy = 'operator',
): Promise<{ provider: string; fingerprint: string; status: string }> {
  const ciphertext = await encryptSecret(secret, keyHex);
  const fp = await fingerprint(secret);
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO connections(project_id, provider, secret_ciphertext, fingerprint, config_json, status, created_by, created_at, updated_at)
       VALUES(?,?,?,?,?,'connected',?,?,?)
       ON CONFLICT(project_id, provider) DO UPDATE SET
         secret_ciphertext=excluded.secret_ciphertext, fingerprint=excluded.fingerprint,
         config_json=excluded.config_json, status='connected', updated_at=excluded.updated_at`,
    )
    .bind(projectId, provider, ciphertext, fp, JSON.stringify(config), createdBy, now, now)
    .run();
  console.log(`[connections] upsert project=${projectId} provider=${provider} fp=${fp}`);
  return { provider, fingerprint: fp, status: 'connected' };
}

// Random id for a pending action — the only token that rides in the Slack button value (ADR D10).
function randomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Record a proposed write awaiting approval (ADR D10). Stores canonical args + their hash; the
 *  executor reads args back from here and re-checks the hash, never trusting the click payload. */
export async function createPending(
  db: D1Like,
  input: { projectId: string; provider: string; action: string; args: Record<string, unknown>; conversationId: string },
): Promise<{ id: string; hash: string }> {
  const id = randomId();
  const argsJson = JSON.stringify(input.args);
  const hash = await argsHash(input.args);
  await db
    .prepare(
      `INSERT INTO pending_actions(id, project_id, provider, action, args_json, args_hash, conversation_id, status, requested_at)
       VALUES(?,?,?,?,?,?,?, 'pending', ?)`,
    )
    .bind(id, input.projectId, input.provider, input.action, argsJson, hash, input.conversationId, Date.now())
    .run();
  console.log(`[connections] pending project=${input.projectId} action=${input.action} id=${id}`);
  return { id, hash };
}

// The CONNECTIONS prompt block (mirrors the skills catalog injection). Tells the agent what it
// can reach and what is connectable but not yet connected.
export function connectionsBlock(state: ConnectionState[], catalog: { provider: string; summary: string }[]): string {
  const byProvider = new Map(state.map((s) => [s.provider, s]));
  const lines = catalog.map((c) => {
    const s = byProvider.get(c.provider);
    if (s?.status === 'connected') return `  ✅ ${c.provider} (connected) — ${c.summary}`;
    return `  ⚪ ${c.provider} (not connected) — ${c.summary}`;
  });
  const anyConnected = state.some((s) => s.status === 'connected');
  return (
    'YOUR CONNECTIONS\n' +
    'External services you can reach. Connected ones expose tools you can call now; the rest must be ' +
    'connected by an operator first (mention that you need it — you cannot connect it yourself).\n' +
    lines.join('\n') +
    (anyConnected
      ? '\nReads run directly. Any WRITE (e.g. creating a GitHub issue) is proposed and waits for a ' +
        'human to approve in the channel before it happens — call the write tool and tell the user it needs approval.'
      : '')
  );
}

// The provider catalog (what Hatchery supports at all). v2a: GitHub only. Curated platform-side;
// the agent picks from it, never adds to it.
export const PROVIDER_CATALOG: { provider: string; summary: string }[] = [
  { provider: 'github', summary: 'read issues/code, search; propose creating an issue (needs approval)' },
];

/** Tools contributed by connections, gated on state (ADR D6): the initializer pushes these only
 *  for connected providers. v2a = READS only. The github_create_issue PROPOSE tool is v2b — it
 *  ships together with the gateway executor + Block Kit approval + hard-gate tests, so we don't
 *  leave a propose tool whose other half doesn't exist. `secrets` maps provider → resolved
 *  {secret, config} (decrypted once by the caller). */
export function connectionTools(
  _db: D1Like,
  _projectId: string,
  state: ConnectionState[],
  secrets: Record<string, { secret: string; config: Record<string, unknown> }>,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  const github = state.find((s) => s.provider === 'github' && s.status === 'connected');
  const ghCreds = secrets['github'];
  if (github && ghCreds) {
    const repo = typeof ghCreds.config.repo === 'string' ? ghCreds.config.repo : undefined;
    tools.push(...githubReadTools(ghCreds.secret, repo));
    // v2b plugs the github_create_issue propose-tool in here (uses createPending above).
  }

  return tools;
}
