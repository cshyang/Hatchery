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
  /** Provider account / workspace (Slack: team id). */
  externalAccountId: string;
  /** The space / room this project is bound to (Slack: channel id). */
  externalSpaceId: string;
  /** The transport's own id, used to detect when it's addressed/participating (Slack: bot user id).
   *  Consumed by provider-specific engagement logic (e.g. Slack @mention parsing). From auth.test. */
  transportBotId: string;
  projectId: string;
  defaultProfile: string;
  /** Model id passed to Flue (e.g. "zai/glm-5.1"). Optional → DEFAULT_MODEL. Per-project so a
   *  project can run a different model; the prompt itself is model-agnostic. NOTE: a non-default
   *  model also needs Flue provider routing + creds to actually run — this field is just the seam. */
  model?: string;
  /** No-op today (always 'virtual'); the seam that lets a project graduate to a real sandbox later. */
  sandboxMode: SandboxMode;
  /** Name of the env var / secret holding this transport's token. Tokens never live in code or prompts. */
  transportTokenRef: string;
  /** External tool connections (ADR 0003). Each names the Worker secret holding the provider's
   *  token (like transportTokenRef) + non-secret config (e.g. the pinned repo). The secret is set
   *  with `wrangler secret put`; a connection is "connected" once its secret is present. */
  connections?: ConnectionSpec[];
  status: 'active' | 'disabled';
}

export interface ConnectionSpec {
  provider: string;
  /** Worker-secret name holding this provider's token (e.g. 'GITHUB_PAT_DEMO'). */
  tokenRef: string;
  config?: Record<string, unknown>;
}

export const bindings: readonly Binding[] = [
  {
    provider: 'slack',
    externalAccountId: 'T0B6VB415TQ', // Slack workspace/team id (Ecodark)
    externalSpaceId: 'C0B6VFMVCUW', // the bound channel id
    transportBotId: 'U0B6UB2E5HT', // hatch_agent's bot user id (auth.test)
    projectId: 'demo',
    defaultProfile: 'project-assistant',
    model: 'zai/glm-5.1',
    sandboxMode: 'virtual',
    transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
    // GitHub connection (ADR 0003). Shows as "not connected" until the GITHUB_PAT_ECODARK Worker
    // secret is set (`wrangler secret put GITHUB_PAT_ECODARK --name hatchery`). config.repo is the
    // default repo for the read tools when the model omits owner/name.
    connections: [{ provider: 'github', tokenRef: 'GITHUB_PAT_ECODARK', config: { repo: 'ecodarklabs/website' } }],
    status: 'active',
  },
];

/** Route an inbound message to its project by provider account + space. Only active bindings match. */
export function bindingBySlack(accountId: string, spaceId: string): Binding | undefined {
  return bindings.find(
    (b) => b.externalAccountId === accountId && b.externalSpaceId === spaceId && b.status === 'active',
  );
}

/** Resolve a project's binding from an agent instance id. */
export function bindingByProject(projectId: string): Binding | undefined {
  return bindings.find((b) => b.projectId === projectId && b.status === 'active');
}
