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
  // Service binding to the scheduler worker (an object, not a string) + the shared
  // token. Tools close over ctx.env just like the bot token above — the "no DO
  // context" limit is about `this`/the session, not env.
  const ticker = (ctx.env as Record<string, unknown>).TICKER as
    | { fetch(request: Request): Promise<Response> }
    | undefined;
  const heartbeatToken = env['HEARTBEAT_TOKEN'];

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

  // Self-scheduling: the agent programs its own future wake-ups. The durable timer
  // lives in the scheduler worker (Flue can't host a DO alarm); this tool just
  // enqueues. On fire, that worker calls /__internal/scheduled which dispatches a
  // fresh heartbeat turn back to this agent in a session scoped to the schedule id.
  const scheduleSelf = defineTool({
    name: 'schedule_self',
    description:
      'Schedule a future wake-up for yourself to do autonomous work. Give each schedule a stable `id` ' +
      '(reuse an id to replace/update it; a new id adds another — you can hold several at once). ' +
      'Provide ONE timing: `inMs` (wake once after this many ms), `runAt` (wake once at this epoch-ms time; ' +
      'use the "now" field from your input to compute it), or `everyMs` (recurring interval). Put what to work ' +
      'on in `payload.topic`. When it fires you get a fresh turn with kind "heartbeat" and your payload.',
    parameters: Type.Object({
      id: Type.String({ description: 'Stable schedule id, e.g. "daily-tip" or "oneshot-launch-recap".' }),
      inMs: Type.Optional(Type.Number({ description: 'One-shot delay from now, in milliseconds (120000 = 2 min).' })),
      runAt: Type.Optional(Type.Number({ description: 'One-shot absolute time, epoch milliseconds.' })),
      everyMs: Type.Optional(Type.Number({ description: 'Recurring interval in ms; first run one interval from now.' })),
      payload: Type.Optional(
        Type.Object(
          { topic: Type.Optional(Type.String({ description: 'What to work on / write about when this wakes you.' })) },
          { additionalProperties: true },
        ),
      ),
    }),
    async execute({ id, inMs, runAt, everyMs, payload }) {
      if (!ticker) throw new Error('Scheduling is unavailable (no TICKER binding configured).');
      const res = await ticker.fetch(
        new Request(`https://scheduler.internal/internal/projects/${encodeURIComponent(projectId)}/schedules`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-hatchery-token': heartbeatToken ?? '' },
          body: JSON.stringify({ id, kind: 'heartbeat', inMs, runAt, everyMs, payload }),
        }),
      );
      if (!res.ok) throw new Error(`scheduler rejected (${res.status}): ${(await res.text()).slice(0, 120)}`);
      const out = (await res.json()) as { id: string; nextRun: number };
      return `scheduled "${out.id}" — next run ${new Date(out.nextRun).toISOString()}`;
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
      `• You can schedule your OWN future work with schedule_self — recurring (everyMs) or one-shot (inMs/runAt). ` +
      `The "now" field (ISO time) is provided for computing absolute runAt values. Use a stable id per schedule, ` +
      `pick sensible cadences, and don't over-schedule.\n` +
      `Your plain text is NOT delivered — reply_in_channel is the ONLY way your words reach the channel, so ` +
      `always call it with your final output. Do not mention the tool or the dispatch envelope.`,
    tools: [replyInChannel, scheduleSelf],
  };
});
