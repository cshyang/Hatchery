import { createAgent, defineTool, Type, type AgentRuntimeConfig } from '@flue/runtime';
import { bindingByProject } from '../../src/bindings';
import { postMessage } from '../../src/slack/post';

// The project agent. Addressed at /agents/project/<id> where id = "project:<projectId>".
// Each instance is a persistent Durable Object — the per-project (per-tenant)
// boundary. Its SQLite holds session history per Slack thread.
//
// Access is enforced by the TOOL, not the prompt: the reply tool is bound to the
// project's channel + bot token (from trusted config) at construction. The model
// controls only the reply `text` — it has no parameter to name another channel.

function projectIdFromInstance(id: string): string {
  return id.startsWith('project:') ? id.slice('project:'.length) : id;
}

export default createAgent((ctx): AgentRuntimeConfig => {
  const projectId = projectIdFromInstance(ctx.id);
  const binding = bindingByProject(projectId);

  // No active binding → an inert agent with no posting capability.
  if (!binding) {
    return {
      model: 'zai/glm-5.1',
      instructions: `No active binding for project "${projectId}". Do not attempt to post anywhere.`,
    };
  }

  const env = ctx.env as Record<string, string | undefined>;
  const botToken = env[binding.botTokenRef];

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
      // threadTs should always be supplied (required param), but if the model omits
      // it we post top-level rather than throw — a degraded reply beats a retry storm.
      const thread = threadTs ? String(threadTs) : undefined;
      await postMessage(botToken, binding.externalChannelId, String(text), thread);
      return 'sent';
    },
  });

  return {
    model: 'zai/glm-5.1',
    instructions:
      `You are the content agent for the "${binding.projectId}" project. ` +
      `Each turn arrives as a "[Dispatch Input]" block — read the JSON under "input:" at the bottom and act on it:\n` +
      `• If it has a "message" field, that is a user's Slack message. Respond helpfully and concisely, and when ` +
      `you call reply_in_channel pass the "threadTs" value from that JSON so your reply lands in the user's thread.\n` +
      `• If it has "kind":"heartbeat", there is NO user — this is a scheduled run. Write a concise, engaging ` +
      `blog-style draft (a short title plus a few tight paragraphs) on the "topic" field, then post it with ` +
      `reply_in_channel and OMIT threadTs (it is a new top-level post for the team to review).\n` +
      `Your plain text is NOT delivered — reply_in_channel is the ONLY way your words reach the channel, so ` +
      `always call it with your final output. Do not mention the tool or the dispatch envelope.`,
    tools: [replyInChannel],
  };
});
