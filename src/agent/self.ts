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
  hasCodeMode: boolean;
  codeModeLimits: {
    maxCodeBytes: number;
    maxInputBytes: number;
    maxOutputBytes: number;
    cpuMs: number;
    subRequests: number;
  } | null;
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
        input.hasDb ? ['propose_agent_route'] : [],
        input.hasAgentRunner
          ? 'Admin-approved routes can turn Linear state transitions into Hatchery agent-run receipts and dispatch the Trigger.dev-hosted Pi runner with Agent Kits. Boundary events are stored in the event ledger; route activation is admin-only.'
          : 'Linear agent-run intake and route proposals are available, but Trigger.dev runner dispatch is not configured yet. Route activation is admin-only.',
      ),
      codeMode: capability(
        input.hasCodeMode,
        ['execute_code'],
        input.hasCodeMode && input.codeModeLimits
          ? `Coordinator Code Mode can run lightweight JavaScript and Python in Cloudflare Dynamic Workers with public network access by default. Limits: code ${input.codeModeLimits.maxCodeBytes} bytes, input ${input.codeModeLimits.maxInputBytes} bytes, output ${input.codeModeLimits.maxOutputBytes} bytes, CPU ${input.codeModeLimits.cpuMs}ms, subrequests ${input.codeModeLimits.subRequests}. It is not bash, not a repo workspace, and receives no Hatchery secrets or provider tokens.`
          : 'Unavailable unless DB and DYNAMIC_WORKER_LOADER are configured. Code Mode is for lightweight JavaScript/Python only, not bash or repo workspaces.',
      ),
      userLookup: capability(input.hasDb || input.hasBotToken, ['resolve_user'], 'Resolves Slack user ids via cache and, when available, Slack users.info.'),
      connections: capability(
        input.connectionToolNames.length > 0 || input.canRequestConnections,
        input.connectionToolNames,
        'External API access is broker-gated by project connection state; secrets are never exposed to the model. GitHub can be requested as OAuth or a repo-scoped PAT without passing the PAT through chat/tools.',
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
      'Linear-driven coding work is control-plane only: Hatchery records leases and callbacks; the Trigger.dev runner owns Pi execution, Agent Kit loading, clone/edit/test/commit/PR, and never auto-merges from this runtime.',
      'Trigger.dev is the runner host, not the run-state source of truth. E2B or another sandbox/workspace provider is still required before running arbitrary third-party repos.',
      'Coordinator Code Mode can execute lightweight JavaScript/Python only when configured; it has no bash, git, npm install, pip install, persistent filesystem, or source-code write authority.',
      'External writes must go through explicit gated tools; connected read APIs do not grant arbitrary write authority.',
      'GitHub PAT setup stores only auth-mode/repo metadata and a Nango connection reference; the PAT remains in Nango.',
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
