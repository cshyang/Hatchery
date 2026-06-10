import type { FlueContext, FlueEvent } from '@flue/runtime';
import { parseAgentInstanceId } from '../project/bindings';
import type { D1Like } from '../skills/repository';
import { editMessage } from './post';

export type SlackTurnActivityStatus = 'active' | 'completed' | 'failed';
export type SlackActivityItemStatus = 'running' | 'completed' | 'failed';

export interface SlackActivityItem {
  label: string;
  count: number;
  status: SlackActivityItemStatus;
  firstAt: number;
  lastAt: number;
}

export interface SlackTurnActivity {
  projectId: string;
  sessionId: string;
  conversationId: string;
  slackChannelId: string;
  slackThreadTs: string;
  ackMessageTs: string;
  transportTokenRef: string;
  status: SlackTurnActivityStatus;
  activities: SlackActivityItem[];
  lastPostedAt: number | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface CreateSlackTurnActivityInput {
  projectId: string;
  sessionId: string;
  conversationId: string;
  slackChannelId: string;
  slackThreadTs: string;
  ackMessageTs: string;
  transportTokenRef: string;
  now?: number;
}

export interface RecordSlackToolActivityInput {
  projectId: string;
  sessionId: string;
  toolName: string;
  isError?: boolean;
  terminal?: boolean;
  error?: unknown;
  now?: number;
}

interface RecordSlackActivityLabelInput {
  projectId: string;
  sessionId: string;
  label: string;
  isError?: boolean;
  terminal?: boolean;
  forcePost?: boolean;
  requireExistingActivity?: boolean;
  now?: number;
}

const POST_THROTTLE_MS = 1500;
const MAX_VISIBLE_ACTIVITY_ROWS = 6;
const STREAM_RESPONSE_LABEL = 'Receiving stream response';

export async function createSlackTurnActivity(db: D1Like, input: CreateSlackTurnActivityInput): Promise<SlackTurnActivity> {
  const now = input.now ?? Date.now();
  const row: SlackTurnActivity = {
    projectId: input.projectId,
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    slackChannelId: input.slackChannelId,
    slackThreadTs: input.slackThreadTs,
    ackMessageTs: input.ackMessageTs,
    transportTokenRef: input.transportTokenRef,
    status: 'active',
    activities: [],
    lastPostedAt: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
  await upsertActivity(db, row);
  return row;
}

export async function loadSlackTurnActivity(db: D1Like, projectId: string, sessionId: string): Promise<SlackTurnActivity | null> {
  const row = await db
    .prepare(
      `SELECT project_id, session_id, conversation_id, slack_channel_id, slack_thread_ts,
              ack_message_ts, transport_token_ref, status, activities_json,
              last_posted_at, created_at, updated_at, completed_at
         FROM slack_turn_activity
        WHERE project_id=? AND session_id=?`,
    )
    .bind(projectId, sessionId)
    .first<{
      project_id: string;
      session_id: string;
      conversation_id: string;
      slack_channel_id: string;
      slack_thread_ts: string;
      ack_message_ts: string;
      transport_token_ref: string;
      status: string;
      activities_json: string;
      last_posted_at: number | null;
      created_at: number;
      updated_at: number;
      completed_at: number | null;
    }>();
  return row ? mapRow(row) : null;
}

export async function recordSlackToolActivity(
  db: D1Like,
  input: RecordSlackToolActivityInput,
): Promise<{ activity: SlackTurnActivity; shouldPost: boolean } | null> {
  const label = toolActivityLabel(input.toolName);
  if (!label) return null;
  return recordSlackActivityLabel(db, { ...input, label });
}

async function recordSlackActivityLabel(
  db: D1Like,
  input: RecordSlackActivityLabelInput,
): Promise<{ activity: SlackTurnActivity; shouldPost: boolean } | null> {
  const activity = await loadSlackTurnActivity(db, input.projectId, input.sessionId);
  if (!activity || activity.status !== 'active') return null;
  if (input.requireExistingActivity && activity.activities.length === 0) return null;

  const now = input.now ?? Date.now();
  const existing = activity.activities.find((item) => item.label === input.label);
  const status = input.isError ? 'failed' : input.terminal ? 'completed' : 'running';

  if (existing) {
    existing.count += status === 'running' ? 1 : 0;
    existing.status = status === 'running' && existing.status === 'failed' ? existing.status : status;
    existing.lastAt = now;
  } else {
    activity.activities.push({ label: input.label, count: 1, status, firstAt: now, lastAt: now });
  }

  const shouldPost =
    activity.lastPostedAt == null || input.terminal === true || input.forcePost === true || now - activity.lastPostedAt >= POST_THROTTLE_MS;
  activity.lastPostedAt = shouldPost ? now : activity.lastPostedAt;
  activity.updatedAt = now;
  await upsertActivity(db, activity);
  return { activity, shouldPost };
}

export async function completeSlackTurnActivity(
  db: D1Like,
  projectId: string,
  sessionId: string,
  status: Extract<SlackTurnActivityStatus, 'completed' | 'failed'> = 'completed',
  now: number = Date.now(),
): Promise<SlackTurnActivity | null> {
  const activity = await loadSlackTurnActivity(db, projectId, sessionId);
  if (!activity) return null;
  activity.status = status;
  activity.updatedAt = now;
  activity.completedAt = now;
  activity.lastPostedAt = now;
  for (const item of activity.activities) {
    if (item.status === 'running') item.status = 'completed';
  }
  await upsertActivity(db, activity);
  return activity;
}

export async function shouldPostFinalBelowActivity(db: D1Like | undefined, projectId: string, sessionId: string): Promise<boolean> {
  if (!db) return false;
  const activity = await loadSlackTurnActivity(db, projectId, sessionId).catch(() => null);
  return !!activity && activity.activities.length > 0;
}

export async function postSlackActivityReceipt(env: Record<string, unknown>, activity: SlackTurnActivity): Promise<boolean> {
  const token = env[activity.transportTokenRef];
  if (typeof token !== 'string' || !token) return false;
  await editMessage(token, activity.slackChannelId, activity.ackMessageTs, renderSlackActivityReceipt(activity), { format: false });
  return true;
}

export async function handleObservedSlackActivity(event: FlueEvent, ctx: FlueContext): Promise<void> {
  try {
    const db = (ctx.env as Record<string, unknown>).DB as D1Like | undefined;
    if (!db) return;
    if (!event.instanceId) return;

    // On Flue 0.11 the conversation scope rides in the instance id (`.../conv:<id>`), not in
    // event.session (always 'default' now). slack_turn_activity.session_id keeps storing the
    // same `conv:...` strings as before.
    const { projectId, slug, scope } = parseAgentInstanceId(event.instanceId);
    if (slug !== 'default' || !scope?.startsWith('conv:')) return;

    const activityEvent = observedSlackActivityEvent(event);
    if (!activityEvent) return;

    const base = {
      projectId,
      sessionId: scope,
      isError: activityEvent.isError,
      terminal: activityEvent.terminal,
    };
    const recorded =
      'toolName' in activityEvent
        ? await recordSlackToolActivity(db, { ...base, toolName: activityEvent.toolName })
        : await recordSlackActivityLabel(db, {
            ...base,
            label: activityEvent.label,
            forcePost: activityEvent.forcePost,
            requireExistingActivity: activityEvent.requireExistingActivity,
          });
    if (!recorded?.shouldPost) return;
    await postSlackActivityReceipt(ctx.env as Record<string, unknown>, recorded.activity).catch((e) =>
      console.log(`[activity] receipt update failed: ${e instanceof Error ? e.message : 'error'}`),
    );
  } catch (e) {
    console.log(`[activity] observer ignored event: ${e instanceof Error ? e.message : 'error'}`);
  }
}

export function toolActivityLabel(toolName: string): string | null {
  if (toolName === 'execute_code') return 'Running code';
  if (toolName === 'setup_status') return 'Checking setup';
  if (toolName === 'request_connection') return 'Preparing connection link';
  if (toolName === 'search_channel') return 'Searching this channel';
  if (['save_memory', 'update_memory', 'forget_memory'].includes(toolName)) return 'Updating memory';
  if (toolName === 'github_call_api' || toolName.startsWith('github_')) return 'Reading GitHub';
  if (toolName === 'linear_call_api' || toolName.startsWith('linear_')) return 'Reading Linear';
  if (toolName === 'notion_call_api' || toolName.startsWith('notion_')) return 'Reading Notion';
  return null;
}

export function renderSlackActivityReceipt(activity: SlackTurnActivity, options: { now?: number } = {}): string {
  const heading = renderActivityHeading(activity, options.now ?? Date.now());
  const visible = activity.activities.slice(0, MAX_VISIBLE_ACTIVITY_ROWS);
  const rows = visible.map((item) => {
    const failed = item.status === 'failed' ? ' — failed' : '';
    const count = item.count > 1 ? ` (x${item.count})` : '';
    return `• ${item.label}${count}${failed}`;
  });
  const hidden = activity.activities.length - visible.length;
  if (hidden > 0) rows.push(`• +${hidden} more`);
  return `${heading}\n${rows.join('\n')}`.trim();
}

function renderActivityHeading(activity: SlackTurnActivity, now: number): string {
  const elapsed = formatActivityElapsed(activity.createdAt, activity.completedAt ?? now);
  if (activity.status === 'active') {
    const phase = currentActivityPhase(activity);
    return `⏳ Working — ${elapsed}${phase ? ` — ${phase}` : ''}`;
  }
  return `${activity.status === 'failed' ? '⚠️' : '✅'} Activity — ${elapsed}`;
}

function currentActivityPhase(activity: SlackTurnActivity): string | null {
  const latestRunning = [...activity.activities].reverse().find((item) => item.status === 'running');
  const latest = latestRunning ?? activity.activities[activity.activities.length - 1];
  if (!latest) return null;
  return lowerFirst(latest.label);
}

function lowerFirst(value: string): string {
  return value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
}

function formatActivityElapsed(startMs: number, endMs: number): string {
  const elapsedMs = Math.max(0, endMs - startMs);
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 1) return '<1 min';
  if (elapsedMinutes < 60) return `${elapsedMinutes} min`;

  const hours = Math.floor(elapsedMinutes / 60);
  const minutes = elapsedMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

async function upsertActivity(db: D1Like, activity: SlackTurnActivity): Promise<void> {
  await db
    .prepare(
      `INSERT INTO slack_turn_activity(
         project_id, session_id, conversation_id, slack_channel_id, slack_thread_ts,
         ack_message_ts, transport_token_ref, status, activities_json,
         last_posted_at, created_at, updated_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, session_id) DO UPDATE SET
         conversation_id=excluded.conversation_id,
         slack_channel_id=excluded.slack_channel_id,
         slack_thread_ts=excluded.slack_thread_ts,
         ack_message_ts=excluded.ack_message_ts,
         transport_token_ref=excluded.transport_token_ref,
         status=excluded.status,
         activities_json=excluded.activities_json,
         last_posted_at=excluded.last_posted_at,
         updated_at=excluded.updated_at,
         completed_at=excluded.completed_at`,
    )
    .bind(
      activity.projectId,
      activity.sessionId,
      activity.conversationId,
      activity.slackChannelId,
      activity.slackThreadTs,
      activity.ackMessageTs,
      activity.transportTokenRef,
      activity.status,
      JSON.stringify(activity.activities),
      activity.lastPostedAt,
      activity.createdAt,
      activity.updatedAt,
      activity.completedAt,
    )
    .run();
}

function mapRow(row: {
  project_id: string;
  session_id: string;
  conversation_id: string;
  slack_channel_id: string;
  slack_thread_ts: string;
  ack_message_ts: string;
  transport_token_ref: string;
  status: string;
  activities_json: string;
  last_posted_at: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}): SlackTurnActivity {
  return {
    projectId: row.project_id,
    sessionId: row.session_id,
    conversationId: row.conversation_id,
    slackChannelId: row.slack_channel_id,
    slackThreadTs: row.slack_thread_ts,
    ackMessageTs: row.ack_message_ts,
    transportTokenRef: row.transport_token_ref,
    status: row.status === 'completed' || row.status === 'failed' ? row.status : 'active',
    activities: parseActivities(row.activities_json),
    lastPostedAt: row.last_posted_at == null ? null : Number(row.last_posted_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    completedAt: row.completed_at == null ? null : Number(row.completed_at),
  };
}

function parseActivities(value: string): SlackActivityItem[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item.label === 'string')
      .map((item) => ({
        label: String(item.label),
        count: Math.max(1, Number(item.count) || 1),
        status: item.status === 'failed' || item.status === 'completed' ? item.status : 'running',
        firstAt: Number(item.firstAt) || 0,
        lastAt: Number(item.lastAt) || 0,
      }));
  } catch {
    return [];
  }
}

type ObservedSlackActivityEvent =
  | { toolName: string; isError?: boolean; terminal?: boolean }
  | { label: string; isError?: boolean; terminal?: boolean; forcePost?: boolean; requireExistingActivity?: boolean };

function observedSlackActivityEvent(event: FlueEvent): ObservedSlackActivityEvent | null {
  if (event.type === 'tool_start') {
    return { toolName: event.toolName };
  }
  if (event.type === 'tool_call' && event.isError) {
    return { toolName: event.toolName, isError: true, terminal: true };
  }
  if (event.type === 'message_start') {
    return { label: STREAM_RESPONSE_LABEL, requireExistingActivity: true, forcePost: true };
  }
  return null;
}
