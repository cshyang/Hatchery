import { Hono } from 'hono';
import { flue } from '@flue/runtime/routing';
import { dispatch } from '@flue/runtime';
import { verifySlackSignature } from '../src/slack/verify';
import { fetchThreadReplies, renderThreadBackscroll } from '../src/slack/threads';
import { mentionsBot, stripMention } from '../src/slack/mentions';
import { postWorkingAck } from '../src/slack/ack';
import { dispatchSlackTurnWithFallback } from '../src/slack/dispatch';
import {
  parseSlackEventEnvelope,
  slackEventId,
  slackUrlVerification,
  slackUserMessageEvent,
} from '../src/slack/events';
import { bindings, bindingBySlack, bindingByProject, agentInstanceId, autoCreateBinding } from '../src/project/bindings';
import { deploymentConfig, isKnownTeam } from '../src/config/deployment';
import { normalizeSlackMessage } from '../src/shared/canonical';
import { upsertConversationTarget } from '../src/project/conversations';
import { claimEvent, type KVLike } from '../src/shared/idempotency';
import type { D1Like } from '../src/skills/repository';
import { logMessage, projectsWithUnreflected, takeUnreflectedBatch, buildReflectInstructions } from '../src/knowledge/reflection';
import { upsertConnection, loadConnections, connectedNotice, disconnectedNotice, disableConnectionByRef } from '../src/connections/repository';
import { verifyNangoWebhook, parseNangoAuthWebhook, parseNangoDeletionWebhook } from '../src/providers/nango';
import { isCatalogProvider } from '../src/connections/catalog';
import { buildScheduledInput } from '../src/gateway/scheduled';
import { hasMatchingSecretHeader } from '../src/gateway/auth';
import { readJsonOrNull } from '../src/gateway/json';
import { postConnectionNotice } from '../src/connections/notices';
import { handleInternalWorkItemRequest } from '../src/workbench/gateway';
import { handleSourceChangeRunCallback } from '../src/workbench/source-change';
import { handleLinearComment, handleLinearWebhook } from '../src/agent-runs/linear';
import { handleAgentRunCallback } from '../src/agent-runs/repository';
import { reconcileAgentRuns } from '../src/agent-runs/dispatch';
import { activateAgentRunRoute, disableAgentRunRoute } from '../src/agent-runs/events';
import { handleNangoForwardWebhook } from '../src/agent-runs/provider-events';

// Custom front-controller. Flue mounts this app.ts as the Worker entry; we add
// the Slack ingress, then hand everything else to flue() (the /agents, /workflows,
// /runs, /admin routes). This is the gateway from docs/planning: verify → route →
// dispatch, acknowledging Slack fast and letting the agent reply asynchronously.

interface Env {
  SLACK_SIGNING_SECRET?: string;
  SLACK_EVENTS?: KVLike; // KV namespace for event_id idempotency
  HEARTBEAT_TOKEN?: string; // shared secret guarding the /__heartbeat trigger
  WORKBENCH_RUNNER_TOKEN?: string; // dedicated secret for source-change runner callbacks
  CODING_RUNNER_URL?: string; // generic source-change runner dispatch endpoint
  LINEAR_WEBHOOK_SECRET?: string; // Linear raw-body HMAC signing secret for /linear/webhook
  LINEAR_AGENT_PROJECTS?: string; // legacy one-release fallback; prefer agent_run_routes
  LINEAR_API_KEY?: string; // reserved for gateway-owned Linear status comments; never exposed to the model
  AGENT_RUNNER_URL?: string; // generic E2B-backed coding runner dispatch endpoint (legacy; superseded by Trigger.dev)
  AGENT_RUNNER_TOKEN?: string; // dedicated secret for agent-run dispatch and callbacks
  HATCHERY_PUBLIC_URL?: string; // absolute origin Trigger.dev calls back to (REQUIRED for coding dispatch)
  TRIGGER_SECRET_KEY?: string; // Trigger.dev secret key (Bearer) for the coding-task dispatch
  TRIGGER_API_URL?: string; // Trigger.dev REST base URL; defaults to https://api.trigger.dev
  RUNNER_GITHUB_PAT_TEMP?: string; // temporary GitHub PAT handed to the coding task (M0a stopgap; short-lived tokens later)
  LINEAR_BOT_ACTOR_ID?: string; // Hatchery's own Linear actor id; its transitions never self-trigger a run
  ADMIN_CONNECTIONS_TOKEN?: string; // OWN secret guarding /__admin/connections (ADR D11 — NOT the heartbeat token)
  NANGO_SECRET_KEY?: string; // platform Bearer for the Nango API (create session / fetch token)
  NANGO_WEBHOOK_SECRET?: string; // HMAC signing key to verify inbound Nango auth webhooks
  NANGO_INTEGRATION_KEYS?: string; // optional JSON mapping provider/authMode to Nango integration keys
  DB?: D1Like; // D1 skill catalog, transcript, memory, and conversation targets
  [binding: string]: unknown;
}

// Workspace-level transport identity for gateway auto-provisioning (same-workspace Milestone 1:
// one bot install, reused across all channels of the known team) is account-coupled config, resolved
// from env per request via deploymentConfig(c.env) — see src/config/deployment.ts. Falls back to the
// original Ecodark literals when unset, so an existing deployment is unchanged.

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

function requireHeartbeat(c: { env: Env; req: { header(n: string): string | undefined } }): boolean {
  return hasMatchingSecretHeader(c.env.HEARTBEAT_TOKEN, c.req.header('x-hatchery-token'));
}

// Manual heartbeat trigger. Token-guarded (inert unless HEARTBEAT_TOKEN is set
// and the x-hatchery-token header matches) so it can't be fired publicly. An
// optional {topic} in the body overrides the default.
app.post('/__heartbeat', async (c) => {
  if (!requireHeartbeat(c)) return c.body(null, 404);
  const body = await readJsonOrNull<{ topic?: string }>(() => c.req.json());
  const topic = body?.topic ? String(body.topic) : undefined;
  const dispatched = await fireHeartbeat(topic);
  return c.json({ dispatched, topic: topic ?? null });
});

// Per-job fire from the SchedulerDO (the agent's self-scheduled work). Unlike
// /__heartbeat (which fans out to every active project), this targets ONE project,
// in a session dedicated to the job id so each named schedule keeps its own memory.
// `fireId` makes it idempotent against alarm retries via the same KV claim layer.
app.post('/__internal/scheduled', async (c) => {
  if (!requireHeartbeat(c)) return c.body(null, 404);

  const body = await readJsonOrNull<{
    fireId?: string;
    projectId?: string;
    jobId?: string;
    kind?: string;
    payload?: Record<string, unknown>;
  }>(() => c.req.json());
  if (!body?.fireId || !body.projectId || !body.jobId) return c.json({ error: 'bad request' }, 400);

  if (!(await claimEvent(c.env.SLACK_EVENTS, `sched:${body.fireId}`))) {
    return c.json({ deduped: true }); // alarm retry / double-fire — already dispatched
  }

  const binding = await bindingByProject(body.projectId, c.env.DB);
  if (!binding || binding.status !== 'active') return c.json({ skipped: 'no active binding' });

  const scheduled = await buildScheduledInput({
    db: c.env.DB,
    projectId: body.projectId,
    kind: body.kind,
    payload: body.payload,
    now: new Date().toISOString(),
  });
  if (scheduled.skipped) return c.json({ skipped: scheduled.skipped });
  const input = scheduled.input;

  await dispatch({
    agent: 'project',
    id: agentInstanceId(body.projectId),
    session: `job:${body.projectId}:${body.jobId}`,
    input,
  });
  return c.json({ dispatched: true, jobId: body.jobId, skill: input.skill ?? null });
});

// Internal workbench intake. Future Linear/Slack/manual adapters call this to create a durable
// work item. Dispatch is tracked on a work_run because Flue dispatch is an external side effect,
// not part of the D1 write.
app.post('/__internal/work-items', async (c) => {
  const result = await handleInternalWorkItemRequest(
    {
      db: c.env.DB,
      expectedToken: c.env.HEARTBEAT_TOKEN,
      actualToken: c.req.header('x-hatchery-token'),
      body: await readJsonOrNull(() => c.req.json()),
    },
    { bindingByProject, dispatch },
  );
  if (result.status === 404) return c.body(null, 404);
  return c.json(result.body ?? {}, result.status as 200 | 400 | 500);
});

// Generic coding-runner callback. The runner edits code and opens PRs elsewhere; this route only
// records branch/PR/CI/deploy metadata back into the workbench. Dedicated token on purpose: runner
// reporting is not scheduler/heartbeat authority.
app.post('/__internal/source-change-runs', async (c) => {
  const result = await handleSourceChangeRunCallback(
    {
      db: c.env.DB,
      expectedToken: c.env.WORKBENCH_RUNNER_TOKEN,
      actualToken: c.req.header('x-hatchery-runner-token'),
      body: await readJsonOrNull(() => c.req.json()),
    },
  );
  if (result.status === 404) return c.body(null, 404);
  return c.json(result.body ?? {}, result.status as 200 | 400 | 500);
});

// Linear is the team-facing baton for coding-agent work. The gateway verifies Linear's raw-body
// HMAC and turns only "Issue transitioned into Run Agent" into an agent_run lease. The external
// runner owns coding-agent/E2B/PR behavior; Hatchery only records dispatch and callback metadata.
app.post('/linear/webhook', async (c) => {
  const raw = await c.req.text();
  // Issue state-changes trigger NEW runs (handleLinearWebhook); comments on an issue with an existing
  // run/PR spawn CONTINUATION runs on that PR branch (handleLinearComment). Same signed ingress, same
  // deferred dispatch + reconciler backstop.
  const event = c.req.header('linear-event');
  const linearReq = {
    db: c.env.DB,
    signingSecret: c.env.LINEAR_WEBHOOK_SECRET,
    signature: c.req.header('linear-signature'),
    deliveryId: c.req.header('linear-delivery'),
    event,
    rawBody: raw,
    projectsJson: c.env.LINEAR_AGENT_PROJECTS,
    nowMs: Date.now(),
  };
  const linearDeps = {
    triggerApiUrl: c.env.TRIGGER_API_URL ?? 'https://api.trigger.dev',
    triggerSecretKey: c.env.TRIGGER_SECRET_KEY,
    githubToken: c.env.RUNNER_GITHUB_PAT_TEMP,
    runnerToken: c.env.AGENT_RUNNER_TOKEN,
    hatcheryPublicUrl: c.env.HATCHERY_PUBLIC_URL,
    botActorId: c.env.LINEAR_BOT_ACTOR_ID,
    fetch,
  };
  const result =
    event === 'Comment'
      ? await handleLinearComment(linearReq, linearDeps)
      : await handleLinearWebhook(linearReq, linearDeps);
  // Immediate best-effort dispatch off the ack path; the ticker reconciler is the durable backstop.
  if (result.dispatch) c.executionCtx.waitUntil(result.dispatch());
  if (result.status === 404) return c.body(null, 404);
  return c.json(result.body ?? {}, result.status as 200 | 400 | 500);
});

// Agent-run callback from the external E2B coding runner. Dedicated token: runner reporting
// does not grant heartbeat, connection-admin, merge, or deploy authority.
app.post('/__internal/agent-runs', async (c) => {
  const result = await handleAgentRunCallback({
    db: c.env.DB,
    expectedToken: c.env.AGENT_RUNNER_TOKEN,
    actualToken: c.req.header('x-hatchery-agent-runner-token'),
    body: await readJsonOrNull(() => c.req.json()),
  });
  if (result.status === 404) return c.body(null, 404);
  return c.json(result.body ?? {}, result.status as 200 | 400 | 500);
});

// Agent-run reconciler. The ticker's frequent cron pokes this (Flue drops scheduled(), so the clock
// lives on the external ticker worker). It (re)dispatches queued runs, reclaims runs stuck mid-dispatch,
// and times out runs whose runner went dark — the durability backstop for the fire-and-forget webhook.
app.post('/__internal/agent-runs/reconcile', async (c) => {
  if (!requireHeartbeat(c)) return c.body(null, 404);
  const db = c.env.DB;
  if (!db) return c.json({ reconciled: false, reason: 'no DB binding' });
  const summary = await reconcileAgentRuns(db, {
    triggerApiUrl: c.env.TRIGGER_API_URL ?? 'https://api.trigger.dev',
    triggerSecretKey: c.env.TRIGGER_SECRET_KEY,
    githubToken: c.env.RUNNER_GITHUB_PAT_TEMP,
    runnerToken: c.env.AGENT_RUNNER_TOKEN,
    hatcheryPublicUrl: c.env.HATCHERY_PUBLIC_URL,
    fetch,
  });
  return c.json(summary);
});

// Nightly REM: the ticker's nightly cron pokes this. The GATE is cheap SQL (projects with
// messages past their watermark) — idle projects never dispatch a token-costing turn. For each
// qualifying project we take its batch (advancing the watermark server-side) and hand the
// transcript INLINE to a fresh consolidation session, so the live agent can't consume the
// watermark and reflection turns never pollute a real conversation thread.
app.post('/__internal/reflect-sweep', async (c) => {
  if (!requireHeartbeat(c)) return c.body(null, 404);
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
function requireAdmin(c: { env: Env; req: { header(n: string): string | undefined } }): boolean {
  return hasMatchingSecretHeader(c.env.ADMIN_CONNECTIONS_TOKEN, c.req.header('x-hatchery-admin-token'));
}

app.post('/__admin/connections', async (c) => {
  if (!requireAdmin(c)) return c.body(null, 404); // inert/invisible unless the admin token matches
  const db = c.env.DB;
  if (!db) return c.json({ error: 'no DB binding' }, 500);
  const body = await readJsonOrNull<{
    projectId?: string;
    provider?: string;
    tokenRef?: string;
    connectionRef?: string;
    config?: Record<string, unknown>;
    status?: 'active' | 'disabled';
  }>(() => c.req.json());
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
  if (!requireAdmin(c)) return c.body(null, 404);
  const db = c.env.DB;
  if (!db) return c.json({ error: 'no DB binding' }, 500);
  const projectId = c.req.query('projectId');
  if (!projectId) return c.json({ error: 'projectId query param required' }, 400);
  const connections = await loadConnections(db, projectId); // metadata only — no secret is ever stored or returned
  return c.json({ projectId, connections });
});

app.post('/__admin/agent-run-routes/:id/activate', async (c) => {
  if (!requireAdmin(c)) return c.body(null, 404);
  const db = c.env.DB;
  if (!db) return c.json({ error: 'no DB binding' }, 500);
  try {
    const route = await activateAgentRunRoute(db, c.req.param('id'), 'admin-route');
    return c.json({ ok: true, route });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'bad request' }, 400);
  }
});

app.post('/__admin/agent-run-routes/:id/disable', async (c) => {
  if (!requireAdmin(c)) return c.body(null, 404);
  const db = c.env.DB;
  if (!db) return c.json({ error: 'no DB binding' }, 500);
  try {
    const route = await disableAgentRunRoute(db, c.req.param('id'), 'admin-route');
    return c.json({ ok: true, route });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'bad request' }, 400);
  }
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

  const db = c.env.DB;
  if (!db) return c.json({ error: 'no DB binding' }, 500);

  // Deletion FIRST (a deletion event is not a creation). Target the row by connection_ref — the only
  // field guaranteed on a deletion webhook. Disabling makes loadConnectionSpecs drop it → the
  // provider's tools disappear next turn, instead of going stale and erroring on use. NOTE: whether
  // Nango sends this event is unconfirmed (docs list only creation/override) — this is the belt; the
  // braces is fetchToken self-heal (a dead connection_ref 404s → handled at call time regardless).
  const deletion = parseNangoDeletionWebhook(raw);
  if (deletion) {
    const disabled = await disableConnectionByRef(db, deletion.connectionId);
    if (disabled) {
      console.log(`[nango] disconnected provider "${disabled.provider}" for project ${disabled.projectId} (connection ${deletion.connectionId})`);
      await postConnectionNotice({
        db,
        env: c.env as Record<string, unknown>,
        projectId: disabled.projectId,
        text: disconnectedNotice(disabled.provider),
      });
      return c.json({ ok: true, disconnected: disabled.provider, projectId: disabled.projectId });
    }
    console.log(`[nango] deletion for unknown connection_ref ${deletion.connectionId} — nothing to disable`);
    return c.json({ ignored: 'no matching connection' });
  }

  const event = parseNangoAuthWebhook(raw);
  if (!event) {
    const forwarded = await handleNangoForwardWebhook({ db, rawBody: raw });
    if (forwarded.status === 404) return c.body(null, 404);
    if (forwarded.body?.handled || forwarded.body?.ignored) return c.json(forwarded.body ?? {}, forwarded.status as 200 | 400 | 500);
    // non-auth, non-creation, or success:false (failed/abandoned consent) — acknowledge, write nothing.
    console.log('[nango] webhook ignored (not an auth-creation-success event)');
    return c.json({ ignored: true });
  }

  // Convention guard: the Nango integration id MUST equal a catalog provider slug, else the row would
  // be connected-but-toolless (no API profile / typed tools). Log loudly and skip rather than store a
  // dead row. (See the runbook: operators name the Nango integration exactly the catalog slug.)
  if (!isCatalogProvider(event.provider)) {
    console.log(`[nango] webhook for unknown provider "${event.provider}" (cfg "${event.providerConfigKey}") — skipping upsert; name the Nango integration to match a catalog slug`);
    return c.json({ ignored: 'unknown provider' });
  }

  await upsertConnection(db, {
    projectId: event.projectId,
    provider: event.provider,
    connectionRef: event.connectionId,
    config: event.config,
    createdBy: 'nango-webhook',
  });
  console.log(`[nango] connected provider "${event.provider}" for project ${event.projectId} (connection ${event.connectionId})`);
  await postConnectionNotice({
    db,
    env: c.env as Record<string, unknown>,
    projectId: event.projectId,
    text: connectedNotice(event.provider),
  });
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

  const body = parseSlackEventEnvelope(raw);

  const verification = slackUrlVerification(body);
  if (verification) return c.json({ challenge: verification.challenge });

  const ev = slackUserMessageEvent(body);
  if (!ev) return c.body(null, 200);

  const teamId = body.team_id ?? '';
  let binding = await bindingBySlack(teamId, ev.channel, c.env.DB);
  if (!binding) {
    // No binding yet. If this is a channel of a KNOWN team and the bot is being addressed, the
    // gateway provisions a per-channel project (HARD LINE: gateway-created on a verified Slack
    // signature for an allowlisted team — NOT the agent). Otherwise acknowledge and stay silent.
    const dep = deploymentConfig(c.env);
    const addressed = mentionsBot(ev.text ?? '', dep.slackBotId);
    if (c.env.DB && isKnownTeam(c.env, teamId) && addressed) {
      await autoCreateBinding(c.env.DB, {
        teamId,
        channelId: ev.channel,
        transportBotId: dep.slackBotId,
        transportTokenRef: dep.slackTokenRef,
      });
      binding = await bindingBySlack(teamId, ev.channel, c.env.DB);
    }
    if (!binding) return c.body(null, 200); // unknown team, not addressed, or create failed → silent
  }

  // Engage policy:
  //  - @mention anywhere                         -> engage
  //  - reply in a thread the bot already posted in -> continue (no re-mention)
  //  - everything else                            -> log ambient (Layer 2), stay silent
  const text = ev.text ?? '';
  const token = (c.env as Record<string, string | undefined>)[binding.transportTokenRef];
  // Fetch the thread ONCE (if any) and reuse it for BOTH the participation check and the backscroll
  // we hand the agent — so a threaded turn is no longer context-blind. One conversations.replies call.
  const threadReplies =
    ev.thread_ts && token
      ? await fetchThreadReplies(token, ev.channel, ev.thread_ts).catch(() => [])
      : [];

  const eventId = slackEventId(body, ev);
  // Normalize once — both the ambient-log branch and the engaged path below use this.
  const msg = normalizeSlackMessage(
    eventId,
    teamId,
    { channel: ev.channel, ts: ev.ts, thread_ts: ev.thread_ts, user: ev.user, text: stripMention(text, binding.transportBotId) },
    binding,
  );

  // Engage when @mentioned anywhere, or when replying in a thread the bot already posted in.
  const engaged =
    mentionsBot(text, binding.transportBotId) ||
    threadReplies.some((m) => m.user === binding.transportBotId);

  if (!engaged) {
    // Ambient ingestion (Layer 2): remember every message in a bound channel even when we won't
    // answer it, so the cross-thread index (Layer 3) and proactive review (Layer 4) can see the
    // whole room — not just threads the bot was pulled into. NO dispatch, NO LLM turn; the agent
    // stays silent. Flagged ambient:true so nightly REM keeps consolidating ONLY bot conversations.
    // Deduped against Slack's at-least-once retries with the same KV claim the engaged path uses
    // (an event is ambient XOR engaged, so the two claim sites never fire on the same event_id).
    if (c.env.DB && (await claimEvent(c.env.SLACK_EVENTS, eventId))) {
      await logMessage(c.env.DB, {
        projectId: msg.projectId,
        conversationId: msg.conversationId,
        senderId: msg.senderId,
        role: 'user',
        text: msg.text,
        ambient: true,
      }).catch(() => {});
    }
    return c.body(null, 200);
  }

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

  // Idempotency: Slack redelivers the same event_id on retry (at-least-once). Claim it before
  // dispatch so a retry can't fire a second reply. (Ambient messages claim it too, above — every
  // persisted message is deduped now, not just dispatch-bound ones.)
  if (!(await claimEvent(c.env.SLACK_EVENTS, eventId))) {
    return c.body(null, 200); // duplicate delivery — already handled
  }

  // Post the deterministic "I'm on it" after the idempotency claim (so retries can't double-post it)
  // and CAPTURE its ts, so the turn edits this same message into the real reply instead of stacking
  // ack + answer. Awaited because the dispatch input below carries the ts to the model; a Slack
  // hiccup returns undefined and the reply degrades to a fresh post — never a blocked turn.
  const ackMessageTs = await postWorkingAck({
    token,
    channel: msg.externalSpaceId,
    threadTs: msg.externalConversationId,
  });

  // Log the engaged turn to the transcript (ambient defaults to 0, so nightly REM consolidates it).
  // Best-effort — a logging hiccup must never block the reply.
  if (c.env.DB) {
    await logMessage(c.env.DB, {
      projectId: msg.projectId,
      conversationId: msg.conversationId,
      senderId: msg.senderId,
      role: 'user',
      text: msg.text,
    }).catch(() => {});
  }

  await dispatchSlackTurnWithFallback(
    {
      agent: 'project',
      id: agentInstanceId(msg.projectId),
      session: `conv:${msg.conversationId}`,
      // Forward the author identity in neutral terms so history retains who said what — the
      // future reflection job reads senderId from it to attribute facts. (The initializer itself
      // can't see this; only the model does.)
      input: {
        message: msg.text,
        conversationId: msg.conversationId,
        // The ack's ts — the model relays it back to reply_to_conversation/update_status so its
        // message edits the "On it…" note in place. Omitted if the ack didn't post (no ts to edit).
        ...(ackMessageTs ? { ackMessageTs } : {}),
        provider: msg.provider,
        accountId: msg.externalAccountId,
        senderId: msg.senderId,
        ...(threadReplies.length
          ? { threadContext: renderThreadBackscroll(threadReplies, binding.transportBotId, { excludeTs: ev.ts }) }
          : {}),
      },
    },
    {
      executionCtx: c.executionCtx,
      token,
      channel: msg.externalSpaceId,
      threadTs: msg.externalConversationId,
    },
    { dispatch },
  );

  return c.body(null, 200); // ack within Slack's 3s window; agent replies async
});

// Everything else → Flue's built-in agent / workflow / run routes.
app.route('/', flue());

export default app;
