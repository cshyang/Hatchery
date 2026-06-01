import { Hono } from 'hono';
import { flue } from '@flue/runtime/app';
import { dispatch } from '@flue/runtime';
import { verifySlackSignature } from '../src/slack/verify';
import { botInThread } from '../src/slack/threads';
import { mentionsBot, stripMention } from '../src/slack/mentions';
import { bindings, bindingBySlack, bindingByProject, agentInstanceId, autoCreateBinding, isKnownTeam } from '../src/bindings';
import { normalizeSlackMessage } from '../src/canonical';
import { upsertConversationTarget, topLevelTargetFromBinding, sendToConversationTarget } from '../src/conversations';
import { claimEvent, type KVLike } from '../src/idempotency';
import { loadRunnableSkillBody, type D1Like } from '../src/skills';
import { logMessage, projectsWithUnreflected, takeUnreflectedBatch, buildReflectInstructions } from '../src/reflection';
import { upsertConnection, loadConnections, PROVIDER_CATALOG, connectedNotice } from '../src/connections';
import { verifyNangoWebhook, parseNangoAuthWebhook } from '../src/nango';

// Custom front-controller. Flue mounts this app.ts as the Worker entry; we add
// the Slack ingress, then hand everything else to flue() (the /agents, /workflows,
// /runs, /admin routes). This is the gateway from docs/planning: verify → route →
// dispatch, acknowledging Slack fast and letting the agent reply asynchronously.

interface Env {
  SLACK_SIGNING_SECRET?: string;
  SLACK_EVENTS?: KVLike; // KV namespace for event_id idempotency
  HEARTBEAT_TOKEN?: string; // shared secret guarding the /__heartbeat trigger
  ADMIN_CONNECTIONS_TOKEN?: string; // OWN secret guarding /__admin/connections (ADR D11 — NOT the heartbeat token)
  NANGO_SECRET_KEY?: string; // platform Bearer for the Nango API (create session / fetch token)
  NANGO_WEBHOOK_SECRET?: string; // HMAC signing key to verify inbound Nango auth webhooks
  DB?: D1Like; // D1 skill catalog, transcript, memory, and conversation targets
  [binding: string]: unknown;
}

// Workspace-level transport identity for gateway auto-provisioning (same-workspace Milestone 1:
// one bot install, reused across all channels of the known team). These mirror the demo seed row.
const BOT_ID_FOR_AUTOCREATE = 'U0B6UB2E5HT';
const DEFAULT_TRANSPORT_TOKEN_REF = 'SLACK_BOT_TOKEN_DEFAULT';

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

  const binding = await bindingByProject(body.projectId, c.env.DB);
  if (!binding || binding.status !== 'active') return c.json({ skipped: 'no active binding' });

  // Reference, not copy: a reminder holds a skill NAME; resolve it FRESH here so edits to the
  // skill apply to all future scheduled runs. An archived skill is REFUSED (not run, not silently
  // dropped): archived = retired from automation, so running its stale steps on a schedule would be
  // a footgun. The agent can restore_skill or repoint/cancel the reminder.
  const payload = (body.payload ?? {}) as { skill?: string; prompt?: string; topic?: string };
  const input: Record<string, unknown> = { kind: body.kind ?? 'heartbeat', now: new Date().toISOString() };
  // skill body + one-off prompt are both "the procedure for this run": follow them. `topic` is the
  // legacy blog-on-a-subject path (the default 6h backstop).
  let procedure = '';
  if (payload.skill) {
    const resolved = c.env.DB
      ? await loadRunnableSkillBody(c.env.DB, body.projectId, payload.skill)
      : ({ status: 'absent' } as const);
    if (resolved.status === 'active') {
      input.skill = payload.skill;
      procedure = resolved.body;
    } else if (resolved.status === 'archived') {
      console.log(
        `[scheduled] skill "${payload.skill}" is archived for project ${body.projectId} — refusing stale automation; restore it or repoint the reminder`,
      );
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

// Nightly REM: the ticker's nightly cron pokes this. The GATE is cheap SQL (projects with
// messages past their watermark) — idle projects never dispatch a token-costing turn. For each
// qualifying project we take its batch (advancing the watermark server-side) and hand the
// transcript INLINE to a fresh consolidation session, so the live agent can't consume the
// watermark and reflection turns never pollute a real conversation thread.
app.post('/__internal/reflect-sweep', async (c) => {
  const expected = c.env.HEARTBEAT_TOKEN;
  if (!expected || c.req.header('x-hatchery-token') !== expected) return c.body(null, 404);
  const db = c.env.DB;
  if (!db) return c.json({ swept: 0, reason: 'no DB binding' });

  const projects = await projectsWithUnreflected(db);
  const now = new Date().toISOString();
  let swept = 0;
  for (const projectId of projects) {
    const transcript = await takeUnreflectedBatch(db, projectId);
    if (!transcript) continue; // raced to empty; skip
    await dispatch({
      agent: 'project',
      id: agentInstanceId(projectId),
      session: `reflect:${projectId}:${Date.now()}`, // fresh session — no carryover, no thread pollution
      input: { kind: 'heartbeat', now, instructions: buildReflectInstructions(transcript) },
    });
    swept++;
  }
  return c.json({ swept });
});

// Operator connection provisioning (ADR 0003 / D11). Lets the operator add or change a connection's
// METADATA without a code edit + redeploy. Guarded by its OWN token (NOT HEARTBEAT_TOKEN — provisioning
// connections and poking heartbeats are different privilege levels). The SECRET is set separately via
// `wrangler secret put` and is only referenced here by name — this route never receives or stores it.
// HARD LINE: this is OPERATOR-only and out-of-band; the agent (model) can never reach it.
async function requireAdmin(c: { env: Env; req: { header(n: string): string | undefined } }): Promise<boolean> {
  const expected = c.env.ADMIN_CONNECTIONS_TOKEN;
  return !!expected && c.req.header('x-hatchery-admin-token') === expected;
}

app.post('/__admin/connections', async (c) => {
  if (!(await requireAdmin(c))) return c.body(null, 404); // inert/invisible unless the admin token matches
  const db = c.env.DB;
  if (!db) return c.json({ error: 'no DB binding' }, 500);
  const body = (await c.req.json().catch(() => null)) as {
    projectId?: string;
    provider?: string;
    tokenRef?: string;
    connectionRef?: string;
    config?: Record<string, unknown>;
    status?: 'active' | 'disabled';
  } | null;
  if (!body?.projectId || !body.provider) return c.json({ error: 'projectId and provider are required' }, 400);
  if (!body.tokenRef && !body.connectionRef && body.status !== 'disabled') {
    return c.json({ error: 'tokenRef or connectionRef is required (omit only when disabling)' }, 400);
  }
  await upsertConnection(db, {
    projectId: body.projectId,
    provider: body.provider,
    tokenRef: body.tokenRef,
    connectionRef: body.connectionRef,
    config: body.config,
    status: body.status,
    createdBy: 'admin-route',
  });
  return c.json({ ok: true, projectId: body.projectId, provider: body.provider, status: body.status ?? 'active' });
});

app.get('/__admin/connections', async (c) => {
  if (!(await requireAdmin(c))) return c.body(null, 404);
  const db = c.env.DB;
  if (!db) return c.json({ error: 'no DB binding' }, 500);
  const projectId = c.req.query('projectId');
  if (!projectId) return c.json({ error: 'projectId query param required' }, 400);
  const connections = await loadConnections(db, projectId); // metadata only — no secret is ever stored or returned
  return c.json({ projectId, connections });
});

// Nango auth webhook (Component 3). Nango POSTs here when a Connect flow completes. HMAC-verified
// against the RAW body with NANGO_WEBHOOK_SECRET (a DEDICATED webhook secret, NOT the API key).
// Inert (404) until that secret is set. On a verified auth/creation/success event we store the
// connection_ref under the channel project (tags.end_user_id) — the row makes that provider's tools
// appear next turn. HARD LINE: this writes only a non-secret connection_ref; no token touches D1.
app.post('/nango/webhook', async (c) => {
  const signingKey = c.env.NANGO_WEBHOOK_SECRET;
  if (!signingKey) return c.body(null, 404); // inert/invisible until configured

  const raw = await c.req.text();
  const ok = await verifyNangoWebhook(signingKey, raw, c.req.header('x-nango-hmac-sha256'));
  if (!ok) return c.text('unauthorized', 401);

  const event = parseNangoAuthWebhook(raw);
  if (!event) {
    // non-auth, non-creation, or success:false (failed/abandoned consent) — acknowledge, write nothing.
    console.log('[nango] webhook ignored (not an auth-creation-success event)');
    return c.json({ ignored: true });
  }

  const db = c.env.DB;
  if (!db) return c.json({ error: 'no DB binding' }, 500);

  // Convention guard: the Nango integration id MUST equal a catalog provider slug, else the row would
  // be connected-but-toolless (no API profile / typed tools). Log loudly and skip rather than store a
  // dead row. (See the runbook: operators name the Nango integration exactly the catalog slug.)
  if (!PROVIDER_CATALOG.some((p) => p.provider === event.provider)) {
    console.log(`[nango] webhook for unknown provider "${event.provider}" (cfg "${event.providerConfigKey}") — skipping upsert; name the Nango integration to match a catalog slug`);
    return c.json({ ignored: 'unknown provider' });
  }

  await upsertConnection(db, {
    projectId: event.projectId,
    provider: event.provider,
    connectionRef: event.connectionId,
    createdBy: 'nango-webhook',
  });
  console.log(`[nango] connected provider "${event.provider}" for project ${event.projectId} (connection ${event.connectionId})`);

  // Tell the channel it worked. The webhook has no conversation thread, so the GATEWAY posts a
  // deterministic confirmation to the channel root (project_id IS the channel id) — NOT an agent
  // turn (a model might skip the reply; this must not). Best-effort: a Slack hiccup must never fail
  // the connection write that already succeeded. The bot token comes from the project's binding.
  const binding = await bindingByProject(event.projectId, db).catch(() => undefined);
  if (binding) {
    const target = topLevelTargetFromBinding(binding);
    await sendToConversationTarget(c.env as Record<string, unknown>, target, connectedNotice(event.provider)).catch((e) =>
      console.log(`[nango] connected, but the channel notice failed to post: ${e instanceof Error ? e.message : 'error'}`),
    );
  }
  return c.json({ ok: true, projectId: event.projectId, provider: event.provider });
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

  const teamId = body.team_id ?? '';
  let binding = await bindingBySlack(teamId, ev.channel, c.env.DB);
  if (!binding) {
    // No binding yet. If this is a channel of a KNOWN team and the bot is being addressed, the
    // gateway provisions a per-channel project (HARD LINE: gateway-created on a verified Slack
    // signature for an allowlisted team — NOT the agent). Otherwise acknowledge and stay silent.
    const addressed = mentionsBot(ev.text ?? '', BOT_ID_FOR_AUTOCREATE);
    if (c.env.DB && isKnownTeam(teamId) && addressed) {
      await autoCreateBinding(c.env.DB, {
        teamId,
        channelId: ev.channel,
        transportBotId: BOT_ID_FOR_AUTOCREATE,
        transportTokenRef: DEFAULT_TRANSPORT_TOKEN_REF,
      });
      binding = await bindingBySlack(teamId, ev.channel, c.env.DB);
    }
    if (!binding) return c.body(null, 200); // unknown team, not addressed, or create failed → silent
  }

  // Engage policy:
  //  - @mention anywhere                         -> engage
  //  - reply in a thread the bot already posted in -> continue (no re-mention)
  //  - everything else                            -> stay silent
  const text = ev.text ?? '';
  if (!mentionsBot(text, binding.transportBotId)) {
    const threadTs = ev.thread_ts;
    const token = (c.env as Record<string, string | undefined>)[binding.transportTokenRef];
    const continuing =
      !!threadTs && !!token && (await botInThread(token, ev.channel, threadTs, binding.transportBotId));
    if (!continuing) return c.body(null, 200);
  }

  const msg = normalizeSlackMessage(
    body.event_id ?? `${ev.channel}:${ev.ts}`,
    body.team_id ?? '',
    { channel: ev.channel, ts: ev.ts, thread_ts: ev.thread_ts, user: ev.user, text: stripMention(text, binding.transportBotId) },
    binding,
  );

  // Store the exact reply target before the idempotency claim. If this D1 write fails,
  // Slack can retry and repair the target instead of us suppressing a turn that can no
  // longer reply to its originating conversation.
  if (c.env.DB) {
    await upsertConversationTarget(c.env.DB, {
      projectId: msg.projectId,
      conversationId: msg.conversationId,
      provider: msg.provider,
      externalAccountId: msg.externalAccountId,
      externalSpaceId: msg.externalSpaceId,
      externalConversationId: msg.externalConversationId,
      transportTokenRef: binding.transportTokenRef,
    });
  }

  // Idempotency: Slack redelivers the same event_id on retry (at-least-once).
  // Claim it before dispatch so a retry can't fire a second reply. Only reached
  // for dispatch-bound events (mention/continue) — chatter we ignore costs no KV.
  const eventId = body.event_id ?? `${ev.channel}:${ev.ts}`;
  if (!(await claimEvent(c.env.SLACK_EVENTS, eventId))) {
    return c.body(null, 200); // duplicate delivery — already handled
  }

  // Log to the transcript so nightly reflection has something to consolidate (best-effort —
  // a logging hiccup must never block the reply). We only log conversations the bot is part of.
  if (c.env.DB) {
    await logMessage(c.env.DB, {
      projectId: msg.projectId,
      conversationId: msg.conversationId,
      senderId: msg.senderId,
      role: 'user',
      text: msg.text,
    }).catch(() => {});
  }

  await dispatch({
    agent: 'project',
    id: agentInstanceId(msg.projectId),
    session: `conv:${msg.conversationId}`,
    // Forward the author identity in neutral terms so history retains who said what — the
    // future reflection job reads senderId from it to attribute facts. (The initializer itself
    // can't see this; only the model does.)
    input: {
      message: msg.text,
      conversationId: msg.conversationId,
      provider: msg.provider,
      accountId: msg.externalAccountId,
      senderId: msg.senderId,
    },
  });

  return c.body(null, 200); // ack within Slack's 3s window; agent replies async
});

// Everything else → Flue's built-in agent / workflow / run routes.
app.route('/', flue());

export default app;
