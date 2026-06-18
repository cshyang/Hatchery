import type { ToolDefinition } from '@flue/runtime';
import type { Binding } from '../project/bindings';
import { connectionState, loadConnectionSpecs, resolveConnection, type ConnectionState, type ResolvedConnection } from './repository';
import {
  connectionTools,
  connectionsBlock as renderConnectionsBlock,
  disconnectConnectionTool,
  requestConnectionTool,
} from './tools';
import { PROVIDER_CATALOG, type ProviderCatalogEntry } from './catalog';
import { toolCallRecorder } from './audit';
import type { D1Like } from '../skills/repository';
import { proposeAgentRouteTool } from '../agent-runs/route-tools';
import { assignCodingRunTool } from '../agent-runs/assign-tool';
import { checkAgentRunsTool } from '../agent-runs/status-tool';
import { parseNangoIntegrationKeys } from './integrations';
import { listIntegrations, type NangoIntegration } from '../providers/nango';

// Enabled-integrations cache: the connections block wants the live Nango list every turn, but one
// HTTP round-trip per turn in the DO initializer is real latency. Cache per secret key for a few
// minutes; on fetch failure serve the last good list (stale beats blank).
const INTEGRATIONS_TTL_MS = 5 * 60_000;
const integrationsCache = new Map<string, { at: number; list: NangoIntegration[] }>();

async function enabledIntegrations(secretKey: string, fetchList: typeof listIntegrations): Promise<NangoIntegration[]> {
  const hit = integrationsCache.get(secretKey);
  if (hit && Date.now() - hit.at < INTEGRATIONS_TTL_MS) return hit.list;
  const list = await fetchList({ secretKey }).catch(() => hit?.list ?? []);
  integrationsCache.set(secretKey, { at: Date.now(), list });
  return list;
}

export interface ConnectionRuntime {
  tools: ToolDefinition[];
  connectionsBlock: string | null;
  state: ConnectionState[];
  canRequestConnections: boolean;
  providerCatalog: ProviderCatalogEntry[];
}

/** Build the connection-facing part of the project agent initializer. Keeps .flue/agents/project.ts
 *  from knowing how connection specs, resolved credentials, Nango self-service tools, and prompt text
 *  fit together. */
export async function buildConnectionRuntime(args: {
  db: D1Like | undefined;
  binding: Binding;
  env: Record<string, unknown>;
  projectId: string;
  /** Injectable for tests; defaults to the live Nango list (cached a few minutes). */
  listIntegrationsImpl?: typeof listIntegrations;
  /** Post a connect link straight into the thread so request_connection never feeds the
   *  high-entropy URL to the model (the connection-turn stall). Wired by the agent. */
  postConnectionLink?: (input: { conversationId: string; text: string }) => Promise<boolean>;
}): Promise<ConnectionRuntime> {
  const { db, binding, env, projectId } = args;
  const specs = await loadConnectionSpecs(db, binding).catch(() => binding.connections ?? []);
  const state = connectionState(specs, env);
  const secrets: Record<string, ResolvedConnection> = {};

  for (const s of state) {
    if (s.status !== 'connected') continue;
    const resolved = resolveConnection(specs, env, s.provider);
    if (resolved) secrets[s.provider] = resolved;
  }

  const nangoSecretKey = typeof env.NANGO_SECRET_KEY === 'string' ? env.NANGO_SECRET_KEY : '';
  const nangoIntegrationKeys = parseNangoIntegrationKeys(env.NANGO_INTEGRATION_KEYS);
  const canRequestConnect = !!db && !!nangoSecretKey;
  const available = canRequestConnect ? await enabledIntegrations(nangoSecretKey, args.listIntegrationsImpl ?? listIntegrations) : [];
  const nangoTools =
    canRequestConnect && db
      ? [
          requestConnectionTool(
            { nangoSecretKey, projectId, nangoIntegrationKeys, enabledIntegrationKeys: available.map((i) => i.uniqueKey) },
            { postConnectionLink: args.postConnectionLink },
          ),
          disconnectConnectionTool({ nangoSecretKey, projectId, db }),
        ]
      : [];
  const autoActivate = env.ROUTES_AUTO_ACTIVATE === 'true'; // dogfood flag: skip the admin counter-signature on routes
  const routeTools = db
    ? [proposeAgentRouteTool({ db, projectId, autoActivate }), assignCodingRunTool({ db, projectId }), checkAgentRunsTool({ db, projectId })]
    : [];

  // Audit recorder bound to this project: fire-and-forget, so a dead D1 never fails a turn.
  const audit = db ? toolCallRecorder(db, projectId) : undefined;

  return {
    tools: [...nangoTools, ...routeTools, ...connectionTools(state, secrets, nangoSecretKey || undefined, audit)],
    connectionsBlock:
      state.length || canRequestConnect ? renderConnectionsBlock(state, PROVIDER_CATALOG, canRequestConnect, available) : null,
    state,
    canRequestConnections: canRequestConnect,
    providerCatalog: PROVIDER_CATALOG,
  };
}
