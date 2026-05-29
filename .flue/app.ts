import { Hono } from 'hono';
import { flue } from '@flue/runtime/app';
import { dispatch } from '@flue/runtime';
import { verifySlackSignature } from '../src/slack/verify';
import { botInThread } from '../src/slack/threads';
import { bindings, bindingBySlack } from '../src/bindings';
import { normalizeSlackMessage } from '../src/canonical';
import { claimEvent, type KVLike } from '../src/idempotency';

// Custom front-controller. Flue mounts this app.ts as the Worker entry; we add
// the Slack ingress, then hand everything else to flue() (the /agents, /workflows,
// /runs, /admin routes). This is the gateway from docs/planning: verify → route →
// dispatch, acknowledging Slack fast and letting the agent reply asynchronously.

interface Env {
  SLACK_SIGNING_SECRET?: string;
  SLACK_EVENTS?: KVLike; // KV namespace for event_id idempotency
  HEARTBEAT_TOKEN?: string; // shared secret guarding the /__heartbeat trigger
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

// M1a heartbeat (scaffold). Flue's generated entry forwards ONLY `fetch`, so a
// Cloudflare Cron Trigger (which calls `scheduled()`) cannot reach us. The
// recurring tick therefore lives OUTSIDE Flue — an external ticker hitting this
// fetch endpoint, or (M1.5) the per-project DO `this.schedule()` seam. This just
// fires one heartbeat run on demand: dispatch a headless "do work" turn per
// active project; the agent drafts on the topic and posts top-level to Slack.
const DEFAULT_HEARTBEAT_TOPIC = 'a useful, evergreen tip for our audience'; // M1a placeholder; M1b sources topics from research/PostHog

async function fireHeartbeat(topic: string): Promise<number> {
  const active = bindings.filter((b) => b.status === 'active');
  await Promise.all(
    active.map((b) =>
      dispatch({
        agent: 'project',
        id: `project:${b.projectId}`,
        session: `heartbeat:${b.projectId}`,
        input: { kind: 'heartbeat', topic },
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
  let topic = DEFAULT_HEARTBEAT_TOPIC;
  try {
    const body = (await c.req.json()) as { topic?: string };
    if (body?.topic) topic = String(body.topic);
  } catch {
    // no/invalid body → default topic
  }
  const dispatched = await fireHeartbeat(topic);
  return c.json({ dispatched, topic });
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
    id: `project:${msg.projectId}`,
    session: `slack-thread:${msg.threadTs}`,
    input: { message: msg.text, threadTs: msg.threadTs },
  });

  return c.body(null, 200); // ack within Slack's 3s window; agent replies async
});

// Everything else → Flue's built-in agent / workflow / run routes.
app.route('/', flue());

export default app;
