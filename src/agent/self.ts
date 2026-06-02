import { defineTool, Type, type ToolDefinition } from '@flue/runtime';
import type { ProviderCatalogEntry } from '../connections/catalog';
import type { ConnectionState } from '../connections/repository';

export interface SelfStatusInput {
  projectId: string;
  agentSlug: string;
  model: string;
  hasDb: boolean;
  hasTicker: boolean;
  hasHeartbeatToken: boolean;
  hasBotToken: boolean;
  hasCodingRunner: boolean;
  hasAgentRunner: boolean;
  hasLinearAgentIngress: boolean;
  canRequestConnections: boolean;
  providerCatalog: ProviderCatalogEntry[];
  connectionState: ConnectionState[];
  connectionToolNames: string[];
}

interface CapabilityStatus {
  enabled: boolean;
  tools: string[];
  note: string;
}

const capability = (enabled: boolean, tools: string[], note: string): CapabilityStatus => ({
  enabled,
  tools: enabled ? tools : [],
  note,
});

export function buildSelfStatus(input: SelfStatusInput) {
  const providerRows = input.connectionState.map((state) => ({
    provider: state.provider,
    status: state.status,
    configKeys: Object.keys(state.config ?? {}).sort(),
  }));
  const githubConnected = input.connectionState.some((state) => state.provider === 'github' && state.status === 'connected');

  return {
    identity: {
      projectId: input.projectId,
      agentSlug: input.agentSlug,
    },
    runtime: {
      harness: 'flue',
      substrate: 'cloudflare_durable_object',
      model: input.model,
    },
    capabilities: {
      reply: capability(true, ['reply_to_conversation'], 'Final answers must be delivered through this tool. Plain text outside it is discarded.'),
      status: capability(true, ['update_status'], 'Use only for slow multi-step turns; it is not the final reply.'),
      skills: capability(input.hasDb, ['save_skill', 'load_skill', 'archive_skill', 'restore_skill'], 'Project skills are durable procedures stored in D1.'),
      reminders: capability(
        input.hasTicker && input.hasHeartbeatToken,
        ['set_reminder', 'list_reminders', 'pause_reminder', 'resume_reminder', 'cancel_reminder'],
        input.hasTicker && input.hasHeartbeatToken
          ? 'Scheduler binding and heartbeat token are present.'
          : 'Unavailable unless the TICKER binding and heartbeat token are present.',
      ),
      memory: capability(input.hasDb, ['save_memory', 'update_memory', 'forget_memory'], 'Project facts are stored in D1.'),
      search: capability(input.hasDb, ['search_channel'], 'Searches prior channel/thread transcripts stored for this project.'),
      workbench: capability(input.hasDb, ['create_work_item', 'list_work_items', 'get_work_item', 'update_work_item'], 'Durable work items are stored in D1.'),
      sourceEvolution: capability(
        input.hasDb,
        ['propose_self_change', ...(input.hasCodingRunner ? ['dispatch_coding_run'] : [])],
        input.hasCodingRunner
          ? 'Source-code change proposals can be recorded and dispatched to the configured generic coding runner.'
          : 'Source-code change proposals can be recorded; coding-run dispatch is unavailable until CODING_RUNNER_URL and WORKBENCH_RUNNER_TOKEN are configured.',
      ),
      agentRuns: capability(
        input.hasDb && input.hasLinearAgentIngress,
        [],
        input.hasAgentRunner
          ? 'Linear state transitions can create Hatchery agent-run leases and dispatch an external E2B Claude Code runner.'
          : 'Linear agent-run intake is available but dispatch is not configured until AGENT_RUNNER_URL and AGENT_RUNNER_TOKEN are set.',
      ),
      userLookup: capability(input.hasDb || input.hasBotToken, ['resolve_user'], 'Resolves Slack user ids via cache and, when available, Slack users.info.'),
      connections: capability(
        input.connectionToolNames.length > 0 || input.canRequestConnections,
        input.connectionToolNames,
        'External API access is broker-gated by project connection state; secrets are never exposed to the model.',
      ),
      repositoryInspection: capability(
        githubConnected,
        githubConnected ? input.connectionToolNames.filter((name) => name.startsWith('github_')) : [],
        'Repository/source inspection is possible only through connected provider tools, not native filesystem access.',
      ),
    },
    connections: {
      providers: providerRows,
      requestableProviders: input.canRequestConnections ? input.providerCatalog.map((entry) => entry.provider) : [],
      toolNames: input.connectionToolNames,
    },
    limits: [
      'This Durable Object agent has no filesystem or shell access.',
      'No raw environment access; Worker secrets are resolved only by trusted broker/tool code.',
      'Repository/source inspection requires a connected provider such as GitHub; it is not VM-style self-introspection.',
      'Source-code evolution happens through workbench proposals, an external coding runner, PR review, and deployment; this agent does not edit or deploy its own code directly.',
      'Linear-driven coding work is control-plane only: Hatchery records leases and callbacks; the external E2B runner owns Claude Code execution, clone/edit/test/commit/PR, and never auto-merges from this runtime.',
      'External writes must go through explicit gated tools; connected read APIs do not grant arbitrary write authority.',
    ],
  };
}

export function selfStatusTool(input: SelfStatusInput): ToolDefinition {
  return defineTool({
    name: 'self_status',
    description:
      'Return your live Hatchery runtime and capability manifest for this turn. Use when the user asks what you can do, ' +
      'which tools/connections are available, how you work, or what your limits are. This is authoritative for current ' +
      'capability status and never exposes secrets.',
    parameters: Type.Object({}),
    async execute() {
      return JSON.stringify(buildSelfStatus(input), null, 2);
    },
  });
}
