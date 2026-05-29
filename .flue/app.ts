import { Hono } from 'hono';
import { flue } from '@flue/runtime/app';
import { dispatch } from '@flue/runtime';
import { verifySlackSignature } from '../src/slack/verify';
import { botInThread } from '../src/slack/threads';
import { bindings, bindingBySlack, bindingByProject, agentInstanceId } from '../src/bindings';
import { normalizeSlackMessage } from '../src/canonical';
import { claimEvent, type KVLike } from '../src/idempotency';
import { loadSkillBody, type D1Like } from '../src/skills';

// Custom front-controller. Flue mounts this app.ts as the Worker entry; we add
// the Slack ingress, then hand everything else to flue() (the /agents, /workflows,
// /runs, /admin routes). This is the gateway from docs/planning: verify → route →
// dispatch, acknowledging Slack fast and letting the agent reply asynchronously.

interface Env {
  SLACK_SIGNING_SECRET?: string;
  SLACK_EVENTS?: KVLike; // KV namespace for event_id idempotency
  HEARTBEAT_TOKEN?: string; // shared secret guarding the /__heartbeat trigger
  DB?: D1Like; // D1 skill catalog (loaded fresh at fire time)
  [binding: string]: unknown;
}

// Slack renders an @mention as "<@U0B6UB2E5HT>" (or "<@U…|label>"). We engage
// only when the bot is mentioned, then strip the mention so the model sees a
// clean message.
function mentionsBot(text: string, botUserId: string): boolean {
  return text.includes(`<@${botUserId}`);
}
function stripMention(text: string, botUserId: string): string {
  return text
    .replace(new RegExp(`<@${botUserId}(\\|[^>]*)?>`, 'g'), '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Liveness backstop. The 6h cron poke (and any manual /__heartbeat) wakes each active
// project with NO specific work — the agent stays silent unless it has a self-scheduled
// reminder due. A caller MAY pass {topic} to give the wake something to act on. Per-job
// scheduled work arrives via /__internal/scheduled instead, carrying its skill/prompt.
// (Flue's generated entry forwards only `fetch`, so this lives outside Flue — see ticker/.)
async function fireHeartbeat(topic?: string): Promise<number> {
  const active = bindings.filter((b) => b.status === 'active');
  const now = new Date().toISOString();
  await Promise.all(
    active.map((b) =>
      dispatch({
        agent: 'project',
        id: agentInstanceId(b.projectId),
        session: `heartbeat:${b.projectId}`,
        input: { kind: 'heartbeat', now, ...(topic ? { topic } : {}) },
      }),
    ),
  );
  return active.length;
}

const app = new Hono<{ Bindings: Env }>();

// Manual heartbeat trigger. Token-guarded (inert unless HEARTBEAT_TOKEN is set
// and the x-hatchery-token header matches) so it can't be fired publicly. An
// optional {topic} in the body overrides the default.
app.post('/__heartbeat', async (c) => {
  const expected = c.env.HEARTBEAT_TOKEN;
  if (!expected || c.req.header('x-hatchery-token') !== expected) return c.body(null, 404);
  let topic: string | undefined;
  try {
    const body = (await c.req.json()) as { topic?: string };
    if (body?.topic) topic = String(body.topic);
  } catch {
    // no/invalid body → bare liveness wake (agent stays silent unless it has scheduled work)
  }
  const dispatched = await fireHeartbeat(topic);
  return c.json({ dispatched, topic: topic ?? null });
});

// Per-job fire from the SchedulerDO (the agent's self-scheduled work). Unlike
// /__heartbeat (which fans out to every active project), this targets ONE project,
// in a session dedicated to the job id so each named schedule keeps its own memory.
// `fireId` makes it idempotent against alarm retries via the same KV claim layer.
app.post('/__internal/scheduled', async (c) => {
  const expected = c.env.HEARTBEAT_TOKEN;
  if (!expected || c.req.header('x-hatchery-token') !== expected) return c.body(null, 404);

  const body = (await c.req.json().catch(() => null)) as {
    fireId?: string;
    projectId?: string;
    jobId?: string;
    kind?: string;
    payload?: Record<string, unknown>;
  } | null;
  if (!body?.fireId || !body.projectId || !body.jobId) return c.json({ error: 'bad request' }, 400);

  if (!(await claimEvent(c.env.SLACK_EVENTS, `sched:${body.fireId}`))) {
    return c.json({ deduped: true }); // alarm retry / double-fire — already dispatched
  }

  const binding = bindingByProject(body.projectId);
  if (!binding || binding.status !== 'active') return c.json({ skipped: 'no active binding' });

  // Reference, not copy: a reminder holds a skill NAME; load the body FRESH here so
  // edits to the skill apply to all future scheduled runs.
  const payload = (body.payload ?? {}) as { skill?: string; prompt?: string; topic?: string };
  const input: Record<string, unknown> = { kind: body.kind ?? 'heartbeat', now: new Date().toISOString() };
  // skill body + one-off prompt are both "the procedure for this run" (Hermes semantics):
  // follow them. `topic` is the legacy blog-on-a-subject path (the default 6h backstop).
  let procedure = '';
  if (payload.skill) {
    const skillBody = c.env.DB ? await loadSkillBody(c.env.DB, body.projectId, payload.skill) : null;
    if (skillBody) {
      input.skill = payload.skill;
      procedure = skillBody;
    } else {
      console.log(`[scheduled] skill "${payload.skill}" not found for project ${body.projectId}`);
    }
  }
  if (payload.prompt) procedure = procedure ? `${procedure}\n\n${payload.prompt}` : String(payload.prompt);
  if (procedure) input.instructions = procedure;
  else if (payload.topic) input.topic = String(payload.topic);
  // Skill named-but-missing AND no prompt/topic → nothing to run; skip the empty turn.
  if (!input.instructions && !input.topic) {
    return c.json({ skipped: 'nothing to run (skill missing, no prompt/topic)' });
  }

  await dispatch({
    agent: 'project',
    id: agentInstanceId(body.projectId),
    session: `job:${body.projectId}:${body.jobId}`,
    input,
  });
  return c.json({ dispatched: true, jobId: body.jobId, skill: input.skill ?? null });
});

app.post('/slack/events', async (c) => {
  const raw = await c.req.text();

  const verified = await verifySlackSignature(
    c.env.SLACK_SIGNING_SECRET ?? '',
    raw,
    c.req.header('x-slack-request-timestamp'),
    c.req.header('x-slack-signature'),
  );
  if (!verified) return c.text('unauthorized', 401);

  const body = JSON.parse(raw) as {
    type?: string;
    challenge?: string;
    team_id?: string;
    event_id?: string;
    event?: {
      type?: string;
      subtype?: string;
      bot_id?: string;
      channel?: string;
      ts?: string;
      thread_ts?: string;
      user?: string;
      text?: string;
    };
  };

  // Slack endpoint handshake.
  if (body.type === 'url_verification') return c.json({ challenge: body.challenge });

  const ev = body.event;
  // Ignore non-user messages and the bot's own echoes — never dispatch them.
  // NOTE: dropping any `subtype` also drops `thread_broadcast` (a thread reply
  // the user chose to also send to the channel) — so that variant won't continue
  // a thread. Intentional for now; revisit if it bites.
  if (!ev || ev.type !== 'message' || ev.bot_id || ev.subtype || !ev.channel || !ev.ts) {
    return c.body(null, 200);
  }

  const binding = bindingBySlack(body.team_id ?? '', ev.channel);
  if (!binding) return c.body(null, 200); // unbound channel: acknowledge, never dispatch

  // Engage policy:
  //  - @mention anywhere                         -> engage
  //  - reply in a thread the bot already posted in -> continue (no re-mention)
  //  - everything else                            -> stay silent
  const text = ev.text ?? '';
  if (!mentionsBot(text, binding.botUserId)) {
    const threadTs = ev.thread_ts;
    const token = (c.env as Record<string, string | undefined>)[binding.botTokenRef];
    const continuing =
      !!threadTs && !!token && (await botInThread(token, ev.channel, threadTs, binding.botUserId));
    if (!continuing) return c.body(null, 200);
  }

  // Idempotency: Slack redelivers the same event_id on retry (at-least-once).
  // Claim it before dispatch so a retry can't fire a second reply. Only reached
  // for dispatch-bound events (mention/continue) — chatter we ignore costs no KV.
  const eventId = body.event_id ?? `${ev.channel}:${ev.ts}`;
  if (!(await claimEvent(c.env.SLACK_EVENTS, eventId))) {
    return c.body(null, 200); // duplicate delivery — already handled
  }

  const msg = normalizeSlackMessage(
    body.event_id ?? `${ev.channel}:${ev.ts}`,
    body.team_id ?? '',
    { channel: ev.channel, ts: ev.ts, thread_ts: ev.thread_ts, user: ev.user, text: stripMention(text, binding.botUserId) },
    binding,
  );

  await dispatch({
    agent: 'project',
    id: agentInstanceId(msg.projectId),
    session: `slack-thread:${msg.threadTs}`,
    // Forward the author identity so the agent can scope `user` memory to the person talking.
    // senderId is fully qualified into a subject (`slack:<team>:<user>`) in the agent.
    input: {
      message: msg.text,
      threadTs: msg.threadTs,
      provider: msg.provider,
      teamId: msg.externalTeamId,
      senderId: msg.senderId,
    },
  });

  return c.body(null, 200); // ack within Slack's 3s window; agent replies async
});

// Everything else → Flue's built-in agent / workflow / run routes.
app.route('/', flue());

export default app;
