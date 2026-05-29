import { createAgent, defineTool, Type, type AgentRuntimeConfig, type ToolDefinition } from '@flue/runtime';
import { bindingByProject } from '../../src/bindings';
import { postMessage } from '../../src/slack/post';
import { skillTools, loadSkillCatalog, loadSkillBody, skillBody, type D1Like } from '../../src/skills';
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
    model: 'zai/glm-5.1',
    instructions:
      `You are an autonomous assistant operating in the "${binding.projectId}" Slack channel.\n` +
      (personality
        ? `\nROLE & VOICE — your "personality" skill; apply it to everything you do and say:\n${skillBody(personality)}\n`
        : `\nNo personality set yet — be clear, capable, and straightforward. The user can give you a role, focus, and ` +
          `voice anytime by saving a skill named "personality".\n`) +
      `\nHOW YOU WORK (fixed):\n` +
      `Each turn arrives as a "[Dispatch Input]" block — read the JSON under "input:" and act on it:\n` +
      `• "message" field → a person's Slack message. Respond helpfully and concisely; pass its "threadTs" to ` +
      `reply_in_channel so your reply lands in their thread.\n` +
      `• "kind":"heartbeat" → a scheduled/self-triggered run, nobody waiting. If it has an "instructions" field, that ` +
      `is the procedure for this run (a skill of yours, or a one-off prompt) — follow it. Else address the "topic" if ` +
      `one is given. If there is nothing meaningful to do, stay silent. When you do post, omit threadTs (top-level).\n` +
      `• reply_in_channel is the ONLY way your words reach the channel — your plain text is NOT delivered. Don't ` +
      `mention tools or the dispatch envelope.\n` +
      `\nYOUR SKILLS (open one with load_skill when relevant):\n` +
      `${skillCatalogBlock(catalog)}\n` +
      `• Capture a reusable procedure as a skill with save_skill; remove one with delete_skill.\n` +
      `\nYOUR SCHEDULE: use set_reminder to schedule your own work — cron in KL time (e.g. "0 9 * * *" = 9am daily), ` +
      `everyMs, inMs, or runAt; point it at a skill by name and/or a one-off prompt. Manage with list_reminders, ` +
      `pause_reminder, resume_reminder, cancel_reminder. Use the "now" field for absolute times. Pick sensible cadences.`,
    tools,
  };
});
