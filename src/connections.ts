// The connection broker (ADR 0003). Owns per-project credential resolution, the tool-gating
// decision, and the prompt block. Vendors are swappable behind resolveConnection — the agent,
// gating, and approval flow don't change as backends evolve.
//
// v2a backend = WORKER SECRET REFERENCES, identical to how the Slack bot token already works
// (binding.transportTokenRef → env[ref]). A connection is declared in the binding as
// {provider, tokenRef, config}; the actual secret lives as a Worker secret set with
// `wrangler secret put`, never in code, D1, the prompt, or the model. This deliberately is NOT
// a self-managed vault (no master key, no admin route, no ciphertext column): for an operator
// provisioning a handful of projects, a Worker secret is simpler AND no less secure at rest
// (CF KMS, write-only) than hand-rolled encrypted D1.
//
// Future backends slot behind the SAME resolveConnection signature:
//   - OAuth providers (Google Ads, Meta) → a Composio/Nango account-ref (vendor holds the token)
//   - static-key SELF-SERVICE (a client pastes a key at runtime) → encrypted D1 or a managed
//     vault — built only when that pain is real (the crypto.ts version lives in git history).

import type { ToolDefinition } from '@flue/runtime';
import type { Binding, ConnectionSpec } from './bindings';
import type { D1Like } from './skills';
import { githubReadTools } from './github';
import { genericApiTool, PROVIDER_API_PROFILES } from './api';

export interface ConnectionState {
  provider: string;
  status: 'connected' | 'not_connected';
  config: Record<string, unknown>;
}

/** Derive each declared connection's state from its specs + whether its Worker secret is present.
 *  Drives gating + the prompt block. Pure over specs (the initializer resolves specs first via
 *  loadConnectionSpecs). Never exposes the secret. A connectionRef-only row (managed-OAuth, no
 *  tokenRef) reads as not_connected until that backend lands. */
export function connectionState(specs: ConnectionSpec[], env: Record<string, unknown>): ConnectionState[] {
  return specs.map((s) => {
    const token = s.tokenRef ? env[s.tokenRef] : undefined;
    return {
      provider: s.provider,
      status: typeof token === 'string' && token ? 'connected' : 'not_connected',
      config: s.config ?? {},
    };
  });
}

/** Resolve a provider's secret + config from specs, or null if not declared / secret missing.
 *  The ONE resolution path (the swappable seam). Today it reads a Worker secret by ref; a future
 *  managed-OAuth backend slots in here behind the same signature (read connectionRef → vendor). */
export function resolveConnection(
  specs: ConnectionSpec[],
  env: Record<string, unknown>,
  provider: string,
): { secret: string; config: Record<string, unknown> } | null {
  const spec = specs.find((s) => s.provider === provider);
  if (!spec || !spec.tokenRef) return null;
  const token = env[spec.tokenRef];
  if (typeof token !== 'string' || !token) return null;
  return { secret: token, config: spec.config ?? {} };
}

// ── D1 metadata layer (operator-provisioned, no redeploy) ───────────────────────────────────────

export interface ConnectionRecord {
  provider: string;
  tokenRef?: string;
  connectionRef?: string;
  config: Record<string, unknown>;
  status: 'active' | 'disabled';
}

/** Live connection rows for a project (metadata only — never a secret). */
export async function loadConnections(db: D1Like, projectId: string): Promise<ConnectionRecord[]> {
  const { results } = await db
    .prepare('SELECT provider, token_ref, connection_ref, config_json, status FROM connections WHERE project_id=?')
    .bind(projectId)
    .all<{ provider: string; token_ref: string | null; connection_ref: string | null; config_json: string | null; status: string }>();
  return (results ?? []).map((r) => ({
    provider: r.provider,
    tokenRef: r.token_ref ?? undefined,
    connectionRef: r.connection_ref ?? undefined,
    config: r.config_json ? (JSON.parse(r.config_json) as Record<string, unknown>) : {},
    status: r.status === 'disabled' ? 'disabled' : 'active',
  }));
}

/** The effective connection specs for a project: bindings.ts `connections` is a CODE SEED; live D1
 *  rows are the source of truth — they add/override by provider, and status='disabled' removes a
 *  seeded one. This is what lets an operator add a connection with no redeploy. A D1 hiccup falls
 *  back to the seed so a transient DB error can't strip a working connection. */
export async function loadConnectionSpecs(db: D1Like | undefined, binding: Binding): Promise<ConnectionSpec[]> {
  const seed = binding.connections ?? [];
  if (!db) return seed;
  const rows = await loadConnections(db, binding.projectId).catch(() => null);
  if (!rows) return seed; // DB hiccup → keep the seed rather than dropping connections
  const byProvider = new Map<string, ConnectionSpec>();
  for (const s of seed) byProvider.set(s.provider, s);
  for (const r of rows) {
    if (r.status === 'disabled') {
      byProvider.delete(r.provider);
      continue;
    }
    byProvider.set(r.provider, { provider: r.provider, tokenRef: r.tokenRef, connectionRef: r.connectionRef, config: r.config });
  }
  return [...byProvider.values()];
}

export interface UpsertConnectionInput {
  projectId: string;
  provider: string;
  tokenRef?: string;
  connectionRef?: string;
  config?: Record<string, unknown>;
  status?: 'active' | 'disabled';
  createdBy?: string;
}

/** OPERATOR write (route-guarded, never the agent). Upsert a connection's metadata. The secret it
 *  references must be set separately via `wrangler secret put` — this never receives or stores it. */
export async function upsertConnection(db: D1Like, input: UpsertConnectionInput): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO connections(project_id, provider, token_ref, connection_ref, config_json, status, created_by, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(project_id, provider) DO UPDATE SET
         token_ref=excluded.token_ref,
         connection_ref=excluded.connection_ref,
         config_json=excluded.config_json,
         status=excluded.status,
         updated_at=excluded.updated_at`,
    )
    .bind(
      input.projectId,
      input.provider,
      input.tokenRef ?? null,
      input.connectionRef ?? null,
      input.config ? JSON.stringify(input.config) : null,
      input.status ?? 'active',
      input.createdBy ?? null,
      now,
      now,
    )
    .run();
}

// The provider catalog (what Hatchery supports at all). Curated platform-side; the agent picks
// from it, never adds to it.
export const PROVIDER_CATALOG: { provider: string; summary: string }[] = [
  { provider: 'github', summary: 'read issues/code, search (creating issues comes later, with approval)' },
  { provider: 'notion', summary: 'read pages/databases, search (read-only token)' },
];

// Providers that ship hand-written typed tools as a fallback. For these, the generic call_api tool
// is opt-IN via config.apiMode='generic'. Everyone else defaults to the generic tool (the
// bet-on-intelligence path) whenever a provider API profile exists.
const TYPED_TOOL_PROVIDERS = new Set<string>(['github']);

function useGenericApi(provider: string, config: Record<string, unknown>): boolean {
  if (config.apiMode === 'typed') return false;
  if (config.apiMode === 'generic') return true;
  return !TYPED_TOOL_PROVIDERS.has(provider);
}

// The CONNECTIONS prompt block (mirrors the skills catalog injection). Tells the agent what it
// can reach and what is connectable but not yet wired by an operator.
export function connectionsBlock(state: ConnectionState[], catalog: { provider: string; summary: string }[]): string {
  const byProvider = new Map(state.map((s) => [s.provider, s]));
  const lines = catalog.map((c) => {
    const s = byProvider.get(c.provider);
    if (s?.status === 'connected') return `  ✅ ${c.provider} (connected) — ${c.summary}`;
    return `  ⚪ ${c.provider} (not connected) — ${c.summary}`;
  });
  return (
    'YOUR CONNECTIONS\n' +
    'External services you can reach. Connected ones expose tools you can call now; the rest must be ' +
    'wired by an operator first (mention that you need it — you cannot connect it yourself).\n' +
    lines.join('\n') +
    '\nKeep API work tight: reach the answer in as few calls as you can (ideally 1–3). Do NOT fan out ' +
    'to read every result of a search/list — fetch the list, then read details only for what the user ' +
    'actually asked about. Long chains of calls can stall the turn.'
  );
}

/** Tools contributed by connections, gated on state (ADR D6): the initializer pushes these only
 *  for connected providers. v2a = READS only. The github_create_issue PROPOSE tool is v2b — it
 *  ships together with the gateway executor + Block Kit approval + hard-gate tests, so we don't
 *  leave a propose tool whose other half doesn't exist. `secrets` maps provider → resolved
 *  {secret, config}. */
export function connectionTools(
  state: ConnectionState[],
  secrets: Record<string, { secret: string; config: Record<string, unknown> }>,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  for (const s of state) {
    if (s.status !== 'connected') continue;
    const creds = secrets[s.provider];
    if (!creds) continue;

    // Generic path (default unless a provider has typed tools and isn't opted into generic): one
    // <provider>_call_api tool driven by the provider's API profile. The model composes the call.
    const profile = PROVIDER_API_PROFILES[s.provider];
    if (useGenericApi(s.provider, creds.config) && profile) {
      tools.push(genericApiTool(profile, creds.secret, creds.config));
      continue;
    }

    // Typed fallback (github, apiMode !== 'generic'): the proven v2a read tools, untouched.
    if (s.provider === 'github') {
      const repo = typeof creds.config.repo === 'string' ? creds.config.repo : undefined;
      tools.push(...githubReadTools(creds.secret, repo));
      // v2b plugs the github_create_issue propose-tool in here.
    }
  }

  return tools;
}
