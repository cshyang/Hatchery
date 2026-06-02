import { defineTool, Type, type ToolDefinition } from '@flue/runtime';
import { genericApiTool, PROVIDER_API_PROFILES } from './api';
import { disconnectedNotice, disableConnectionByRef, loadConnections, type ConnectionState, type ResolvedConnection } from './connections';
import { githubReadTools } from './github';
import { deleteConnection, startConnectSession } from './nango';
import { PROVIDER_CATALOG, providerUsesGenericApi, type ProviderCatalogEntry } from './provider-catalog';
import type { D1Like } from './skills';

// The CONNECTIONS prompt block (mirrors the skills catalog injection). Tells the agent what it
// can reach and what is connectable but not yet wired by an operator.
export function connectionsBlock(
  state: ConnectionState[],
  catalog: ProviderCatalogEntry[],
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
    if ((providerUsesGenericApi(s.provider, creds.config) || isLazy) && profile) {
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
  args: { nangoSecretKey: string; projectId: string; catalog?: ProviderCatalogEntry[] },
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

/** The agent's disconnect tool (Component 3, in-Slack revoke — the only disconnect path a non-operator
 *  Tester has; the Nango dashboard is operator-only and dashboard-delete fires no webhook). Looks up
 *  THIS channel's connection_ref, revokes it at Nango (DELETE — real teardown, token revoked at the
 *  provider), then disables the local row so the provider's tools vanish next turn. No secret param —
 *  same structural wall as request_connection. Disconnect is the least-dangerous write (worst case:
 *  reconnect), so it's agent-callable without an approval gate (unlike a future github_create_issue).
 *  `deps.deleteConnection` is injectable for tests. */
export function disconnectConnectionTool(
  args: { nangoSecretKey: string; projectId: string; db: D1Like; catalog?: ProviderCatalogEntry[] },
  deps: { deleteConnection?: typeof deleteConnection } = {},
): ToolDefinition {
  const catalog = args.catalog ?? PROVIDER_CATALOG;
  const allowed = catalog.map((c) => c.provider);
  const del = deps.deleteConnection ?? deleteConnection;
  return defineTool({
    name: 'disconnect_connection',
    description:
      'Disconnect an external service from THIS channel — revokes access and removes its tools. Pass ' +
      'the provider name. Use when the user asks to disconnect, remove, revoke, or unlink a connection. ' +
      `Connectable/disconnectable providers: ${allowed.join(', ')}.`,
    parameters: Type.Object({
      provider: Type.String({ description: `The provider to disconnect. One of: ${allowed.join(', ')}.` }),
    }),
    async execute({ provider }) {
      const p = String(provider).toLowerCase();
      // Find this channel's live connection_ref for the provider (managed-OAuth rows carry it).
      const rows = await loadConnections(args.db, args.projectId).catch(() => []);
      const row = rows.find((r) => r.provider === p && r.status === 'active' && r.connectionRef);
      if (!row || !row.connectionRef) {
        return `${p} isn't connected to this channel — nothing to disconnect.`;
      }
      // Revoke at Nango first (real teardown; 404 = already gone = fine), then disable locally so the
      // tools disappear next turn. If the Nango call hard-fails (non-404), surface it rather than
      // claim success while the token still lives at the vendor.
      try {
        await del({ secretKey: args.nangoSecretKey, connectionId: row.connectionRef, providerConfigKey: p });
      } catch (e) {
        return `Couldn't fully disconnect ${p}: ${e instanceof Error ? e.message : 'error'}. Nothing was changed — try again.`;
      }
      await disableConnectionByRef(args.db, row.connectionRef);
      return disconnectedNotice(p);
    },
  });
}
