import { hasMatchingSecretHeader } from '../gateway/auth';
import type { D1Like } from '../skills/repository';
import { createAgentRunEvent, createAgentRunNotification } from './events';

export const AGENT_RUN_STATUSES = ['queued', 'dispatching', 'running', 'waiting_human', 'waiting_approval', 'completed', 'failed', 'cancelled'] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export const AGENT_RUN_SOURCE_TYPES = ['linear', 'slack', 'manual', 'github', 'internal'] as const;
export type AgentRunSourceType = (typeof AGENT_RUN_SOURCE_TYPES)[number];

export interface ClockAndIds {
  id?: () => string;
  now?: () => number;
}

export interface AgentRun {
  id: string;
  projectId: string;
  routeId: string | null;
  sourceType: AgentRunSourceType;
  sourceId: string | null;
  idempotencyKey: string;
  linearIssueId: string | null;
  linearIdentifier: string | null;
  linearUrl: string | null;
  slackTeamId: string | null;
  slackChannelId: string | null;
  slackThreadTs: string | null;
  githubOwner: string | null;
  githubRepo: string | null;
  targetRepo: string;
  baseBranch: string;
  kit: string;
  runtime: string;
  sandboxProvider: string;
  sandboxId: string | null;
  status: AgentRunStatus;
  branch: string | null;
  commitSha: string | null;
  prUrl: string | null;
  ciUrl: string | null;
  summary: string | null;
  error: string | null;
  statusNote: string | null;
  lastEventId: string | null;
  lastHeartbeatAt: number | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

interface AgentRunRow {
  id: string;
  project_id: string;
  route_id: string | null;
  source_type: AgentRunSourceType;
  source_id: string | null;
  idempotency_key: string;
  linear_issue_id: string | null;
  linear_identifier: string | null;
  linear_url: string | null;
  slack_team_id: string | null;
  slack_channel_id: string | null;
  slack_thread_ts: string | null;
  github_owner: string | null;
  github_repo: string | null;
  target_repo: string;
  base_branch: string;
  kit: string;
  runtime: string;
  sandbox_provider: string;
  sandbox_id: string | null;
  status: AgentRunStatus;
  branch: string | null;
  commit_sha: string | null;
  pr_url: string | null;
  ci_url: string | null;
  summary: string | null;
  error: string | null;
  status_note: string | null;
  last_event_id: string | null;
  last_heartbeat_at: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface AgentRunCallbackResult {
  status: number;
  body?: any;
}

function makeId(deps: ClockAndIds = {}): string {
  return deps.id?.() ?? crypto.randomUUID();
}

function nowMs(deps: ClockAndIds = {}): number {
  return deps.now?.() ?? Date.now();
}

function normalizeText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

function requireText(value: unknown, field: string, max = 2048): string {
  const s = normalizeText(value);
  if (!s) throw new Error(`${field} is required`);
  if (s.length > max) throw new Error(`${field} is too long`);
  return s;
}

function maybeBody(value: unknown): string | null {
  const s = normalizeText(value);
  if (!s) return null;
  if (s.length > 4000) throw new Error('text field is too long');
  return s;
}

function assertOneOf<T extends readonly string[]>(value: string, allowed: T, field: string): asserts value is T[number] {
  if (!allowed.includes(value)) throw new Error(`${field} "${value}" is invalid`);
}

function changes(result: unknown): number {
  const meta = (result as { meta?: { changes?: number } } | undefined)?.meta;
  return typeof meta?.changes === 'number' ? meta.changes : 0;
}

function isTerminalStatus(status: AgentRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function rowToAgentRun(r: AgentRunRow): AgentRun {
  return {
    id: r.id,
    projectId: r.project_id,
    routeId: r.route_id ?? null,
    sourceType: r.source_type,
    sourceId: r.source_id ?? null,
    idempotencyKey: r.idempotency_key,
    linearIssueId: r.linear_issue_id ?? null,
    linearIdentifier: r.linear_identifier ?? null,
    linearUrl: r.linear_url ?? null,
    slackTeamId: r.slack_team_id ?? null,
    slackChannelId: r.slack_channel_id ?? null,
    slackThreadTs: r.slack_thread_ts ?? null,
    githubOwner: r.github_owner ?? null,
    githubRepo: r.github_repo ?? null,
    targetRepo: r.target_repo,
    baseBranch: r.base_branch,
    kit: r.kit,
    runtime: r.runtime,
    sandboxProvider: r.sandbox_provider,
    sandboxId: r.sandbox_id ?? null,
    status: r.status,
    branch: r.branch ?? null,
    commitSha: r.commit_sha ?? null,
    prUrl: r.pr_url ?? null,
    ciUrl: r.ci_url ?? null,
    summary: r.summary ?? null,
    error: r.error ?? null,
    statusNote: r.status_note ?? null,
    lastEventId: r.last_event_id ?? null,
    lastHeartbeatAt: r.last_heartbeat_at == null ? null : Number(r.last_heartbeat_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    completedAt: r.completed_at == null ? null : Number(r.completed_at),
  };
}

const AGENT_RUN_SELECT = `id, project_id, route_id, source_type, source_id, idempotency_key, linear_issue_id,
                         linear_identifier, linear_url, slack_team_id, slack_channel_id, slack_thread_ts,
                         github_owner, github_repo, target_repo, base_branch, kit, runtime, sandbox_provider,
                         sandbox_id, status, branch, commit_sha, pr_url, ci_url, summary, error, status_note,
                         last_event_id, last_heartbeat_at, created_at, updated_at, completed_at`;

export async function getAgentRun(db: D1Like, projectId: string, id: string): Promise<AgentRun | null> {
  const row = await db
    .prepare(
      `SELECT ${AGENT_RUN_SELECT}
         FROM agent_runs WHERE project_id=? AND id=?`,
    )
    .bind(projectId, id)
    .first<AgentRunRow>();
  return row ? rowToAgentRun(row) : null;
}

export async function getAgentRunById(db: D1Like, id: string): Promise<AgentRun | null> {
  const row = await db
    .prepare(
      `SELECT ${AGENT_RUN_SELECT}
         FROM agent_runs WHERE id=?`,
    )
    .bind(id)
    .first<AgentRunRow>();
  return row ? rowToAgentRun(row) : null;
}

async function getAgentRunByIdempotencyKey(db: D1Like, projectId: string, idempotencyKey: string): Promise<AgentRun | null> {
  const row = await db
    .prepare(
      `SELECT ${AGENT_RUN_SELECT}
         FROM agent_runs WHERE project_id=? AND idempotency_key=?`,
    )
    .bind(projectId, idempotencyKey)
    .first<AgentRunRow>();
  return row ? rowToAgentRun(row) : null;
}

export async function createAgentRun(
  db: D1Like,
  input: {
    projectId: string;
    routeId?: string | null;
    sourceType: string;
    sourceId?: string | null;
    idempotencyKey: string;
    linearIssueId?: string | null;
    linearIdentifier?: string | null;
    linearUrl?: string | null;
    slackTeamId?: string | null;
    slackChannelId?: string | null;
    slackThreadTs?: string | null;
    githubOwner?: string | null;
    githubRepo?: string | null;
    targetRepo: string;
    baseBranch?: string | null;
    kit?: string | null;
    runtime?: string | null;
    sandboxProvider?: string | null;
  },
  deps: ClockAndIds = {},
): Promise<{ run: AgentRun; duplicate: boolean }> {
  const projectId = requireText(input.projectId, 'projectId', 256);
  const sourceType = requireText(input.sourceType, 'sourceType', 64);
  assertOneOf(sourceType, AGENT_RUN_SOURCE_TYPES, 'sourceType');
  const idempotencyKey = requireText(input.idempotencyKey, 'idempotencyKey', 512);
  const existing = await getAgentRunByIdempotencyKey(db, projectId, idempotencyKey);
  if (existing) return { run: existing, duplicate: true };

  const t = nowMs(deps);
  const id = makeId(deps);
  await db
    .prepare(
      `INSERT INTO agent_runs(id, project_id, route_id, source_type, source_id, idempotency_key, linear_issue_id,
                              linear_identifier, linear_url, slack_team_id, slack_channel_id, slack_thread_ts,
                              github_owner, github_repo, target_repo, base_branch, kit, runtime, sandbox_provider,
                              sandbox_id, status, branch, commit_sha, pr_url, ci_url, summary, error,
                              status_note, last_event_id, last_heartbeat_at, created_at, updated_at, completed_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      id,
      projectId,
      normalizeText(input.routeId),
      sourceType,
      normalizeText(input.sourceId),
      idempotencyKey,
      normalizeText(input.linearIssueId),
      normalizeText(input.linearIdentifier),
      normalizeText(input.linearUrl),
      normalizeText(input.slackTeamId),
      normalizeText(input.slackChannelId),
      normalizeText(input.slackThreadTs),
      normalizeText(input.githubOwner),
      normalizeText(input.githubRepo),
      requireText(input.targetRepo, 'targetRepo', 512),
      normalizeText(input.baseBranch) ?? 'main',
      normalizeText(input.kit) ?? 'coding-default',
      normalizeText(input.runtime) ?? 'pi',
      normalizeText(input.sandboxProvider) ?? 'e2b',
      null,
      'queued',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      t,
      t,
      null,
    )
    .run();

  const run = await getAgentRun(db, projectId, id);
  if (!run) throw new Error('created agent run could not be read back');
  return { run, duplicate: false };
}

export async function updateAgentRun(
  db: D1Like,
  input: {
    id: string;
    status?: string | null;
    sandboxId?: string | null;
    branch?: string | null;
    commitSha?: string | null;
    prUrl?: string | null;
    ciUrl?: string | null;
    summary?: string | null;
    error?: string | null;
    statusNote?: string | null;
    lastEventId?: string | null;
    lastHeartbeatAt?: number | null;
    completedAt?: number | null;
  },
  deps: ClockAndIds = {},
): Promise<AgentRun> {
  const current = await getAgentRunById(db, input.id);
  if (!current) throw new Error('agent run not found');
  const status = normalizeText(input.status) ?? current.status;
  assertOneOf(status, AGENT_RUN_STATUSES, 'status');
  if (isTerminalStatus(current.status) && status !== current.status) {
    throw new Error(`terminal agent run cannot move from ${current.status} to ${status}`);
  }
  const t = nowMs(deps);
  const completedAt =
    input.completedAt === undefined
      ? current.completedAt ?? (isTerminalStatus(status) ? t : null)
      : input.completedAt;
  const result = await db
    .prepare(
      `UPDATE agent_runs
          SET status=?, sandbox_id=?, branch=?, commit_sha=?, pr_url=?, ci_url=?, summary=?, error=?,
              status_note=?, last_event_id=?, last_heartbeat_at=?, completed_at=?, updated_at=?
        WHERE id=?`,
    )
    .bind(
      status,
      input.sandboxId === undefined ? current.sandboxId : normalizeText(input.sandboxId),
      input.branch === undefined ? current.branch : normalizeText(input.branch),
      input.commitSha === undefined ? current.commitSha : normalizeText(input.commitSha),
      input.prUrl === undefined ? current.prUrl : normalizeText(input.prUrl),
      input.ciUrl === undefined ? current.ciUrl : normalizeText(input.ciUrl),
      input.summary === undefined ? current.summary : maybeBody(input.summary),
      input.error === undefined ? current.error : maybeBody(input.error),
      input.statusNote === undefined ? current.statusNote : maybeBody(input.statusNote),
      input.lastEventId === undefined ? current.lastEventId : normalizeText(input.lastEventId),
      input.lastHeartbeatAt === undefined ? current.lastHeartbeatAt : input.lastHeartbeatAt,
      completedAt,
      t,
      input.id,
    )
    .run();
  if (changes(result) !== 1) throw new Error('agent run not found');
  const updated = await getAgentRunById(db, input.id);
  if (!updated) throw new Error('updated agent run could not be read back');
  return updated;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object');
  return value as Record<string, unknown>;
}

function callbackStatus(value: unknown): 'running' | 'pr_opened' | 'completed' | 'deployed' | 'failed' | 'cancelled' {
  const status = requireText(value, 'status', 64);
  if (status === 'running' || status === 'pr_opened' || status === 'completed' || status === 'deployed' || status === 'failed' || status === 'cancelled') {
    return status;
  }
  throw new Error('status must be one of: running, pr_opened, completed, deployed, failed, cancelled');
}

function mappedStatus(status: ReturnType<typeof callbackStatus>): AgentRunStatus {
  if (status === 'pr_opened') return 'waiting_approval';
  if (status === 'deployed') return 'completed';
  return status;
}

function optionalCallbackText(body: Record<string, unknown>, field: string): string | null | undefined {
  return Object.prototype.hasOwnProperty.call(body, field) ? normalizeText(body[field]) : undefined;
}

function notificationTypeForCallback(status: ReturnType<typeof callbackStatus>): string | null {
  if (status === 'pr_opened') return 'pr_opened';
  if (status === 'completed' || status === 'deployed') return 'completed';
  if (status === 'failed') return 'failed';
  return null;
}

function runnerEventDedupeKey(runId: string, status: string, body: Record<string, unknown>): string {
  const eventId = normalizeText(body.eventId);
  if (eventId) return `runner:${runId}:${eventId}`;
  const stable = [status, normalizeText(body.branch), normalizeText(body.commitSha), normalizeText(body.prUrl), normalizeText(body.ciUrl), normalizeText(body.error)]
    .filter((v): v is string => !!v)
    .join(':');
  return `runner:${runId}:${stable || status}`;
}

export async function handleAgentRunCallback(
  req: {
    db: D1Like | undefined;
    expectedToken: string | undefined;
    actualToken: string | undefined;
    body: unknown;
  },
  deps: ClockAndIds = {},
): Promise<AgentRunCallbackResult> {
  if (!hasMatchingSecretHeader(req.expectedToken, req.actualToken)) return { status: 404 };
  if (!req.db) return { status: 500, body: { error: 'no DB binding' } };
  try {
    const body = record(req.body);
    const status = callbackStatus(body.status);
    const mapped = mappedStatus(status);
    const runId = requireText(body.runId, 'runId', 256);
    const currentRun = await getAgentRunById(req.db, runId);
    if (!currentRun) throw new Error('agent run not found');
    const event = await createAgentRunEvent(
      req.db,
      {
        projectId: currentRun.projectId,
        runId,
        provider: 'runner',
        eventType: `runner.${status}`,
        providerDeliveryId: normalizeText(body.eventId),
        providerEntityId: runId,
        dedupeKey: runnerEventDedupeKey(runId, status, body),
        actorType: 'runner',
        handling: 'record_only',
        handlingReason: 'runner callback',
        payload: body,
        processedAt: nowMs(deps),
      },
      deps,
    );
    const run = await updateAgentRun(
      req.db,
      {
        id: runId,
        status: mapped,
        sandboxId: optionalCallbackText(body, 'sandboxId'),
        branch: optionalCallbackText(body, 'branch'),
        commitSha: optionalCallbackText(body, 'commitSha'),
        prUrl: optionalCallbackText(body, 'prUrl'),
        ciUrl: optionalCallbackText(body, 'ciUrl'),
        summary: optionalCallbackText(body, 'summary'),
        error: optionalCallbackText(body, 'error'),
        lastEventId: event.event.id,
        statusNote: optionalCallbackText(body, 'statusNote'),
      },
      deps,
    );
    const notificationType = notificationTypeForCallback(status);
    if (notificationType) {
      await createAgentRunNotification(
        req.db,
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
    return { status: 200, body: { run } };
  } catch (e) {
    return { status: 400, body: { error: e instanceof Error ? e.message : 'bad request' } };
  }
}
