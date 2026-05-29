// Channel bindings — the entire "control plane" for the first slice.
//
// Shape deliberately mirrors the future `ChannelBinding` + `Project` records
// (see docs/decisions/0001) so migrating to DO-storage / a real control plane
// is "move each literal into a row", not a model redesign. Bindings are trusted
// config: the agent's allowed channel and credential reference come from HERE,
// never from prompt text or model-supplied arguments.

export type SandboxMode = 'virtual' | 'cloudflare-sandbox' | 'daytona' | 'e2b';

/** Default model when a binding doesn't pin one. */
export const DEFAULT_MODEL = 'zai/glm-5.1';

/** The persona slug used until a project hosts more than one agent. */
export const DEFAULT_AGENT_SLUG = 'default';

// Flue DO instance id for a project's agent persona: `project:<projectId>:agent:<slug>`.
// The slug is 'default' today — baked in now because DO instance ids are sticky (renaming
// one makes a NEW DO and orphans its sessions). A channel is the shared room; each persona
// is its own instance inside it. Build + parse go through these two functions so the format
// never drifts across the heartbeat / scheduled / event dispatch sites.
export function agentInstanceId(projectId: string, slug: string = DEFAULT_AGENT_SLUG): string {
  return `project:${projectId}:agent:${slug}`;
}

/** Parse projectId + slug from an instance id. Tolerates the legacy bare `project:<id>`
 *  (no `:agent:` suffix) so any DO created before this change still resolves. */
export function parseAgentInstanceId(id: string): { projectId: string; slug: string } {
  const m = id.match(/^project:(.+):agent:([^:]+)$/);
  if (m) return { projectId: m[1], slug: m[2] };
  const projectId = id.startsWith('project:') ? id.slice('project:'.length) : id;
  return { projectId, slug: DEFAULT_AGENT_SLUG };
}

export interface Binding {
  provider: 'slack';
  externalTeamId: string;
  externalChannelId: string;
  /** The bot's own Slack user id (e.g. "U…"). Used to detect @mentions and to
   *  check whether the bot is already participating in a thread. From auth.test. */
  botUserId: string;
  projectId: string;
  defaultProfile: string;
  /** Model id passed to Flue (e.g. "zai/glm-5.1"). Optional → DEFAULT_MODEL. Per-project so a
   *  project can run a different model; the prompt itself is model-agnostic. NOTE: a non-default
   *  model also needs Flue provider routing + creds to actually run — this field is just the seam. */
  model?: string;
  /** No-op today (always 'virtual'); the seam that lets a project graduate to a real sandbox later. */
  sandboxMode: SandboxMode;
  /** Name of the env var / secret holding this project's Slack bot token. Tokens never live in code or prompts. */
  botTokenRef: string;
  status: 'active' | 'disabled';
}

export const bindings: readonly Binding[] = [
  {
    provider: 'slack',
    externalTeamId: 'T0B6VB415TQ', // Slack workspace/team id (Ecodark)
    externalChannelId: 'C0B6VFMVCUW', // the bound channel id
    botUserId: 'U0B6UB2E5HT', // hatch_agent's user id (auth.test)
    projectId: 'demo',
    defaultProfile: 'project-assistant',
    model: 'zai/glm-5.1',
    sandboxMode: 'virtual',
    botTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
    status: 'active',
  },
];

/** Route an inbound Slack event to its project. Only active bindings match. */
export function bindingBySlack(teamId: string, channelId: string): Binding | undefined {
  return bindings.find(
    (b) => b.externalTeamId === teamId && b.externalChannelId === channelId && b.status === 'active',
  );
}

/** Resolve a project's binding from an agent instance id. */
export function bindingByProject(projectId: string): Binding | undefined {
  return bindings.find((b) => b.projectId === projectId);
}
