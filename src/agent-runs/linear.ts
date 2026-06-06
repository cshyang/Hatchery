import type { D1Like } from '../skills/repository';
import { createAgentRunEvent, createAgentRunNotification, findActiveAgentRunRoute, type AgentRunRoute } from './events';
import { createAgentRun, findLatestRunByLinearIssue, getAgentRunBySource, getLatestAgentRunByLinearIssue, updateAgentRun, type AgentRun, type AgentRunStatus, type ClockAndIds } from './repository';
import { claimAndDispatchRun, type RunnerDispatchDeps } from './dispatch';
import { continuationBlockReason, createContinuationRun } from './continuation';

const WEBHOOK_MAX_AGE_MS = 60_000;
const DEFAULT_RUN_STATE_NAME = 'Run Agent';
const DEFAULT_KIT = 'coding-default';
const DEFAULT_RUNTIME = 'pi';
const DEFAULT_SANDBOX_PROVIDER = 'e2b';

export interface LinearAgentProjectConfig {
  projectId: string;
  targetRepo: string;
  baseBranch: string;
  kit: string;
  runtime: string;
  sandboxProvider: string;
  runStateName: string;
}

export interface LinearWebhookRequest {
  db: D1Like | undefined;
  signingSecret: string | undefined;
  signature: string | undefined;
  deliveryId: string | undefined;
  event: string | undefined;
  rawBody: string;
  projectsJson: string | undefined;
  nowMs?: number;
}

export interface LinearWebhookDeps extends RunnerDispatchDeps, ClockAndIds {
  // Linear actor id of Hatchery's own integration. When set, a transition performed by that actor is
  // recorded but never triggers a run — closes the self-trigger loop if the bot ever moves an issue.
  botActorId?: string;
}

export interface LinearWebhookResult {
  status: number;
  body?: any;
  // Deferred best-effort dispatch. The handler returns fast (records the queued run); the caller runs
  // this via waitUntil so the runner call never sits on Slack/Linear's ack budget. The ticker
  // reconciler is the durable backstop if this never runs or fails.
  dispatch?: () => Promise<unknown>;
}

interface LinearIssueSnapshot {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  team: { id: string | null; key: string | null; name: string | null };
  state: { id: string | null; name: string };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyLinearWebhook(signingSecret: string, rawBody: string, signature: string | undefined | null): Promise<boolean> {
  if (!signingSecret || !signature) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(signingSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  return constantTimeEqual(toHex(mac), signature.toLowerCase());
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object');
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max = 4096): string {
  const s = String(value ?? '').trim();
  if (!s) throw new Error(`${field} is required`);
  if (s.length > max) throw new Error(`${field} is too long`);
  return s;
}

function optionalText(value: unknown, max = 4096): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > max) throw new Error('text field is too long');
  return s;
}

function supportedRuntime(value: unknown, source: string): string {
  const runtime = optionalText(value, 128) ?? DEFAULT_RUNTIME;
  if (runtime !== DEFAULT_RUNTIME) throw new Error(`${source} runtime "${runtime}" is not supported; use "${DEFAULT_RUNTIME}"`);
  return runtime;
}

function normalizeProjectConfig(input: unknown): LinearAgentProjectConfig {
  const cfg = record(input);
  return {
    projectId: text(cfg.projectId, 'projectId', 256),
    targetRepo: text(cfg.targetRepo, 'targetRepo', 512),
    baseBranch: optionalText(cfg.baseBranch, 128) ?? 'main',
    kit: optionalText(cfg.kit, 128) ?? DEFAULT_KIT,
    runtime: supportedRuntime(cfg.runtime, 'LINEAR_AGENT_PROJECTS'),
    sandboxProvider: optionalText(cfg.sandboxProvider, 128) ?? DEFAULT_SANDBOX_PROVIDER,
    runStateName: optionalText(cfg.runStateName, 128) ?? DEFAULT_RUN_STATE_NAME,
  };
}

export function parseLinearAgentProjects(projectsJson: string | undefined): Map<string, LinearAgentProjectConfig> {
  const out = new Map<string, LinearAgentProjectConfig>();
  if (!projectsJson) return out;
  const parsed = record(JSON.parse(projectsJson));
  for (const [key, value] of Object.entries(parsed)) out.set(key, normalizeProjectConfig(value));
  return out;
}

function parsePayload(rawBody: string): Record<string, unknown> {
  return record(JSON.parse(rawBody));
}

function objectField(parent: Record<string, unknown>, field: string): Record<string, unknown> | null {
  const value = parent[field];
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stateName(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'object' && !Array.isArray(value)) return optionalText((value as Record<string, unknown>).name, 128);
  return null;
}

function issueSnapshot(data: Record<string, unknown>): LinearIssueSnapshot {
  const team = objectField(data, 'team') ?? {};
  const state = objectField(data, 'state') ?? {};
  return {
    id: text(data.id, 'issue id', 256),
    identifier: text(data.identifier, 'issue identifier', 128),
    title: text(data.title, 'issue title', 512),
    description: optionalText(data.description, 8000),
    url: text(data.url, 'issue url', 2048),
    team: {
      id: optionalText(team.id, 256),
      key: optionalText(team.key, 128),
      name: optionalText(team.name, 256),
    },
    state: {
      id: optionalText(state.id, 256),
      name: text(state.name, 'issue state name', 128),
    },
  };
}

function linearProjectFor(issue: LinearIssueSnapshot, projects: Map<string, LinearAgentProjectConfig>): LinearAgentProjectConfig | null {
  if (issue.team.key && projects.has(issue.team.key)) return projects.get(issue.team.key) ?? null;
  if (issue.team.id && projects.has(issue.team.id)) return projects.get(issue.team.id) ?? null;
  return null;
}

function routeTargetRepo(route: AgentRunRoute): string {
  return `https://github.com/${route.githubOwner}/${route.githubRepo}`;
}

function routeToProjectConfig(route: AgentRunRoute): LinearAgentProjectConfig {
  return {
    projectId: route.projectId,
    targetRepo: routeTargetRepo(route),
    baseBranch: route.baseBranch,
    kit: route.kit,
    runtime: supportedRuntime(route.runtime, 'agent_run_routes'),
    sandboxProvider: route.sandboxProvider,
    runStateName: route.triggerValue,
  };
}

async function linearRouteFor(db: D1Like, issue: LinearIssueSnapshot): Promise<AgentRunRoute | null> {
  const keys = [issue.team.key, issue.team.id].filter((v): v is string => !!v);
  for (const externalKey of keys) {
    const route = await findActiveAgentRunRoute(db, {
      provider: 'linear',
      externalKey,
      triggerType: 'state',
      triggerValue: issue.state.name,
    });
    if (route) return route;
  }
  return null;
}

function previousIssueStateChange(payload: Record<string, unknown>): { changed: boolean; previousName: string | null } {
  const updatedFrom = objectField(payload, 'updatedFrom');
  if (!updatedFrom) return { changed: false, previousName: null };
  const previousName = stateName(updatedFrom.state);
  return {
    changed: previousName !== null || Object.prototype.hasOwnProperty.call(updatedFrom, 'stateId'),
    previousName,
  };
}

function idempotencyKey(issue: LinearIssueSnapshot, cfg: LinearAgentProjectConfig): string {
  return `linear:issue:${issue.id}:state:${cfg.runStateName}`;
}

function isTerminalRun(status: AgentRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function actorText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

// Self-trigger / automation guard. A human moving an issue into the trigger state is the intended baton;
// a move by Hatchery's own integration (or any non-user actor) must be recorded, not re-triggered, or we
// loop. Linear omits `actor` on some events — when absent we treat it as human so a real move is never
// suppressed; the loop is closed precisely once botActorId is configured (or the actor self-identifies).
function isNonHumanActor(payload: Record<string, unknown>, botActorId: string | undefined): boolean {
  const actor = objectField(payload, 'actor');
  if (!actor) return false;
  const type = actorText(actor.type);
  if (type && type.toLowerCase() !== 'user') return true;
  const id = actorText(actor.id);
  if (botActorId && id === botActorId) return true;
  const name = (actorText(actor.name) ?? '').toLowerCase();
  return name.includes('hatchery') || name.includes('[bot]');
}

// The self-contained dispatch body persisted on the run (the outbox message). runId + projectId +
// callback are injected at send time by dispatch.ts — runId isn't known until the row exists, and the
// callback URL is env-derived so a stored copy could go stale.
function buildDispatchPayload(cfg: LinearAgentProjectConfig, issue: LinearIssueSnapshot, deliveryId: string): string {
  return JSON.stringify({
    source: { type: 'linear', id: deliveryId },
    linearIssue: issue,
    targetRepo: cfg.targetRepo,
    baseBranch: cfg.baseBranch,
    kit: cfg.kit,
    runtime: cfg.runtime,
    sandboxProvider: cfg.sandboxProvider,
  });
}

async function recordStartedNotification(db: D1Like, run: AgentRun, deps: ClockAndIds) {
  await createAgentRunNotification(
    db,
    {
      projectId: run.projectId,
      runId: run.id,
      channel: 'linear',
      notificationType: 'run_started',
      dedupeKey: `notify:${run.id}:run_started:linear`,
      targetRef: run.linearIssueId ?? run.linearIdentifier ?? null,
      status: 'pending',
    },
    deps,
  );
}

export async function handleLinearWebhook(req: LinearWebhookRequest, deps: LinearWebhookDeps): Promise<LinearWebhookResult> {
  if (!(await verifyLinearWebhook(req.signingSecret ?? '', req.rawBody, req.signature))) return { status: 404 };
  if (!req.db) return { status: 500, body: { error: 'no DB binding' } };
  if (!req.deliveryId) return { status: 400, body: { error: 'Linear-Delivery is required' } };
  if (req.event !== 'Issue') return { status: 200, body: { skipped: 'not an Issue event' } };

  try {
    const payload = parsePayload(req.rawBody);
    const timestamp = Number(payload.webhookTimestamp);
    if (!Number.isFinite(timestamp) || Math.abs((req.nowMs ?? Date.now()) - timestamp) > WEBHOOK_MAX_AGE_MS) {
      return { status: 400, body: { error: 'stale Linear webhook' } };
    }
    if (payload.action !== 'update' || payload.type !== 'Issue') return { status: 200, body: { skipped: 'not an Issue update' } };

    const data = objectField(payload, 'data');
    if (!data) return { status: 400, body: { error: 'Issue data is required' } };
    const issue = issueSnapshot(data);
    const route = await linearRouteFor(req.db, issue);
    const projects = parseLinearAgentProjects(req.projectsJson);
    const cfg = route ? routeToProjectConfig(route) : linearProjectFor(issue, projects);
    if (!cfg) return { status: 200, body: { skipped: 'no Linear agent project config' } };

    const stateChange = previousIssueStateChange(payload);
    if (issue.state.name !== cfg.runStateName || !stateChange.changed || stateChange.previousName === cfg.runStateName) {
      return { status: 200, body: { skipped: 'not a Run Agent transition' } };
    }

    // Self-trigger guard: record a non-human actor's transition, but never dispatch from it.
    if (isNonHumanActor(payload, deps.botActorId)) {
      await createAgentRunEvent(
        req.db,
        {
          projectId: cfg.projectId,
          provider: 'linear',
          eventType: 'linear.issue.state_changed',
          providerDeliveryId: req.deliveryId,
          providerEntityId: issue.id,
          dedupeKey: `linear-direct:${req.deliveryId}`,
          actorType: 'provider_bot',
          handling: 'record_only',
          handlingReason: `non-human actor transitioned issue into ${cfg.runStateName}`,
          payload,
          occurredAt: timestamp,
          processedAt: req.nowMs ?? Date.now(),
        },
        deps,
      );
      return { status: 200, body: { skipped: 'non-human actor; recorded only' } };
    }

    const event = await createAgentRunEvent(
      req.db,
      {
        projectId: cfg.projectId,
        provider: 'linear',
        eventType: 'linear.issue.state_changed',
        providerDeliveryId: req.deliveryId,
        providerEntityId: issue.id,
        dedupeKey: `linear-direct:${req.deliveryId}`,
        actorType: 'human',
        handling: 'wake_controller',
        handlingReason: `issue transitioned into ${cfg.runStateName}`,
        payload,
        occurredAt: timestamp,
        processedAt: req.nowMs ?? Date.now(),
      },
      deps,
    );
    if (event.duplicate) {
      const existing = await getAgentRunBySource(req.db, cfg.projectId, 'linear', req.deliveryId);
      if (existing) return { status: 200, body: { run: existing, duplicate: true, dispatchStatus: 'deduped' } };
    }

    // Rerun gate: dedupe to a still-active run for this issue; allow a fresh run once the prior is
    // terminal (re-entering the trigger state is the rerun gesture). The stable key would otherwise
    // let one terminal run own the issue forever, so re-runs are keyed by delivery.
    const latest = await getLatestAgentRunByLinearIssue(req.db, cfg.projectId, issue.id);
    if (latest && !isTerminalRun(latest.status)) {
      return { status: 200, body: { run: latest, duplicate: true, dispatchStatus: 'deduped' } };
    }
    const runKey = latest ? `${idempotencyKey(issue, cfg)}:rerun:${req.deliveryId}` : idempotencyKey(issue, cfg);

    const created = await createAgentRun(
      req.db,
      {
        projectId: cfg.projectId,
        routeId: route?.id,
        sourceType: 'linear',
        sourceId: req.deliveryId,
        idempotencyKey: runKey,
        linearIssueId: issue.id,
        linearIdentifier: issue.identifier,
        linearUrl: issue.url,
        githubOwner: route?.githubOwner,
        githubRepo: route?.githubRepo,
        targetRepo: cfg.targetRepo,
        baseBranch: cfg.baseBranch,
        kit: cfg.kit,
        runtime: cfg.runtime,
        sandboxProvider: cfg.sandboxProvider,
        dispatchPayload: buildDispatchPayload(cfg, issue, req.deliveryId),
      },
      deps,
    );
    if (created.duplicate) {
      return { status: 200, body: { run: created.run, duplicate: true, dispatchStatus: 'deduped' } };
    }

    await updateAgentRun(req.db, { id: created.run.id, lastEventId: event.event.id }, deps);
    await recordStartedNotification(req.db, created.run, deps);

    // Hand the run to the runner OFF the response path; the ticker reconciler is the durable backstop.
    const db = req.db;
    const runId = created.run.id;
    return {
      status: 200,
      body: { run: created.run, duplicate: false, dispatchStatus: 'queued' },
      dispatch: () => claimAndDispatchRun(db, runId, deps, deps),
    };
  } catch (e) {
    return { status: 400, body: { error: e instanceof Error ? e.message : 'bad request' } };
  }
}

export async function handleLinearComment(req: LinearWebhookRequest, deps: LinearWebhookDeps): Promise<LinearWebhookResult> {
  if (!(await verifyLinearWebhook(req.signingSecret ?? '', req.rawBody, req.signature))) return { status: 404 };
  if (!req.db) return { status: 500, body: { error: 'no DB binding' } };
  if (!req.deliveryId) return { status: 400, body: { error: 'Linear-Delivery is required' } };
  if (req.event !== 'Comment') return { status: 200, body: { skipped: 'not a Comment event' } };

  try {
    const payload = parsePayload(req.rawBody);
    const timestamp = Number(payload.webhookTimestamp);
    if (!Number.isFinite(timestamp) || Math.abs((req.nowMs ?? Date.now()) - timestamp) > WEBHOOK_MAX_AGE_MS) {
      return { status: 400, body: { error: 'stale Linear webhook' } };
    }
    if (payload.action !== 'create' || payload.type !== 'Comment') return { status: 200, body: { skipped: 'not a Comment create' } };

    // Self-trigger guard: a bot/integration comment must never spawn a continuation.
    if (isNonHumanActor(payload, deps.botActorId)) return { status: 200, body: { skipped: 'non-human actor' } };

    const data = objectField(payload, 'data');
    if (!data) return { status: 400, body: { error: 'Comment data is required' } };
    const body = optionalText(data.body, 8000);
    if (!body) return { status: 200, body: { skipped: 'empty comment' } };
    const commentId = optionalText(data.id, 256) ?? req.deliveryId;
    const issue = objectField(data, 'issue');
    const issueId = optionalText(data.issueId, 256) ?? (issue ? optionalText(issue.id, 256) : null);
    if (!issueId) return { status: 200, body: { skipped: 'no issue id on comment' } };

    // A comment attaches to whatever run/project already owns the issue. Resolve FIRST so we do not
    // record a boundary event for comments on issues Hatchery never ran (workspace-wide noise).
    const parent = await findLatestRunByLinearIssue(req.db, issueId);
    if (!parent) return { status: 200, body: { skipped: 'no run for issue' } };
    const blocked = continuationBlockReason(parent);

    // Boundary receipt -> agent_run_events (mirrors handleLinearWebhook). Delivery-level dedupe.
    const event = await createAgentRunEvent(
      req.db,
      {
        projectId: parent.projectId,
        runId: parent.id,
        provider: 'linear',
        eventType: 'linear.comment.created',
        providerDeliveryId: req.deliveryId,
        providerEntityId: commentId,
        dedupeKey: `linear-direct:${req.deliveryId}`,
        actorType: 'human',
        handling: blocked ? 'record_only' : 'wake_controller',
        handlingReason: blocked ?? 'human comment creates a continuation run',
        payload,
        occurredAt: timestamp,
        processedAt: req.nowMs ?? Date.now(),
      },
      deps,
    );
    if (event.duplicate) {
      const existing = await getAgentRunBySource(req.db, parent.projectId, 'linear', req.deliveryId);
      if (existing) return { status: 200, body: { run: existing, duplicate: true, dispatchStatus: 'deduped' } };
    }
    if (blocked) return { status: 200, body: { skipped: blocked } };

    const outcome = await createContinuationRun(
      req.db,
      {
        projectId: parent.projectId,
        parent,
        feedback: body,
        source: { type: 'linear', id: req.deliveryId },
        replyTarget: { surface: 'linear', ref: issueId },
      },
      deps,
    );

    if (outcome.status === 'ignored') return { status: 200, body: { skipped: outcome.reason } };
    if (outcome.status === 'deduped') return { status: 200, body: { dispatchStatus: 'deduped', reason: outcome.reason } };

    await updateAgentRun(req.db, { id: outcome.run.id, lastEventId: event.event.id }, deps);
    return { status: 200, body: { run: outcome.run, dispatchStatus: 'queued' }, dispatch: outcome.dispatch };
  } catch (e) {
    return { status: 400, body: { error: e instanceof Error ? e.message : 'bad request' } };
  }
}
