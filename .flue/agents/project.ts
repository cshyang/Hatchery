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
      text: Type.String({ description: 'The message to post to the user.' }),
    }),
    async execute({ text }) {
      if (!botToken) throw new Error(`Missing Slack bot token env "${binding.botTokenRef}".`);
      await postMessage(botToken, binding.externalChannelId, String(text));
      return 'sent';
    },
  });

  return {
    model: 'zai/glm-5.1',
    instructions:
      `You are the project assistant for the "${binding.projectId}" project. ` +
      `Each user turn arrives as a "[Dispatch Input]" block; the user's actual message is the ` +
      `"message" field of the JSON under "input:" at the bottom of that block. Read that message ` +
      `and respond helpfully and concisely. ` +
      `Your plain text is NOT delivered to the user — reply_in_channel is the ONLY way your words ` +
      `reach them, so always call it with your final response. ` +
      `Do not mention the tool or the dispatch envelope in your reply.`,
    tools: [replyInChannel],
  };
});
