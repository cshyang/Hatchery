import { createAgent, defineTool, Type, type AgentRuntimeConfig, type ToolDefinition } from '@flue/runtime';
import { bindingByProject, DEFAULT_MODEL } from '../../src/bindings';
import { postMessage } from '../../src/slack/post';
import { skillTools, loadSkillCatalog, loadSkillBody, skillBody, type D1Like } from '../../src/skills';
import { reminderTools } from '../../src/reminders';
import { buildInstructions } from '../../src/prompt';

// The project agent. Addressed at /agents/project/<id> where id = "project:<projectId>".
// Each instance is a persistent Durable Object — the per-project (per-tenant) boundary.
//
// Access is enforced by TOOLS, not the prompt: reply is bound to the project's channel +
// bot token from trusted config; skills/reminders are scoped to this projectId. The model
// controls only the content, never the destination or another project's data.
//
// NOTE: the work below runs in Flue's `createAgent` INITIALIZER (which may be async), NOT
// the Durable Object constructor. The DO constructor stays boring — no D1/network there.

function projectIdFromInstance(id: string): string {
  return id.startsWith('project:') ? id.slice('project:'.length) : id;
}

export default createAgent(async (ctx): Promise<AgentRuntimeConfig> => {
  const projectId = projectIdFromInstance(ctx.id);
  const binding = bindingByProject(projectId);

  // No active binding → an inert agent with no posting capability.
  if (!binding) {
    return {
      model: DEFAULT_MODEL,
      instructions: `No active binding for project "${projectId}". Do not attempt to post anywhere.`,
    };
  }

  const env = ctx.env as Record<string, unknown>;
  const botToken = env[binding.botTokenRef] as string | undefined;
  const ticker = env.TICKER as { fetch(request: Request): Promise<Response> } | undefined;
  const heartbeatToken = (env.HEARTBEAT_TOKEN as string | undefined) ?? '';
  const db = env.DB as D1Like | undefined;

  // L1 catalog query — cheap, every turn. .catch keeps a D1 hiccup from breaking the agent.
  const skills = db ? await loadSkillCatalog(db, projectId).catch(() => []) : [];
  // Personality (overwritable): a skill named `personality` defines the agent's role/voice and is
  // applied to EVERY turn. Absent → a general default. This is the only purpose-layer; everything
  // else below is fixed FUNCTION. Loaded eagerly (not on demand) so it colors all output.
  const personality =
    db && skills.some((s) => s.name === 'personality')
      ? await loadSkillBody(db, projectId, 'personality').catch(() => null)
      : null;
  const catalog = skills.filter((s) => s.name !== 'personality'); // applied above, not load-on-demand

  const replyInChannel = defineTool({
    name: 'reply_in_channel',
    description: "Send your reply to the user in the project's Slack channel. Call this with your final response text.",
    parameters: Type.Object({
      text: Type.String({ description: 'The message to post.' }),
      threadTs: Type.Optional(
        Type.String({
          description:
            "When replying to a user message, copy the threadTs from the [Dispatch Input] block so your reply lands in their thread. OMIT for a heartbeat/new top-level post.",
        }),
      ),
    }),
    async execute({ text, threadTs }) {
      if (!botToken) throw new Error(`Missing Slack bot token env "${binding.botTokenRef}".`);
      const thread = threadTs ? String(threadTs) : undefined;
      await postMessage(botToken, binding.externalChannelId, String(text), thread);
      return 'sent';
    },
  });

  const tools: ToolDefinition[] = [
    replyInChannel,
    ...(db ? skillTools(db, projectId) : []),
    ...reminderTools(ticker, heartbeatToken, projectId),
  ];

  return {
    model: binding.model ?? DEFAULT_MODEL,
    instructions: buildInstructions({
      projectName: binding.projectId,
      personality: personality ? skillBody(personality) : null,
      catalog,
    }),
    tools,
  };
});
