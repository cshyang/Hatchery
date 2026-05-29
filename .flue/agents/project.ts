import { createAgent, defineTool, Type, type AgentRuntimeConfig, type ToolDefinition } from '@flue/runtime';
import { bindingByProject } from '../../src/bindings';
import { postMessage } from '../../src/slack/post';
import { skillTools, loadSkillCatalog, type D1Like } from '../../src/skills';
import { reminderTools } from '../../src/reminders';

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

// L1 progressive disclosure: just names + descriptions in the prompt. Bodies load on
// demand (load_skill tool, or injected fresh at fire time) — never dumped here.
function skillCatalogBlock(skills: { name: string; description: string }[]): string {
  if (!skills.length) {
    return 'You have no saved skills yet. When a repeatable procedure emerges, capture it with save_skill.';
  }
  return (
    'Your saved skills (call load_skill to open one):\n' +
    skills.map((s) => `  - ${s.name}: ${s.description}`).join('\n')
  );
}

export default createAgent(async (ctx): Promise<AgentRuntimeConfig> => {
  const projectId = projectIdFromInstance(ctx.id);
  const binding = bindingByProject(projectId);

  // No active binding → an inert agent with no posting capability.
  if (!binding) {
    return {
      model: 'zai/glm-5.1',
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
    model: 'zai/glm-5.1',
    instructions:
      `You are the content agent for the "${binding.projectId}" project. ` +
      `Each turn arrives as a "[Dispatch Input]" block — read the JSON under "input:" and act on it:\n` +
      `• "message" field → a user's Slack message. Respond helpfully and concisely; pass its "threadTs" to ` +
      `reply_in_channel so your reply lands in their thread.\n` +
      `• "kind":"heartbeat" → a scheduled run, no user. If it has an "instructions" field, that is one of your ` +
      `saved skills — follow it as the procedure for this run. Otherwise write a concise, engaging blog-style draft ` +
      `on the "topic" field. Post the result with reply_in_channel and OMIT threadTs (a new top-level post). ` +
      `If there is genuinely nothing worth posting, simply don't call reply_in_channel.\n` +
      `\nYOUR SKILLS & SCHEDULE:\n` +
      `${skillCatalogBlock(skills)}\n` +
      `• Capture reusable procedures as skills with save_skill (SKILL.md text: a --- name/description --- block, ` +
      `then steps); open one with load_skill; remove with delete_skill.\n` +
      `• Schedule your own work with set_reminder — cron in KL time (e.g. "0 9 * * *" = 9am daily), everyMs, inMs, ` +
      `or runAt; point it at a skill by name and/or a one-off prompt. Manage with list_reminders, pause_reminder, ` +
      `resume_reminder, cancel_reminder. Use the "now" field for absolute times. Pick sensible cadences; don't over-schedule.\n` +
      `\nYour plain text is NOT delivered — reply_in_channel is the ONLY way your words reach the channel. ` +
      `Do not mention tools or the dispatch envelope.`,
    tools,
  };
});
