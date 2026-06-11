import type { D1Like } from '../skills/repository';

export const AGENT_RUN_PROVIDERS = ['linear', 'github', 'slack', 'runner', 'nango', 'unknown', 'hatchery'] as const;
export type AgentRunProvider = (typeof AGENT_RUN_PROVIDERS)[number];

export const AGENT_RUN_ACTOR_TYPES = ['human', 'hatchery', 'provider_bot', 'controller', 'runner', 'unknown'] as const;
export type AgentRunActorType = (typeof AGENT_RUN_ACTOR_TYPES)[number];

export const AGENT_RUN_HANDLINGS = ['record_only', 'notify', 'wake_controller'] as const;
export type AgentRunHandling = (typeof AGENT_RUN_HANDLINGS)[number];

export const AGENT_RUN_NOTIFICATION_CHANNELS = ['slack', 'linear'] as const;
export type AgentRunNotificationChannel = (typeof AGENT_RUN_NOTIFICATION_CHANNELS)[number];

export const AGENT_RUN_NOTIFICATION_STATUSES = ['pending', 'sent', 'failed'] as const;
export type AgentRunNotificationStatus = (typeof AGENT_RUN_NOTIFICATION_STATUSES)[number];

export const AGENT_RUN_ROUTE_PROVIDERS = ['linear', 'github', 'slack'] as const;
export type AgentRunRouteProvider = (typeof AGENT_RUN_ROUTE_PROVIDERS)[number];

export const AGENT_RUN_ROUTE_TRIGGER_TYPES = ['state', 'label', 'command'] as const;
export type AgentRunRouteTriggerType = (typeof AGENT_RUN_ROUTE_TRIGGER_TYPES)[number];

export const AGENT_RUN_ROUTE_STATUSES = ['pending', 'active', 'disabled'] as const;
export type AgentRunRouteStatus = (typeof AGENT_RUN_ROUTE_STATUSES)[number];

export const AGENT_RUN_ROUTE_CREATED_BY_TYPES = ['model', 'admin', 'system'] as const;
export type AgentRunRouteCreatedByType = (typeof AGENT_RUN_ROUTE_CREATED_BY_TYPES)[number];

const SUPPORTED_KITS = new Set(['coding-default']);
const SUPPORTED_RUNTIMES = new Set(['pi']);
const SUPPORTED_SANDBOX_PROVIDERS = new Set(['e2b']);

export interface ClockAndIds {
  id?: () => string;
  now?: () => number;
}

export interface AgentRunEvent {
  id: string;
  projectId: string;
  runId: string | null;
  provider: AgentRunProvider;
  eventType: string;
  providerDeliveryId: string | null;
  providerEntityId: string | null;
  dedupeKey: string;
  actorType: AgentRunActorType;
  handling: AgentRunHandling;
  handlingReason: string | null;
  payloadJson: string;
  occurredAt: number | null;
  receivedAt: number;
  processedAt: number | null;
  createdAt: number;
}

interface AgentRunEventRow {
  id: string;
  project_id: string;
  run_id: string | null;
  provider: AgentRunProvider;
  event_type: string;
  provider_delivery_id: string | null;
  provider_entity_id: string | null;
  dedupe_key: string;
  actor_type: AgentRunActorType;
  handling: AgentRunHandling;
  handling_reason: string | null;
  payload_json: string;
  occurred_at: number | null;
  received_at: number;
  processed_at: number | null;
  created_at: number;
}

export interface AgentRunNotification {
  id: string;
  projectId: string;
  runId: string;
  channel: AgentRunNotificationChannel;
  notificationType: string;
  dedupeKey: string;
  targetRef: string | null;
  status: AgentRunNotificationStatus;
  providerMessageId: string | null;
  error: string | null;
  createdAt: number;
  sentAt: number | null;
}

interface AgentRunNotificationRow {
  id: string;
  project_id: string;
  run_id: string;
  channel: AgentRunNotificationChannel;
  notification_type: string;
  dedupe_key: string;
  target_ref: string | null;
  status: AgentRunNotificationStatus;
  provider_message_id: string | null;
  error: string | null;
  created_at: number;
  sent_at: number | null;
}

export interface AgentRunRoute {
  id: string;
  projectId: string;
  provider: AgentRunRouteProvider;
  externalKey: string;
  triggerType: AgentRunRouteTriggerType;
  triggerValue: string;
  githubOwner: string;
  githubRepo: string;
  baseBranch: string;
  kit: string;
  runtime: string;
  sandboxProvider: string;
  priority: number;
  status: AgentRunRouteStatus;
  createdByType: AgentRunRouteCreatedByType;
  createdBy: string | null;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
  activatedBy: string | null;
  activatedAt: number | null;
  disabledBy: string | null;
  disabledAt: number | null;
}

interface AgentRunRouteRow {
  id: string;
  project_id: string;
  provider: AgentRunRouteProvider;
  external_key: string;
  trigger_type: AgentRunRouteTriggerType;
  trigger_value: string;
  github_owner: string;
  github_repo: string;
  base_branch: string;
  kit: string;
  runtime: string;
  sandbox_provider: string;
  priority: number;
  status: AgentRunRouteStatus;
  created_by_type: AgentRunRouteCreatedByType;
  created_by: string | null;
  reason: string | null;
  created_at: number;
  updated_at: number;
  activated_by: string | null;
  activated_at: number | null;
  disabled_by: string | null;
  disabled_at: number | null;
}

interface ConnectionRow {
  provider: string;
  config_json: string | null;
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

function maybeText(value: unknown, max = 2048): string | null {
  const s = normalizeText(value);
  if (!s) return null;
  if (s.length > max) throw new Error('text field is too long');
  return s;
}

function assertOneOf<T extends readonly string[]>(value: string, allowed: T, field: string): asserts value is T[number] {
  if (!allowed.includes(value)) throw new Error(`${field} "${value}" is invalid`);
}

function changes(result: unknown): number {
  const meta = (result as { meta?: { changes?: number } } | undefined)?.meta;
  return typeof meta?.changes === 'number' ? meta.changes : 0;
}

function eventRowToEvent(row: AgentRunEventRow): AgentRunEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    runId: row.run_id ?? null,
    provider: row.provider,
    eventType: row.event_type,
    providerDeliveryId: row.provider_delivery_id ?? null,
    providerEntityId: row.provider_entity_id ?? null,
    dedupeKey: row.dedupe_key,
    actorType: row.actor_type,
    handling: row.handling,
    handlingReason: row.handling_reason ?? null,
    payloadJson: row.payload_json,
    occurredAt: row.occurred_at == null ? null : Number(row.occurred_at),
    receivedAt: Number(row.received_at),
    processedAt: row.processed_at == null ? null : Number(row.processed_at),
    createdAt: Number(row.created_at),
  };
}

function notificationRowToNotification(row: AgentRunNotificationRow): AgentRunNotification {
  return {
    id: row.id,
    projectId: row.project_id,
    runId: row.run_id,
    channel: row.channel,
    notificationType: row.notification_type,
    dedupeKey: row.dedupe_key,
    targetRef: row.target_ref ?? null,
    status: row.status,
    providerMessageId: row.provider_message_id ?? null,
    error: row.error ?? null,
    createdAt: Number(row.created_at),
    sentAt: row.sent_at == null ? null : Number(row.sent_at),
  };
}

function routeRowToRoute(row: AgentRunRouteRow): AgentRunRoute {
  return {
    id: row.id,
    projectId: row.project_id,
    provider: row.provider,
    externalKey: row.external_key,
    triggerType: row.trigger_type,
    triggerValue: row.trigger_value,
    githubOwner: row.github_owner,
    githubRepo: row.github_repo,
    baseBranch: row.base_branch,
    kit: row.kit,
    runtime: row.runtime,
    sandboxProvider: row.sandbox_provider,
    priority: Number(row.priority),
    status: row.status,
    createdByType: row.created_by_type,
    createdBy: row.created_by ?? null,
    reason: row.reason ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    activatedBy: row.activated_by ?? null,
    activatedAt: row.activated_at == null ? null : Number(row.activated_at),
    disabledBy: row.disabled_by ?? null,
    disabledAt: row.disabled_at == null ? null : Number(row.disabled_at),
  };
}

async function getEventByDedupeKey(db: D1Like, dedupeKey: string): Promise<AgentRunEvent | null> {
  const row = await db
    .prepare(
      `SELECT id, project_id, run_id, provider, event_type, provider_delivery_id, provider_entity_id,
              dedupe_key, actor_type, handling, handling_reason, payload_json, occurred_at,
              received_at, processed_at, created_at
         FROM agent_run_events WHERE dedupe_key=?`,
    )
    .bind(dedupeKey)
    .first<AgentRunEventRow>();
  return row ? eventRowToEvent(row) : null;
}

async function getNotificationByDedupeKey(db: D1Like, dedupeKey: string): Promise<AgentRunNotification | null> {
  const row = await db
    .prepare(
      `SELECT id, project_id, run_id, channel, notification_type, dedupe_key, target_ref, status,
              provider_message_id, error, created_at, sent_at
         FROM agent_run_notifications WHERE dedupe_key=?`,
    )
    .bind(dedupeKey)
    .first<AgentRunNotificationRow>();
  return row ? notificationRowToNotification(row) : null;
}

export async function getAgentRunRoute(db: D1Like, id: string): Promise<AgentRunRoute | null> {
  const row = await db
    .prepare(
      `SELECT id, project_id, provider, external_key, trigger_type, trigger_value, github_owner, github_repo,
              base_branch, kit, runtime, sandbox_provider, priority, status, created_by_type, created_by,
              reason, created_at, updated_at, activated_by, activated_at, disabled_by, disabled_at
         FROM agent_run_routes WHERE id=?`,
    )
    .bind(id)
    .first<AgentRunRouteRow>();
  return row ? routeRowToRoute(row) : null;
}

export async function createAgentRunEvent(
  db: D1Like,
  input: {
    projectId: string;
    runId?: string | null;
    provider: string;
    eventType: string;
    providerDeliveryId?: string | null;
    providerEntityId?: string | null;
    dedupeKey: string;
    actorType?: string | null;
    handling?: string | null;
    handlingReason?: string | null;
    payload?: unknown;
    occurredAt?: number | null;
    processedAt?: number | null;
  },
  deps: ClockAndIds = {},
): Promise<{ event: AgentRunEvent; duplicate: boolean }> {
  const projectId = requireText(input.projectId, 'projectId', 256);
  const provider = requireText(input.provider, 'provider', 64);
  assertOneOf(provider, AGENT_RUN_PROVIDERS, 'provider');
  const actorType = normalizeText(input.actorType) ?? 'unknown';
  assertOneOf(actorType, AGENT_RUN_ACTOR_TYPES, 'actorType');
  const handling = normalizeText(input.handling) ?? 'record_only';
  assertOneOf(handling, AGENT_RUN_HANDLINGS, 'handling');
  const dedupeKey = requireText(input.dedupeKey, 'dedupeKey', 512);

  const existing = await getEventByDedupeKey(db, dedupeKey);
  if (existing) return { event: existing, duplicate: true };

  const id = makeId(deps);
  const t = nowMs(deps);
  const payloadJson = JSON.stringify(input.payload ?? {});
  await db
    .prepare(
      `INSERT INTO agent_run_events(id, project_id, run_id, provider, event_type, provider_delivery_id,
                                    provider_entity_id, dedupe_key, actor_type, handling, handling_reason,
                                    payload_json, occurred_at, received_at, processed_at, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      id,
      projectId,
      maybeText(input.runId, 256),
      provider,
      requireText(input.eventType, 'eventType', 128),
      maybeText(input.providerDeliveryId, 512),
      maybeText(input.providerEntityId, 512),
      dedupeKey,
      actorType,
      handling,
      maybeText(input.handlingReason, 1024),
      payloadJson,
      input.occurredAt ?? null,
      t,
      input.processedAt ?? null,
      t,
    )
    .run();

  const event = await getEventByDedupeKey(db, dedupeKey);
  if (!event) throw new Error('created agent run event could not be read back');
  return { event, duplicate: false };
}

export async function createAgentRunNotification(
  db: D1Like,
  input: {
    projectId: string;
    runId: string;
    channel: string;
    notificationType: string;
    dedupeKey: string;
    targetRef?: string | null;
    status?: string | null;
    providerMessageId?: string | null;
    error?: string | null;
    sentAt?: number | null;
  },
  deps: ClockAndIds = {},
): Promise<{ notification: AgentRunNotification; duplicate: boolean }> {
  const projectId = requireText(input.projectId, 'projectId', 256);
  const channel = requireText(input.channel, 'channel', 64);
  assertOneOf(channel, AGENT_RUN_NOTIFICATION_CHANNELS, 'channel');
  const status = normalizeText(input.status) ?? 'pending';
  assertOneOf(status, AGENT_RUN_NOTIFICATION_STATUSES, 'status');
  const dedupeKey = requireText(input.dedupeKey, 'dedupeKey', 512);

  const existing = await getNotificationByDedupeKey(db, dedupeKey);
  if (existing) return { notification: existing, duplicate: true };

  const id = makeId(deps);
  const t = nowMs(deps);
  await db
    .prepare(
      `INSERT INTO agent_run_notifications(id, project_id, run_id, channel, notification_type, dedupe_key,
                                           target_ref, status, provider_message_id, error, created_at, sent_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      id,
      projectId,
      requireText(input.runId, 'runId', 256),
      channel,
      requireText(input.notificationType, 'notificationType', 128),
      dedupeKey,
      maybeText(input.targetRef, 1024),
      status,
      maybeText(input.providerMessageId, 512),
      maybeText(input.error, 2048),
      t,
      input.sentAt ?? null,
    )
    .run();

  const notification = await getNotificationByDedupeKey(db, dedupeKey);
  if (!notification) throw new Error('created agent run notification could not be read back');
  return { notification, duplicate: false };
}

export async function createAgentRunChannelNotifications(
  db: D1Like,
  input: {
    projectId: string;
    runId: string;
    notificationType: string;
    linearTargetRef?: string | null;
    slackTargetRef?: string | null;
  },
  deps: ClockAndIds = {},
): Promise<{
  linear: { notification: AgentRunNotification; duplicate: boolean };
  slack: { notification: AgentRunNotification; duplicate: boolean };
}> {
  const projectId = requireText(input.projectId, 'projectId', 256);
  const runId = requireText(input.runId, 'runId', 256);
  const notificationType = requireText(input.notificationType, 'notificationType', 128);
  const linear = await createAgentRunNotification(
    db,
    {
      projectId,
      runId,
      channel: 'linear',
      notificationType,
      dedupeKey: `notify:${runId}:${notificationType}:linear`,
      targetRef: input.linearTargetRef ?? null,
      status: 'pending',
    },
    deps,
  );
  const slack = await createAgentRunNotification(
    db,
    {
      projectId,
      runId,
      channel: 'slack',
      notificationType,
      dedupeKey: `notify:${runId}:${notificationType}:slack`,
      targetRef: input.slackTargetRef ?? null,
      status: 'pending',
    },
    deps,
  );
  return { linear, slack };
}

async function activeConnection(db: D1Like, projectId: string, provider: string): Promise<ConnectionRow | null> {
  return db
    .prepare('SELECT provider, config_json FROM connections WHERE project_id=? AND provider=? AND status=\'active\'')
    .bind(projectId, provider)
    .first<ConnectionRow>();
}

function parseConfig(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function repoAllowed(config: Record<string, unknown>, repo: string): boolean {
  const configuredRepo = typeof config.repo === 'string' ? config.repo.trim() : '';
  if (configuredRepo) return configuredRepo === repo;
  const allowedRepos = Array.isArray(config.allowedRepos) ? config.allowedRepos : [];
  if (allowedRepos.length) return allowedRepos.some((value) => String(value).trim() === repo);
  return true;
}

async function validateRouteConnections(db: D1Like, input: { projectId: string; provider: string; githubOwner: string; githubRepo: string }) {
  if (!(await activeConnection(db, input.projectId, input.provider))) {
    throw new Error(`${input.provider} provider is not connected for this project`);
  }
  const github = await activeConnection(db, input.projectId, 'github');
  if (!github) throw new Error('github provider is not connected for this project');
  const repo = `${input.githubOwner}/${input.githubRepo}`;
  if (!repoAllowed(parseConfig(github.config_json), repo)) throw new Error('target repo is not allowed for this project');
}

function assertSupportedRouteRuntime(input: { kit: string; runtime: string; sandboxProvider: string }) {
  if (!SUPPORTED_KITS.has(input.kit)) throw new Error(`kit "${input.kit}" is not supported`);
  if (!SUPPORTED_RUNTIMES.has(input.runtime)) throw new Error(`runtime "${input.runtime}" is not supported`);
  if (!SUPPORTED_SANDBOX_PROVIDERS.has(input.sandboxProvider)) throw new Error(`sandboxProvider "${input.sandboxProvider}" is not supported`);
}

export async function createAgentRunRoute(
  db: D1Like,
  input: {
    projectId: string;
    provider: string;
    externalKey: string;
    triggerType: string;
    triggerValue: string;
    githubOwner: string;
    githubRepo: string;
    baseBranch?: string | null;
    kit?: string | null;
    runtime?: string | null;
    sandboxProvider?: string | null;
    priority?: number | null;
    reason: string;
    createdByType?: string | null;
    createdBy?: string | null;
  },
  deps: ClockAndIds = {},
): Promise<AgentRunRoute> {
  const projectId = requireText(input.projectId, 'projectId', 256);
  const provider = requireText(input.provider, 'provider', 64);
  assertOneOf(provider, AGENT_RUN_ROUTE_PROVIDERS, 'provider');
  const triggerType = requireText(input.triggerType, 'triggerType', 64);
  assertOneOf(triggerType, AGENT_RUN_ROUTE_TRIGGER_TYPES, 'triggerType');
  const createdByType = normalizeText(input.createdByType) ?? 'model';
  assertOneOf(createdByType, AGENT_RUN_ROUTE_CREATED_BY_TYPES, 'createdByType');
  const githubOwner = requireText(input.githubOwner, 'githubOwner', 128);
  const githubRepo = requireText(input.githubRepo, 'githubRepo', 128);
  const kit = normalizeText(input.kit) ?? 'coding-default';
  const runtime = normalizeText(input.runtime) ?? 'pi';
  const sandboxProvider = normalizeText(input.sandboxProvider) ?? 'e2b';
  assertSupportedRouteRuntime({ kit, runtime, sandboxProvider });
  await validateRouteConnections(db, { projectId, provider, githubOwner, githubRepo });

  const id = makeId(deps);
  const t = nowMs(deps);
  await db
    .prepare(
      `INSERT INTO agent_run_routes(id, project_id, provider, external_key, trigger_type, trigger_value,
                                    github_owner, github_repo, base_branch, kit, runtime, sandbox_provider,
                                    priority, status, created_by_type, created_by, reason, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      id,
      projectId,
      provider,
      requireText(input.externalKey, 'externalKey', 256),
      triggerType,
      requireText(input.triggerValue, 'triggerValue', 256),
      githubOwner,
      githubRepo,
      normalizeText(input.baseBranch) ?? 'main',
      kit,
      runtime,
      sandboxProvider,
      Number(input.priority ?? 0),
      'pending',
      createdByType,
      maybeText(input.createdBy, 256),
      requireText(input.reason, 'reason', 1024),
      t,
      t,
    )
    .run();

  const route = await getAgentRunRoute(db, id);
  if (!route) throw new Error('created agent run route could not be read back');
  return route;
}

export async function findActiveAgentRunRoute(
  db: D1Like,
  input: { provider: string; externalKey: string; triggerType: string; triggerValue: string },
): Promise<AgentRunRoute | null> {
  const provider = requireText(input.provider, 'provider', 64);
  assertOneOf(provider, AGENT_RUN_ROUTE_PROVIDERS, 'provider');
  const triggerType = requireText(input.triggerType, 'triggerType', 64);
  assertOneOf(triggerType, AGENT_RUN_ROUTE_TRIGGER_TYPES, 'triggerType');
  const row = await db
    .prepare(
      `SELECT id, project_id, provider, external_key, trigger_type, trigger_value, github_owner, github_repo,
              base_branch, kit, runtime, sandbox_provider, priority, status, created_by_type, created_by,
              reason, created_at, updated_at, activated_by, activated_at, disabled_by, disabled_at
         FROM agent_run_routes
        WHERE provider=? AND external_key=? AND trigger_type=? AND trigger_value=? AND status='active'
        ORDER BY priority DESC, activated_at DESC, created_at DESC
        LIMIT 1`,
    )
    .bind(provider, requireText(input.externalKey, 'externalKey', 256), triggerType, requireText(input.triggerValue, 'triggerValue', 256))
    .first<AgentRunRouteRow>();
  return row ? routeRowToRoute(row) : null;
}

/** The project's standing run authority: its highest-priority ACTIVE route, regardless of trigger.
 *  The assigner tool reads repo/kit from here — an admin-activated route IS the grant that lets the
 *  channel agent send coding runs at that repo; no route, no assigning. */
export async function findActiveRouteForProject(db: D1Like, projectId: string): Promise<AgentRunRoute | null> {
  const row = await db
    .prepare(
      `SELECT id, project_id, provider, external_key, trigger_type, trigger_value, github_owner, github_repo,
              base_branch, kit, runtime, sandbox_provider, priority, status, created_by_type, created_by,
              reason, created_at, updated_at, activated_by, activated_at, disabled_by, disabled_at
         FROM agent_run_routes
        WHERE project_id=? AND status='active'
        ORDER BY priority DESC, activated_at DESC, created_at DESC
        LIMIT 1`,
    )
    .bind(requireText(projectId, 'projectId', 256))
    .first<AgentRunRouteRow>();
  return row ? routeRowToRoute(row) : null;
}

export async function activateAgentRunRoute(db: D1Like, id: string, activatedBy: string, deps: ClockAndIds = {}): Promise<AgentRunRoute> {
  const route = await getAgentRunRoute(db, requireText(id, 'id', 256));
  if (!route) throw new Error('agent run route not found');
  if (route.status === 'active') return route;
  const conflict = await findActiveAgentRunRoute(db, {
    provider: route.provider,
    externalKey: route.externalKey,
    triggerType: route.triggerType,
    triggerValue: route.triggerValue,
  });
  if (conflict && conflict.id !== route.id) throw new Error('conflicting active route already exists');
  const t = nowMs(deps);
  const result = await db
    .prepare('UPDATE agent_run_routes SET status=\'active\', activated_by=?, activated_at=?, updated_at=? WHERE id=?')
    .bind(requireText(activatedBy, 'activatedBy', 256), t, t, route.id)
    .run();
  if (changes(result) !== 1) throw new Error('agent run route not found');
  const updated = await getAgentRunRoute(db, route.id);
  if (!updated) throw new Error('activated agent run route could not be read back');
  return updated;
}

export async function disableAgentRunRoute(db: D1Like, id: string, disabledBy: string, deps: ClockAndIds = {}): Promise<AgentRunRoute> {
  const route = await getAgentRunRoute(db, requireText(id, 'id', 256));
  if (!route) throw new Error('agent run route not found');
  if (route.status === 'disabled') return route;
  const t = nowMs(deps);
  const result = await db
    .prepare('UPDATE agent_run_routes SET status=\'disabled\', disabled_by=?, disabled_at=?, updated_at=? WHERE id=?')
    .bind(requireText(disabledBy, 'disabledBy', 256), t, t, route.id)
    .run();
  if (changes(result) !== 1) throw new Error('agent run route not found');
  const updated = await getAgentRunRoute(db, route.id);
  if (!updated) throw new Error('disabled agent run route could not be read back');
  return updated;
}
