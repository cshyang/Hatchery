import { Hono } from 'hono';
import { flue } from '@flue/runtime/app';
import { dispatch } from '@flue/runtime';
import { verifySlackSignature } from '../src/slack/verify';
import { bindingBySlack } from '../src/bindings';
import { normalizeSlackMessage } from '../src/canonical';

// Custom front-controller. Flue mounts this app.ts as the Worker entry; we add
// the Slack ingress, then hand everything else to flue() (the /agents, /workflows,
// /runs, /admin routes). This is the gateway from docs/planning: verify → route →
// dispatch, acknowledging Slack fast and letting the agent reply asynchronously.

interface Env {
  SLACK_SIGNING_SECRET?: string;
  [binding: string]: unknown;
}

const app = new Hono<{ Bindings: Env }>();

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
  if (!ev || ev.type !== 'message' || ev.bot_id || ev.subtype || !ev.channel || !ev.ts) {
    return c.body(null, 200);
  }

  const binding = bindingBySlack(body.team_id ?? '', ev.channel);
  if (!binding) return c.body(null, 200); // unbound channel: acknowledge, never dispatch

  // TODO(idempotency): dedup body.event_id via KV/DO before dispatch (see
  // docs/decisions/0001 — the doorbell tax). Fast ACK makes Slack's retries
  // rare, but at-most-once delivery means this is the first slice's known gap.
  const msg = normalizeSlackMessage(
    body.event_id ?? `${ev.channel}:${ev.ts}`,
    body.team_id ?? '',
    { channel: ev.channel, ts: ev.ts, thread_ts: ev.thread_ts, user: ev.user, text: ev.text },
    binding,
  );

  await dispatch({
    agent: 'project',
    id: `project:${msg.projectId}`,
    session: `slack-thread:${msg.threadTs}`,
    input: { message: msg.text },
  });

  return c.body(null, 200); // ack within Slack's 3s window; agent replies async
});

// Everything else → Flue's built-in agent / workflow / run routes.
app.route('/', flue());

export default app;
