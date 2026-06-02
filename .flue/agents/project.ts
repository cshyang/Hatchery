import { createAgent, defineTool, Type, type AgentRuntimeConfig, type ToolDefinition } from '@flue/runtime';
import { bindingByProject, parseAgentInstanceId, DEFAULT_MODEL, resolveModel } from '../../src/project/bindings';
import { resolveTarget, sendToConversationTarget } from '../../src/project/conversations';
import { withToolLogging, withReplyReminder } from '../../src/observability';
import { skillTools, loadSkillCatalog, loadActiveSkillBody, skillBody, type D1Like } from '../../src/skills';
import { reminderTools } from '../../src/reminders';
import { buildInstructions } from '../../src/prompt';
import { loadProjectMemory, memoryTools, renderMemory } from '../../src/memory';
import { userTools } from '../../src/users';
import { searchTools } from '../../src/search';
import { workbenchTools } from '../../src/workbench/tools';
import { logMessage } from '../../src/reflection';
import { buildConnectionRuntime } from '../../src/connections/runtime';

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

  const connectionRuntime = await buildConnectionRuntime({ db, binding, env, projectId });

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
      const target = await resolveTarget(db, binding, projectId, slug, conv);
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

  // Ephemeral progress note for slow, multi-step turns. Reuses the reply path's target resolution,
  // but NEVER logs to the transcript (it's chrome, not conversation) and NEVER throws — a failed
  // status must not derail the real answer. Model-driven; the prompt says when to call it.
  const updateStatus = defineTool({
    name: 'update_status',
    description:
      "Post a one-line progress note BEFORE slow, multi-step work (several searches/API calls before " +
      "you can answer) to show the person the SPECIFIC step you're on — a generic 'on it' is already posted " +
      "automatically, so name the actual action. Call it ONCE, up front, and only when you expect a wait — " +
      "skip it for quick answers and for heartbeat/scheduled runs. Lead with an emoji. This is NOT your " +
      "reply: always send the actual answer via reply_to_conversation.",
    parameters: Type.Object({
      text: Type.String({ description: "Short friendly note, e.g. '🔍 Checking the GitHub repo…'" }),
      conversationId: Type.Optional(
        Type.String({ description: 'Copy from the [Dispatch Input] block, same as your reply.' }),
      ),
    }),
    async execute({ text, conversationId }) {
      const target = await resolveTarget(db, binding, projectId, slug, conversationId ? String(conversationId) : '');
      if (!target) return 'no target — status skipped';
      try {
        await sendToConversationTarget(env, target, String(text));
        return 'posted';
      } catch (e) {
        return `status not posted: ${e instanceof Error ? e.message : 'error'}`;
      }
    },
  });

  // Bot token (for resolving Slack user names via users.info). Same ref the reply path uses.
  const botToken = env[binding.transportTokenRef] as string | undefined;

  const tools: ToolDefinition[] = [
    replyToConversation,
    updateStatus,
    ...(db ? skillTools(db, projectId) : []),
    ...reminderTools(ticker, heartbeatToken, projectId),
    ...(db ? memoryTools(db, projectId) : []),
    ...userTools(db, botToken),
    ...(db ? searchTools(db, projectId) : []),
    ...(db ? workbenchTools(db, projectId) : []),
    ...connectionRuntime.tools,
  ];

  return {
    model: resolveModel(binding.model),
    instructions: buildInstructions({
      projectName: binding.projectId,
      personality: personality ? skillBody(personality) : null,
      catalog,
      memoryBlock,
      connectionsBlock: connectionRuntime.connectionsBlock,
    }),
    // withReplyReminder is OUTER (logs capture the original result; the model gets result+reminder).
    tools: tools.map(withToolLogging).map(withReplyReminder),
  };
});
