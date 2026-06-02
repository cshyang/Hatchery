import type { D1Like } from '../skills/repository';

export const WORK_ITEM_STATUSES = [
  'requested',
  'queued',
  'claimed',
  'running',
  'waiting_approval',
  'blocked',
  'completed',
  'failed',
  'cancelled',
] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

export const MODEL_WORK_ITEM_STATUSES = ['running', 'waiting_approval', 'blocked', 'completed', 'failed'] as const;
export type ModelWorkItemStatus = (typeof MODEL_WORK_ITEM_STATUSES)[number];

export const WORK_RUNNERS = ['flue', 'e2b', 'trigger'] as const;
export type WorkRunner = (typeof WORK_RUNNERS)[number];

export const WORK_RUN_STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled'] as const;
export type WorkRunStatus = (typeof WORK_RUN_STATUSES)[number];

export const DISPATCH_STATUSES = ['not_requested', 'pending', 'dispatched', 'failed'] as const;
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];

export const WORK_ITEM_SOURCE_TYPES = ['internal', 'manual', 'slack', 'linear', 'github'] as const;
export type WorkItemSourceType = (typeof WORK_ITEM_SOURCE_TYPES)[number];

export const ARTIFACT_STATUSES = ['registered', 'failed'] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

export interface ClockAndIds {
  id?: () => string;
  now?: () => number;
}

export interface WorkItem {
  id: string;
  projectId: string;
  parentId: string | null;
  sourceType: WorkItemSourceType;
  sourceId: string | null;
  dedupeKey: string | null;
  title: string;
  body: string | null;
  status: WorkItemStatus;
  priority: number;
  claimedBy: string | null;
  sessionId: string | null;
  statusNote: string | null;
  updatedByType: 'gateway' | 'model' | 'system' | 'user';
  updatedById: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkRun {
  id: string;
  workItemId: string;
  runner: WorkRunner;
  attempt: number;
  status: WorkRunStatus;
  dispatchStatus: DispatchStatus;
  externalRunId: string | null;
  summary: string | null;
  error: string | null;
  dispatchAttempts: number;
  dispatchedAt: number | null;
  lastDispatchError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ArtifactRef {
  id: string;
  projectId: string;
  workItemId: string | null;
  sourceProvider: string;
  sourceId: string | null;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  storageRef: string | null;
  sha256: string | null;
  status: ArtifactStatus;
  summary: string | null;
  createdAt: number;
  updatedAt: number;
}

interface WorkItemRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  source_type: WorkItemSourceType;
  source_id: string | null;
  dedupe_key: string | null;
  title: string;
  body: string | null;
  status: WorkItemStatus;
  priority: number;
  claimed_by: string | null;
  session_id: string | null;
  status_note: string | null;
  updated_by_type: 'gateway' | 'model' | 'system' | 'user';
  updated_by_id: string | null;
  created_at: number;
  updated_at: number;
}

interface WorkRunRow {
  id: string;
  work_item_id: string;
  runner: WorkRunner;
  attempt: number;
  status: WorkRunStatus;
  dispatch_status: DispatchStatus;
  external_run_id: string | null;
  summary: string | null;
  error: string | null;
  dispatch_attempts: number;
  dispatched_at: number | null;
  last_dispatch_error: string | null;
  created_at: number;
  updated_at: number;
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
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > 20000) throw new Error('body is too long');
  return s;
}

function assertOneOf<T extends readonly string[]>(value: string, allowed: T, field: string): asserts value is T[number] {
  if (!allowed.includes(value)) throw new Error(`${field} "${value}" is invalid`);
}

function changes(result: unknown): number {
  const meta = (result as { meta?: { changes?: number } } | undefined)?.meta;
  return typeof meta?.changes === 'number' ? meta.changes : 0;
}

function rowToWorkItem(r: WorkItemRow): WorkItem {
  return {
    id: r.id,
    projectId: r.project_id,
    parentId: r.parent_id ?? null,
    sourceType: r.source_type,
    sourceId: r.source_id ?? null,
    dedupeKey: r.dedupe_key ?? null,
    title: r.title,
    body: r.body ?? null,
    status: r.status,
    priority: Number(r.priority ?? 0),
    claimedBy: r.claimed_by ?? null,
    sessionId: r.session_id ?? null,
    statusNote: r.status_note ?? null,
    updatedByType: r.updated_by_type,
    updatedById: r.updated_by_id ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function rowToWorkRun(r: WorkRunRow): WorkRun {
  return {
    id: r.id,
    workItemId: r.work_item_id,
    runner: r.runner,
    attempt: Number(r.attempt),
    status: r.status,
    dispatchStatus: r.dispatch_status,
    externalRunId: r.external_run_id ?? null,
    summary: r.summary ?? null,
    error: r.error ?? null,
    dispatchAttempts: Number(r.dispatch_attempts ?? 0),
    dispatchedAt: r.dispatched_at == null ? null : Number(r.dispatched_at),
    lastDispatchError: r.last_dispatch_error ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export async function getWorkItem(db: D1Like, projectId: string, id: string): Promise<WorkItem | null> {
  const row = await db
    .prepare(
      `SELECT id, project_id, parent_id, source_type, source_id, dedupe_key, title, body, status, priority,
              claimed_by, session_id, status_note, updated_by_type, updated_by_id, created_at, updated_at
         FROM work_items WHERE project_id=? AND id=?`,
    )
    .bind(projectId, id)
    .first<WorkItemRow>();
  return row ? rowToWorkItem(row) : null;
}

async function getWorkItemById(db: D1Like, id: string): Promise<WorkItem | null> {
  const row = await db
    .prepare(
      `SELECT id, project_id, parent_id, source_type, source_id, dedupe_key, title, body, status, priority,
              claimed_by, session_id, status_note, updated_by_type, updated_by_id, created_at, updated_at
         FROM work_items WHERE id=?`,
    )
    .bind(id)
    .first<WorkItemRow>();
  return row ? rowToWorkItem(row) : null;
}

export async function createWorkItem(
  db: D1Like,
  input: {
    projectId: string;
    title: string;
    body?: string | null;
    parentId?: string | null;
    sourceType?: string | null;
    sourceId?: string | null;
    dedupeKey?: string | null;
    priority?: number | null;
    updatedByType?: WorkItem['updatedByType'];
    updatedById?: string | null;
  },
  deps: ClockAndIds = {},
): Promise<{ item: WorkItem; duplicate: boolean }> {
  const projectId = requireText(input.projectId, 'projectId', 256);
  const title = requireText(input.title, 'title', 512);
  const sourceType = normalizeText(input.sourceType) ?? 'internal';
  assertOneOf(sourceType, WORK_ITEM_SOURCE_TYPES, 'sourceType');
  const dedupeKey = normalizeText(input.dedupeKey);

  if (dedupeKey) {
    const existing = await db
      .prepare(
        `SELECT id, project_id, parent_id, source_type, source_id, dedupe_key, title, body, status, priority,
                claimed_by, session_id, status_note, updated_by_type, updated_by_id, created_at, updated_at
           FROM work_items WHERE project_id=? AND dedupe_key=?`,
      )
      .bind(projectId, dedupeKey)
      .first<WorkItemRow>();
    if (existing) return { item: rowToWorkItem(existing), duplicate: true };
  }

  const parentId = normalizeText(input.parentId);
  if (parentId) {
    const parent = await getWorkItemById(db, parentId);
    if (!parent || parent.projectId !== projectId) throw new Error('parentId must refer to a work item in the same project');
  }

  const t = nowMs(deps);
  const id = makeId(deps);
  await db
    .prepare(
      `INSERT INTO work_items(id, project_id, parent_id, source_type, source_id, dedupe_key, title, body, status,
                              priority, claimed_by, session_id, status_note, updated_by_type, updated_by_id,
                              created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      id,
      projectId,
      parentId,
      sourceType,
      normalizeText(input.sourceId),
      dedupeKey,
      title,
      maybeBody(input.body),
      'requested',
      Number(input.priority ?? 0),
      null,
      null,
      null,
      input.updatedByType ?? 'system',
      normalizeText(input.updatedById),
      t,
      t,
    )
    .run();
  const item = await getWorkItem(db, projectId, id);
  if (!item) throw new Error('created work item could not be read back');
  return { item, duplicate: false };
}

export async function listWorkItems(db: D1Like, projectId: string, opts: { status?: string | null; limit?: number | null } = {}): Promise<WorkItem[]> {
  const limit = Math.max(1, Math.min(Number(opts.limit ?? 25), 50));
  const status = normalizeText(opts.status);
  if (status) {
    assertOneOf(status, WORK_ITEM_STATUSES, 'status');
    const { results } = await db
      .prepare(
        `SELECT id, project_id, parent_id, source_type, source_id, dedupe_key, title, body, status, priority,
                claimed_by, session_id, status_note, updated_by_type, updated_by_id, created_at, updated_at
           FROM work_items WHERE project_id=? AND status=? ORDER BY updated_at DESC LIMIT ?`,
      )
      .bind(projectId, status, limit)
      .all<WorkItemRow>();
    return (results ?? []).map(rowToWorkItem);
  }
  const { results } = await db
    .prepare(
      `SELECT id, project_id, parent_id, source_type, source_id, dedupe_key, title, body, status, priority,
              claimed_by, session_id, status_note, updated_by_type, updated_by_id, created_at, updated_at
         FROM work_items WHERE project_id=? ORDER BY updated_at DESC LIMIT ?`,
    )
    .bind(projectId, limit)
    .all<WorkItemRow>();
  return (results ?? []).map(rowToWorkItem);
}

export async function claimWorkItem(
  db: D1Like,
  input: { projectId: string; id: string; claimedBy: string; sessionId: string },
  deps: ClockAndIds = {},
): Promise<WorkItem | null> {
  const t = nowMs(deps);
  const result = await db
    .prepare(
      `UPDATE work_items
          SET status='claimed', claimed_by=?, session_id=?, updated_by_type=?, updated_by_id=?, updated_at=?
        WHERE project_id=? AND id=? AND status IN ('requested','queued') AND claimed_by IS NULL`,
    )
    .bind(input.claimedBy, input.sessionId, 'system', input.claimedBy, t, input.projectId, input.id)
    .run();
  if (changes(result) !== 1) return null;
  return getWorkItem(db, input.projectId, input.id);
}

const TERMINAL_WORK_ITEM_STATUSES = new Set<WorkItemStatus>(['completed', 'failed', 'cancelled']);

export async function updateWorkItemStatus(
  db: D1Like,
  input: {
    projectId: string;
    id: string;
    status: string;
    statusNote?: string | null;
    updatedByType: WorkItem['updatedByType'];
    updatedById?: string | null;
  },
  deps: ClockAndIds = {},
): Promise<WorkItem> {
  const status = requireText(input.status, 'status');
  assertOneOf(status, WORK_ITEM_STATUSES, 'status');
  const current = await getWorkItem(db, input.projectId, input.id);
  if (!current) throw new Error('work item not found');
  if (TERMINAL_WORK_ITEM_STATUSES.has(current.status) && current.status !== status) {
    throw new Error(`work item ${input.id} is terminal (${current.status})`);
  }
  const t = nowMs(deps);
  const result = await db
    .prepare(
      `UPDATE work_items
          SET status=?, status_note=?, updated_by_type=?, updated_by_id=?, updated_at=?
        WHERE project_id=? AND id=?`,
    )
    .bind(status, maybeBody(input.statusNote), input.updatedByType, normalizeText(input.updatedById), t, input.projectId, input.id)
    .run();
  if (changes(result) !== 1) throw new Error('work item not found');
  const updated = await getWorkItem(db, input.projectId, input.id);
  if (!updated) throw new Error('updated work item could not be read back');
  return updated;
}

async function getWorkRun(db: D1Like, id: string): Promise<WorkRun | null> {
  const row = await db
    .prepare(
      `SELECT id, work_item_id, runner, attempt, status, dispatch_status, external_run_id, summary, error,
              dispatch_attempts, dispatched_at, last_dispatch_error, created_at, updated_at
         FROM work_runs WHERE id=?`,
    )
    .bind(id)
    .first<WorkRunRow>();
  return row ? rowToWorkRun(row) : null;
}

export async function createWorkRun(
  db: D1Like,
  input: { workItemId: string; runner: string; status?: string | null; dispatchStatus?: string | null; externalRunId?: string | null },
  deps: ClockAndIds = {},
): Promise<WorkRun> {
  const runner = requireText(input.runner, 'runner');
  assertOneOf(runner, WORK_RUNNERS, 'runner');
  const status = normalizeText(input.status) ?? 'pending';
  assertOneOf(status, WORK_RUN_STATUSES, 'status');
  const dispatchStatus = normalizeText(input.dispatchStatus) ?? 'pending';
  assertOneOf(dispatchStatus, DISPATCH_STATUSES, 'dispatchStatus');
  const max = await db
    .prepare('SELECT COALESCE(MAX(attempt), 0) AS max_attempt FROM work_runs WHERE work_item_id=?')
    .bind(input.workItemId)
    .first<{ max_attempt: number }>();
  const attempt = Number(max?.max_attempt ?? 0) + 1;
  const t = nowMs(deps);
  const id = makeId(deps);
  await db
    .prepare(
      `INSERT INTO work_runs(id, work_item_id, runner, attempt, status, dispatch_status, external_run_id,
                             summary, error, dispatch_attempts, dispatched_at, last_dispatch_error, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(id, input.workItemId, runner, attempt, status, dispatchStatus, normalizeText(input.externalRunId), null, null, 0, null, null, t, t)
    .run();
  const run = await getWorkRun(db, id);
  if (!run) throw new Error('created work run could not be read back');
  return run;
}

export async function updateWorkRun(
  db: D1Like,
  input: {
    id: string;
    status?: string | null;
    dispatchStatus?: string | null;
    externalRunId?: string | null;
    summary?: string | null;
    error?: string | null;
    dispatchAttemptIncrement?: number | null;
    dispatchedAt?: number | null;
    lastDispatchError?: string | null;
  },
  deps: ClockAndIds = {},
): Promise<WorkRun> {
  const current = await getWorkRun(db, input.id);
  if (!current) throw new Error('work run not found');
  const status = normalizeText(input.status) ?? current.status;
  assertOneOf(status, WORK_RUN_STATUSES, 'status');
  const dispatchStatus = normalizeText(input.dispatchStatus) ?? current.dispatchStatus;
  assertOneOf(dispatchStatus, DISPATCH_STATUSES, 'dispatchStatus');
  const t = nowMs(deps);
  const result = await db
    .prepare(
      `UPDATE work_runs
          SET status=?, dispatch_status=?, external_run_id=?, summary=?, error=?,
              dispatch_attempts=dispatch_attempts+?, dispatched_at=?, last_dispatch_error=?, updated_at=?
        WHERE id=?`,
    )
    .bind(
      status,
      dispatchStatus,
      input.externalRunId === undefined ? current.externalRunId : normalizeText(input.externalRunId),
      input.summary === undefined ? current.summary : maybeBody(input.summary),
      input.error === undefined ? current.error : maybeBody(input.error),
      Number(input.dispatchAttemptIncrement ?? 0),
      input.dispatchedAt === undefined ? current.dispatchedAt : input.dispatchedAt,
      input.lastDispatchError === undefined ? current.lastDispatchError : maybeBody(input.lastDispatchError),
      t,
      input.id,
    )
    .run();
  if (changes(result) !== 1) throw new Error('work run not found');
  const updated = await getWorkRun(db, input.id);
  if (!updated) throw new Error('updated work run could not be read back');
  return updated;
}

export async function registerArtifactRef(
  db: D1Like,
  input: {
    projectId: string;
    workItemId?: string | null;
    sourceProvider: string;
    sourceId?: string | null;
    filename: string;
    mimeType?: string | null;
    sizeBytes?: number | null;
    storageRef?: string | null;
    sha256?: string | null;
    status?: string | null;
    summary?: string | null;
  },
  deps: ClockAndIds = {},
): Promise<ArtifactRef> {
  const projectId = requireText(input.projectId, 'projectId');
  const workItemId = normalizeText(input.workItemId);
  if (workItemId) {
    const item = await getWorkItemById(db, workItemId);
    if (!item || item.projectId !== projectId) throw new Error('workItemId must refer to a work item in the same project');
  }
  const status = normalizeText(input.status) ?? 'registered';
  assertOneOf(status, ARTIFACT_STATUSES, 'status');
  const t = nowMs(deps);
  const id = makeId(deps);
  await db
    .prepare(
      `INSERT INTO artifact_refs(id, project_id, work_item_id, source_provider, source_id, filename, mime_type,
                                 size_bytes, storage_ref, sha256, status, summary, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      id,
      projectId,
      workItemId,
      requireText(input.sourceProvider, 'sourceProvider'),
      normalizeText(input.sourceId),
      requireText(input.filename, 'filename'),
      normalizeText(input.mimeType),
      input.sizeBytes ?? null,
      normalizeText(input.storageRef),
      normalizeText(input.sha256),
      status,
      maybeBody(input.summary),
      t,
      t,
    )
    .run();
  return {
    id,
    projectId,
    workItemId,
    sourceProvider: requireText(input.sourceProvider, 'sourceProvider'),
    sourceId: normalizeText(input.sourceId),
    filename: requireText(input.filename, 'filename'),
    mimeType: normalizeText(input.mimeType),
    sizeBytes: input.sizeBytes ?? null,
    storageRef: normalizeText(input.storageRef),
    sha256: normalizeText(input.sha256),
    status,
    summary: maybeBody(input.summary),
    createdAt: t,
    updatedAt: t,
  };
}
