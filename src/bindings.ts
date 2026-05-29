// Channel bindings — the entire "control plane" for the first slice.
//
// Shape deliberately mirrors the future `ChannelBinding` + `Project` records
// (see docs/decisions/0001) so migrating to DO-storage / a real control plane
// is "move each literal into a row", not a model redesign. Bindings are trusted
// config: the agent's allowed channel and credential reference come from HERE,
// never from prompt text or model-supplied arguments.

export type SandboxMode = 'virtual' | 'cloudflare-sandbox' | 'daytona' | 'e2b';

export interface Binding {
  provider: 'slack';
  externalTeamId: string;
  externalChannelId: string;
  projectId: string;
  defaultProfile: string;
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
    projectId: 'demo',
    defaultProfile: 'project-assistant',
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
