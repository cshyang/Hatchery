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

import { defineTool, Type, type ToolDefinition } from '@flue/runtime';
import type { Binding, ConnectionSpec } from './bindings';
import type { D1Like } from './skills';
import { githubReadTools } from './github';
import { genericApiTool, PROVIDER_API_PROFILES } from './api';
import { fetchToken, startConnectSession } from './nango';

export interface ConnectionState {
  provider: string;
  status: 'connected' | 'not_connected';
  config: Record<string, unknown>;
}

/** Derive each declared connection's state from its specs + whether its Worker secret is present.
 *  Drives gating + the prompt block. Pure over specs (the initializer resolves specs first via
 *  loadConnectionSpecs). Never exposes the secret. A connectionRef row reads as connected once
 *  NANGO_SECRET_KEY is present (the managed-OAuth backend; the token is fetched lazily in the tool). */
export function connectionState(specs: ConnectionSpec[], env: Record<string, unknown>): ConnectionState[] {
  const nangoKey = env.NANGO_SECRET_KEY;
  const hasNangoPlatform = typeof nangoKey === 'string' && !!nangoKey;
  return specs.map((s) => {
    const token = s.tokenRef ? env[s.tokenRef] : undefined;
    const hasWorkerSecret = typeof token === 'string' && !!token;
    // Managed-OAuth (Nango): a connection_ref means a connection exists; the platform key means we
    // can fetch its token. Both → connected (the token itself is fetched lazily in the tool).
    const hasNango = !!s.connectionRef && hasNangoPlatform;
    return {
      provider: s.provider,
      status: hasWorkerSecret || hasNango ? 'connected' : 'not_connected',
      config: s.config ?? {},
    };
  });
}

/** A resolved credential for one provider. `secret` is EITHER a literal Worker-secret string
 *  (operator/static backend) OR a lazy, per-turn-memoized token fetch (managed-OAuth/Nango). The
 *  generic call tool resolves it at the network boundary, so a Nango token is fetched only when a
 *  tool actually runs — never in the DO initializer. */
export interface ResolvedConnection {
  secret: string | (() => Promise<string>);
  config: Record<string, unknown>;
}

/** Resolve a provider's credential from specs, or null if not declared / unusable. The ONE
 *  resolution path (the swappable seam). Worker-secret backend → a literal string; managed-OAuth
 *  (Nango) backend → a lazy thunk that fetches a live token on first call and memoizes it for the
 *  rest of the turn. `deps.fetchToken` is injectable for tests. */
export function resolveConnection(
  specs: ConnectionSpec[],
  env: Record<string, unknown>,
  provider: string,
  deps: { fetchToken?: typeof fetchToken } = {},
): ResolvedConnection | null {
  const spec = specs.find((s) => s.provider === provider);
  if (!spec) return null;

  // Worker-secret backend (operator/static): a literal secret present in env.
  if (spec.tokenRef) {
    const token = env[spec.tokenRef];
    if (typeof token === 'string' && token) return { secret: token, config: spec.config ?? {} };
  }

  // Managed-OAuth backend (Nango): connection_ref + platform key → a lazy, per-turn-memoized token
  // fetch. Memoizing the PROMISE dedupes concurrent tool calls AND caps a multi-call turn at ONE
  // Nango round-trip (keeps us off the ~30s DO-turn wall). The token is never stored at rest.
  const nangoKey = env.NANGO_SECRET_KEY;
  if (spec.connectionRef && typeof nangoKey === 'string' && nangoKey) {
    const fetchTok = deps.fetchToken ?? fetchToken;
    const secretKey = nangoKey;
    const connectionId = spec.connectionRef;
    const providerConfigKey = provider; // convention: Nango integration id == catalog slug
    // `??=` caches the PROMISE on first call. A REJECTED promise stays cached too — so a failed token
    // fetch is NOT retried within this turn (every later secret() call this turn gets the same
    // rejection). Intentional: one Nango hiccup shouldn't trigger a retry storm across a multi-call
    // turn. The credential is rebuilt fresh by the DO initializer every turn, so the next turn retries.
    let cached: Promise<string> | undefined;
    const secret = () => (cached ??= fetchTok({ secretKey, connectionId, providerConfigKey }));
    return { secret, config: spec.config ?? {} };
  }

  return null;
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

/** The "✅ connected" line the gateway posts to the channel when a Nango connection lands. The
 *  webhook has no conversation thread to reply into, so the GATEWAY (not the agent) posts this — a
 *  deterministic confirmation that doesn't depend on the model choosing to reply. The tools attach on
 *  the channel's next turn (computed fresh from D1), which is what this message tells the user. */
export function connectedNotice(provider: string): string {
  return `✅ ${provider} connected — ask me to use it anytime (it'll be ready on your next message).`;
}

/** The "🔌 disconnected" line the gateway posts when a Nango connection is removed. Posted only when a
 *  row was actually disabled (so we don't announce a delete for a connection we never had). */
export function disconnectedNotice(provider: string): string {
  return `🔌 ${provider} disconnected — its tools are no longer available. Reconnect anytime by asking me.`;
}

/** Disable the connection row matching a Nango connection_ref (the deletion path). Targets by
 *  connection_ref — the only field guaranteed present on a deletion webhook — NOT by project/provider.
 *  Returns {projectId, provider} of the disabled row (so the gateway can post the notice to the right
 *  channel), or null if no row matched (already gone / never ours). Flipping status to 'disabled'
 *  makes loadConnectionSpecs drop it → the provider's tools disappear next turn. We disable rather
 *  than DELETE so the row stays an audit trail and a re-connect cleanly overwrites it. */
export async function disableConnectionByRef(
  db: D1Like,
  connectionRef: string,
): Promise<{ projectId: string; provider: string } | null> {
  const row = await db
    .prepare('SELECT project_id, provider FROM connections WHERE connection_ref=? AND status=\'active\'')
    .bind(connectionRef)
    .first<{ project_id: string; provider: string }>();
  if (!row) return null;
  await db
    .prepare('UPDATE connections SET status=\'disabled\', updated_at=? WHERE connection_ref=?')
    .bind(Date.now(), connectionRef)
    .run();
  return { projectId: row.project_id, provider: row.provider };
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
export function connectionsBlock(
  state: ConnectionState[],
  catalog: { provider: string; summary: string }[],
  canRequest = false,
): string {
  const byProvider = new Map(state.map((s) => [s.provider, s]));
  const lines = catalog.map((c) => {
    const s = byProvider.get(c.provider);
    if (s?.status === 'connected') return `  ✅ ${c.provider} (connected) — ${c.summary}`;
    return `  ⚪ ${c.provider} (not connected) — ${c.summary}`;
  });
  const intro = canRequest
    ? 'External services you can reach. Connected ones expose tools you can call now. For one that is NOT ' +
      'connected, call request_connection with the provider name — you get a secure link to share; the ' +
      'person authorizes off-Slack (you never see the credential) and that provider\'s tools appear ' +
      'automatically once they finish.'
    : 'External services you can reach. Connected ones expose tools you can call now; the rest must be ' +
      'wired by an operator first (mention that you need it — you cannot connect it yourself).';
  return (
    'YOUR CONNECTIONS\n' +
    intro +
    '\n' +
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
  secrets: Record<string, ResolvedConnection>,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  for (const s of state) {
    if (s.status !== 'connected') continue;
    const creds = secrets[s.provider];
    if (!creds) continue;

    // Generic path (default unless a provider has typed tools and isn't opted into generic): one
    // <provider>_call_api tool driven by the provider's API profile. The model composes the call.
    const profile = PROVIDER_API_PROFILES[s.provider];
    // A Nango-backed credential is a lazy thunk; the typed tools (githubReadTools) take a string PAT
    // and cannot consume it. Route any thunk secret through the generic call_api path (genericApiTool
    // resolves the thunk at call time). A provider with a thunk secret but NO api profile would be
    // toolless — that can't happen today (catalog ⊆ providers-with-a-profile), but the guard degrades
    // to "no tool" rather than a crash.
    const isLazy = typeof creds.secret === 'function';
    if ((useGenericApi(s.provider, creds.config) || isLazy) && profile) {
      tools.push(genericApiTool(profile, creds.secret, creds.config));
      continue;
    }

    // Typed fallback (github, apiMode !== 'generic'): the proven v2a read tools, untouched. Only a
    // string-secret connection reaches here (thunks took the generic path above), so the cast is safe.
    if (s.provider === 'github') {
      const repo = typeof creds.config.repo === 'string' ? creds.config.repo : undefined;
      tools.push(...githubReadTools(creds.secret as string, repo));
      // v2b plugs the github_create_issue propose-tool in here.
    }
  }

  return tools;
}

/** The agent's connect request (Component 3). Returns a tool that starts a Nango Connect session for
 *  THIS channel and hands back the magic link for the agent to share. THE STRUCTURAL WALL: there is
 *  no parameter that accepts a secret — a prompt-injected agent has no tool to receive or store a
 *  token. Gated to the provider catalog (the agent can't request an arbitrary provider).
 *  `deps.startConnectSession` is injectable for tests. */
export function requestConnectionTool(
  args: { nangoSecretKey: string; projectId: string; catalog?: { provider: string; summary: string }[] },
  deps: { startConnectSession?: typeof startConnectSession } = {},
): ToolDefinition {
  const catalog = args.catalog ?? PROVIDER_CATALOG;
  const allowed = catalog.map((c) => c.provider);
  const start = deps.startConnectSession ?? startConnectSession;
  return defineTool({
    name: 'request_connection',
    description:
      'Start connecting an external service for THIS channel. Pass the provider name; you get back a ' +
      'secure authorization link to share with the person. They click it and authorize off-Slack — you ' +
      "NEVER receive or handle the credential. Once they finish, that provider's tools appear " +
      `automatically. Connectable providers: ${allowed.join(', ')}.`,
    parameters: Type.Object({
      provider: Type.String({ description: `The provider to connect. One of: ${allowed.join(', ')}.` }),
    }),
    async execute({ provider }) {
      const p = String(provider).toLowerCase();
      if (!allowed.includes(p)) {
        return `Cannot connect "${provider}" — not a supported provider. Supported: ${allowed.join(', ')}.`;
      }
      // integrationId == provider slug, by convention (the operator names the Nango integration to match).
      const { connectLink } = await start({ secretKey: args.nangoSecretKey, endUserId: args.projectId, integrationId: p });
      return (
        `Share this link with the user to connect ${p} (it opens ${p}'s secure authorization page off-Slack — ` +
        `you never see the credential):\n${connectLink}\n` +
        `Once they authorize, ${p} tools will appear automatically and you can use them.`
      );
    },
  });
}
