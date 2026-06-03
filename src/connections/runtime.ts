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
import type { D1Like } from '../skills/repository';
import { proposeAgentRouteTool } from '../agent-runs/route-tools';

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
  const canRequestConnect = !!db && !!nangoSecretKey;
  const nangoTools =
    canRequestConnect && db
      ? [requestConnectionTool({ nangoSecretKey, projectId }), disconnectConnectionTool({ nangoSecretKey, projectId, db })]
      : [];
  const routeTools = db ? [proposeAgentRouteTool({ db, projectId })] : [];

  return {
    tools: [...nangoTools, ...routeTools, ...connectionTools(state, secrets)],
    connectionsBlock: state.length || canRequestConnect ? renderConnectionsBlock(state, PROVIDER_CATALOG, canRequestConnect) : null,
    state,
    canRequestConnections: canRequestConnect,
    providerCatalog: PROVIDER_CATALOG,
  };
}
