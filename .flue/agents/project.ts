import { createAgent, defineTool, Type, type AgentRuntimeConfig, type ToolDefinition } from '@flue/runtime';
import { bindingByProject, parseAgentInstanceId, DEFAULT_MODEL } from '../../src/bindings';
import { loadConversationTarget, sendToConversationTarget, topLevelTargetFromBinding } from '../../src/conversations';
import { skillTools, loadSkillCatalog, loadActiveSkillBody, skillBody, type D1Like } from '../../src/skills';
import { reminderTools } from '../../src/reminders';
import { buildInstructions } from '../../src/prompt';
import { loadProjectMemory, memoryTools, renderMemory } from '../../src/memory';
import { logMessage } from '../../src/reflection';
import {
  connectionState,
  resolveConnection,
  connectionTools,
  connectionsBlock,
  loadConnectionSpecs,
  PROVIDER_CATALOG,
  type ConnectionState,
} from '../../src/connections';

// The project agent. Addressed at /agents/project/<id>, id = "project:<projectId>:agent:<slug>"
// (slug = "default" until a channel hosts multiple personas). Each instance is a persistent
// Durable Object — the per-(project, persona) boundary.
//
// Access is enforced by TOOLS, not the prompt: replies resolve a stored conversation target
// plus token ref from trusted config; skills/reminders/memory are scoped to this projectId.
// The model controls only the content, never the destination or another project's data.
//
// NOTE: the work below runs in Flue's `createAgent` INITIALIZER (which may be async), NOT
// the Durable Object constructor. The DO constructor stays boring — no D1/network there.

export default createAgent(async (ctx): Promise<AgentRuntimeConfig> => {
  const { projectId, slug } = parseAgentInstanceId(ctx.id);
  const env = ctx.env as Record<string, unknown>;
  const db = env.DB as D1Like | undefined;
  const binding = await bindingByProject(projectId, db);

  // No active binding → an inert agent with no posting capability.
  if (!binding) {
    return {
      model: DEFAULT_MODEL,
      instructions: `No active binding for project "${projectId}". Do not attempt to post anywhere.`,
    };
  }

  const ticker = env.TICKER as { fetch(request: Request): Promise<Response> } | undefined;
  const heartbeatToken = (env.HEARTBEAT_TOKEN as string | undefined) ?? '';

  // L1 catalog query — cheap, every turn. .catch keeps a D1 hiccup from breaking the agent.
  const skills = db ? await loadSkillCatalog(db, projectId).catch(() => []) : [];
  // Personality (overwritable): a skill named `personality` defines the agent's role/voice and is
  // applied to EVERY turn. Absent → a general default. This is the only purpose-layer; everything
  // else below is fixed FUNCTION. Loaded eagerly (not on demand) so it colors all output.
  const personality =
    db && skills.some((s) => s.name === 'personality')
      ? await loadActiveSkillBody(db, projectId, 'personality').catch(() => null)
      : null;
  const catalog = skills.filter((s) => s.name !== 'personality'); // applied above, not load-on-demand

  // Memory (always-injected, bounded, project-scoped — shared channel facts). NOTE: per-author
  // user memory can't be injected here — Flue's dispatch leaves the initializer blind to the
  // turn's author (ctx.payload is undefined on dispatch; only the model sees senderId). People-
  // facts therefore live in project memory; a future self-scheduled reflection job distils them
  // from thread history. .catch keeps a D1 hiccup from breaking the agent.
  const projectMem = db ? await loadProjectMemory(db, projectId).catch(() => []) : [];
  const memoryBlock = renderMemory(projectMem);

  // Connections (ADR 0003): which external services this project can reach. Each connection is a
  // binding spec naming the Worker secret that holds the provider's token (like the Slack token).
  // The initializer reads connection state from the binding + env, resolves each CONNECTED
  // provider's token, and hands it to connectionTools, which contributes that provider's tools
  // (v2a = reads only). Tool visibility = connection state (gating). No secret missing → that
  // provider is simply "not connected"; never a broken agent.
  // Specs come from D1 (live, operator-provisioned) merged over the binding seed — so a connection
  // can be added/changed without a redeploy. .catch keeps a D1 hiccup from breaking the agent.
  const connSpecs = await loadConnectionSpecs(db, binding).catch(() => binding.connections ?? []);
  const connState: ConnectionState[] = connectionState(connSpecs, env);
  const connSecrets: Record<string, { secret: string; config: Record<string, unknown> }> = {};
  for (const s of connState) {
    if (s.status !== 'connected') continue;
    const resolved = resolveConnection(connSpecs, env, s.provider);
    if (resolved) connSecrets[s.provider] = resolved;
  }
  const connBlock = connState.length ? connectionsBlock(connState, PROVIDER_CATALOG) : null;

  const replyToConversation = defineTool({
    name: 'reply_to_conversation',
    description:
      "Send your reply to the current conversation. Call this with your final response text; pass conversationId for user-message replies.",
    parameters: Type.Object({
      text: Type.String({ description: 'The message to post.' }),
      conversationId: Type.Optional(
        Type.String({
          description:
            "When replying to a user message, copy the conversationId from the [Dispatch Input] block. OMIT for a heartbeat/new top-level post.",
        }),
      ),
    }),
    async execute({ text, conversationId }) {
      const conv = conversationId ? String(conversationId) : '';
      const target = conv
        ? db
          ? await loadConversationTarget(db, projectId, slug, conv)
          : null
        : topLevelTargetFromBinding(binding, slug);
      if (!target) {
        throw new Error(`No reply target found for conversationId "${conv}".`);
      }
      await sendToConversationTarget(env, target, String(text));
      // Log the agent's own post to the transcript (the other half of the conversation reflection
      // consolidates). REM turns are told not to post, so this never logs reflection's own output.
      if (db) await logMessage(db, { projectId, conversationId: conv, senderId: 'agent', role: 'agent', text: String(text) }).catch(() => {});
      return 'sent';
    },
  });

  const tools: ToolDefinition[] = [
    replyToConversation,
    ...(db ? skillTools(db, projectId) : []),
    ...reminderTools(ticker, heartbeatToken, projectId),
    ...(db ? memoryTools(db, projectId) : []),
    ...connectionTools(connState, connSecrets),
  ];

  return {
    model: binding.model ?? DEFAULT_MODEL,
    instructions: buildInstructions({
      projectName: binding.projectId,
      personality: personality ? skillBody(personality) : null,
      catalog,
      memoryBlock,
      connectionsBlock: connBlock,
    }),
    tools,
  };
});
