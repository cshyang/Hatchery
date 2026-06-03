import type { D1Like } from '../skills/repository';
import { createAgentRunEvent, createAgentRunNotification, type AgentRunActorType, type AgentRunHandling } from './events';
import { getAgentRunById, updateAgentRun, type AgentRun } from './repository';

export interface ProviderEventResult {
  status: number;
  body?: any;
}

interface ClockAndIds {
  id?: () => string;
  now?: () => number;
}

interface ConnectionRefRow {
  project_id: string;
  provider: string;
}

interface IdRow {
  id: string;
}

interface NangoForwardBody {
  type?: string;
  connectionId?: string;
  provider?: string;
  providerConfigKey?: string;
  payload?: unknown;
}

interface NormalizedProviderEvent {
  provider: 'github';
  eventType: string;
  providerDeliveryId: string;
  providerEntityId: string | null;
  actorType: AgentRunActorType;
  prUrl: string | null;
  branch: string | null;
  commitSha: string | null;
  notificationType: string | null;
  completesRun: boolean;
}

function nowMs(deps: ClockAndIds = {}): number {
  return deps.now?.() ?? Date.now();
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

function nestedRecord(parent: Record<string, unknown>, field: string): Record<string, unknown> {
  return record(parent[field]) ?? {};
}

function headerValue(headers: Record<string, unknown>, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return text(value);
  }
  return null;
}

async function findActiveConnectionByRef(db: D1Like, connectionRef: string): Promise<ConnectionRefRow | null> {
  return db
    .prepare('SELECT project_id, provider FROM connections WHERE connection_ref=? AND status=\'active\'')
    .bind(connectionRef)
    .first<ConnectionRefRow>();
}

async function findRunByExactField(db: D1Like, projectId: string, field: 'pr_url' | 'branch' | 'commit_sha', value: string | null): Promise<AgentRun | null> {
  if (!value) return null;
  const row = await db.prepare(`SELECT id FROM agent_runs WHERE project_id=? AND ${field}=? LIMIT 1`).bind(projectId, value).first<IdRow>();
  return row ? getAgentRunById(db, row.id) : null;
}

async function correlateRun(db: D1Like, projectId: string, ev: NormalizedProviderEvent): Promise<AgentRun | null> {
  // Watch item for the announce side: GitHub PR-opened can arrive before the runner callback has
  // written pr_url/branch/commit_sha. Today the runner callback owns the pr_opened notification
  // receipt, so a run-less early GitHub receipt is harmless. When notifications actually send, add
  // a reconciliation pass that re-links these exact provider events after runner metadata lands.
  return (
    (await findRunByExactField(db, projectId, 'pr_url', ev.prUrl)) ??
    (await findRunByExactField(db, projectId, 'branch', ev.branch)) ??
    (await findRunByExactField(db, projectId, 'commit_sha', ev.commitSha))
  );
}

function actorType(payload: Record<string, unknown>): AgentRunActorType {
  const sender = nestedRecord(payload, 'sender');
  const type = text(sender.type)?.toLowerCase();
  const login = text(sender.login)?.toLowerCase() ?? '';
  if (type === 'bot' || login.includes('hatchery') || login.includes('[bot]')) return 'provider_bot';
  if (type === 'user') return 'human';
  return 'unknown';
}

function normalizeGithubForward(payload: Record<string, unknown>): NormalizedProviderEvent | null {
  const headers = nestedRecord(payload, 'headers');
  const githubEvent = headerValue(headers, 'X-GitHub-Event');
  const delivery = headerValue(headers, 'X-GitHub-Delivery') ?? text(payload.deliveryId);
  const action = text(payload.action);
  const actor = actorType(payload);

  const pullRequest = record(payload.pull_request);
  if (pullRequest) {
    const head = nestedRecord(pullRequest, 'head');
    const prUrl = text(pullRequest.html_url);
    const providerEntityId = text(pullRequest.id) ?? text(pullRequest.number);
    const merged = pullRequest.merged === true;
    const branch = text(head.ref);
    const commitSha = text(head.sha);
    if (action === 'opened') {
      return {
        provider: 'github',
        eventType: 'github.pull_request.opened',
        providerDeliveryId: delivery ?? `pull_request:${providerEntityId ?? prUrl ?? 'unknown'}:opened`,
        providerEntityId,
        actorType: actor,
        prUrl,
        branch,
        commitSha,
        notificationType: 'pr_opened',
        completesRun: false,
      };
    }
    if (action === 'closed' && merged) {
      return {
        provider: 'github',
        eventType: 'github.pull_request.merged',
        providerDeliveryId: delivery ?? `pull_request:${providerEntityId ?? prUrl ?? 'unknown'}:merged`,
        providerEntityId,
        actorType: actor,
        prUrl,
        branch,
        commitSha,
        notificationType: 'completed',
        completesRun: true,
      };
    }
    if (action === 'closed') {
      return {
        provider: 'github',
        eventType: 'github.pull_request.closed',
        providerDeliveryId: delivery ?? `pull_request:${providerEntityId ?? prUrl ?? 'unknown'}:closed`,
        providerEntityId,
        actorType: actor,
        prUrl,
        branch,
        commitSha,
        notificationType: null,
        completesRun: false,
      };
    }
  }

  const comment = record(payload.comment);
  if (comment && record(payload.issue)) {
    const issue = nestedRecord(payload, 'issue');
    return {
      provider: 'github',
      eventType: 'github.issue_comment.created',
      providerDeliveryId: delivery ?? `issue_comment:${text(comment.id) ?? 'unknown'}`,
      providerEntityId: text(comment.id),
      actorType: actor,
      prUrl: text(issue.pull_request && record(issue.pull_request)?.html_url) ?? null,
      branch: null,
      commitSha: null,
      notificationType: null,
      completesRun: false,
    };
  }

  if (comment && text(payload.pull_request_review_id)) {
    return {
      provider: 'github',
      eventType: 'github.pull_request_review_comment.created',
      providerDeliveryId: delivery ?? `review_comment:${text(comment.id) ?? 'unknown'}`,
      providerEntityId: text(comment.id),
      actorType: actor,
      prUrl: text(nestedRecord(payload, 'pull_request').html_url),
      branch: null,
      commitSha: text(comment.commit_id),
      notificationType: null,
      completesRun: false,
    };
  }

  const checkRun = record(payload.check_run);
  if (checkRun && (githubEvent === 'check_run' || action === 'completed')) {
    return {
      provider: 'github',
      eventType: 'github.check.completed',
      providerDeliveryId: delivery ?? `check_run:${text(checkRun.id) ?? 'unknown'}`,
      providerEntityId: text(checkRun.id),
      actorType: 'provider_bot',
      prUrl: null,
      branch: null,
      commitSha: text(checkRun.head_sha),
      notificationType: null,
      completesRun: false,
    };
  }

  const workflowRun = record(payload.workflow_run);
  if (workflowRun && (githubEvent === 'workflow_run' || action === 'completed')) {
    return {
      provider: 'github',
      eventType: 'github.workflow.completed',
      providerDeliveryId: delivery ?? `workflow_run:${text(workflowRun.id) ?? 'unknown'}`,
      providerEntityId: text(workflowRun.id),
      actorType: 'provider_bot',
      prUrl: text(workflowRun.pull_requests && Array.isArray(workflowRun.pull_requests) ? record(workflowRun.pull_requests[0])?.url : null),
      branch: text(workflowRun.head_branch),
      commitSha: text(workflowRun.head_sha),
      notificationType: null,
      completesRun: false,
    };
  }

  return null;
}

function handlingFor(run: AgentRun | null, ev: NormalizedProviderEvent): { handling: AgentRunHandling; reason: string } {
  if (!run) return { handling: 'record_only', reason: 'no correlated run' };
  if (ev.actorType !== 'human') return { handling: 'record_only', reason: 'provider bot or self echo' };
  if (ev.eventType.includes('comment.created') && run.status === 'waiting_human') return { handling: 'wake_controller', reason: 'human comment on waiting run' };
  if (ev.notificationType || ev.completesRun) return { handling: 'notify', reason: 'correlated provider artifact changed' };
  return { handling: 'record_only', reason: 'correlated but no action needed' };
}

async function registerNotification(db: D1Like, run: AgentRun, notificationType: string, deps: ClockAndIds) {
  await createAgentRunNotification(
    db,
    {
      projectId: run.projectId,
      runId: run.id,
      channel: 'linear',
      notificationType,
      dedupeKey: `notify:${run.id}:${notificationType}:linear`,
      targetRef: run.linearIssueId ?? run.linearIdentifier ?? null,
      status: 'pending',
    },
    deps,
  );
}

export async function handleNangoForwardWebhook(req: { db: D1Like | undefined; rawBody: string }, deps: ClockAndIds = {}): Promise<ProviderEventResult> {
  if (!req.db) return { status: 500, body: { error: 'no DB binding' } };
  let body: NangoForwardBody;
  try {
    body = JSON.parse(req.rawBody) as NangoForwardBody;
  } catch {
    return { status: 400, body: { error: 'bad request' } };
  }

  if (body.type !== 'forward' || !body.connectionId) {
    return { status: 200, body: { ignored: 'unattributed forward' } };
  }

  const connection = await findActiveConnectionByRef(req.db, String(body.connectionId));
  if (!connection) return { status: 200, body: { ignored: 'unknown connection' } };

  const provider = text(body.providerConfigKey) ?? text(body.provider) ?? connection.provider;
  const payload = record(body.payload);
  if (!payload) return { status: 200, body: { ignored: 'empty forward payload' } };
  if (provider !== 'github') return { status: 200, body: { ignored: 'unsupported provider event', provider } };

  const normalized = normalizeGithubForward(payload);
  if (!normalized) return { status: 200, body: { ignored: 'unsupported github event' } };
  const run = await correlateRun(req.db, connection.project_id, normalized);
  const handling = handlingFor(run, normalized);
  const event = await createAgentRunEvent(
    req.db,
    {
      projectId: connection.project_id,
      runId: run?.id,
      provider: normalized.provider,
      eventType: normalized.eventType,
      providerDeliveryId: normalized.providerDeliveryId,
      providerEntityId: normalized.providerEntityId,
      dedupeKey: `nango-forward:${body.connectionId}:github:${normalized.providerDeliveryId}`,
      actorType: normalized.actorType,
      handling: handling.handling,
      handlingReason: handling.reason,
      payload,
      processedAt: nowMs(deps),
    },
    deps,
  );
  if (event.duplicate) return { status: 200, body: { handled: true, duplicate: true, event: event.event } };

  if (run && normalized.completesRun) {
    await updateAgentRun(req.db, { id: run.id, status: 'completed', lastEventId: event.event.id }, deps);
  } else if (run) {
    await updateAgentRun(req.db, { id: run.id, lastEventId: event.event.id }, deps);
  }
  if (run && normalized.notificationType) {
    await registerNotification(req.db, run, normalized.notificationType, deps);
  }

  return { status: 200, body: { handled: true, event: event.event, runId: run?.id ?? null, handling: handling.handling } };
}
