// Burst-absorb (docs/planning/burst-absorb.md): a message arriving while its conversation's
// turn is mid-flight parks in pending_messages instead of dispatching a redundant turn. The
// in-flight turn drains the lot at reply time (drain-before-post → one combined answer); the
// reconcile sweep is the safety net for stragglers and turns that died holding parked rows.
//
// Flue 0.11 forces this shape: the per-instance queue has no app-facing skip/merge, and the
// initializer never sees dispatched input — so the only cheap seams are the gateway (before a
// message enters the queue) and our own reply tool.

import type { D1Like } from '../skills/repository';
import { loadSlackTurnActivity, TURN_DOA_STALE_MS, type SlackTurnActivity } from './activity';

/** A turn absorbs only while it shows signs of life. Beats refresh updated_at on every tool
 *  call, so a healthy long turn stays absorbing; a corpse stops swallowing messages after the
 *  same window the reaper uses to presume it dead. */
export const ABSORB_FRESH_MS = TURN_DOA_STALE_MS;

/** Grace before the sweep claims a pending row — long enough for the in-flight drain to win
 *  the common race, short enough that a true straggler isn't left hanging. */
export const SWEEP_GRACE_MS = 30_000;

export interface PendingMessage {
  id: number;
  projectId: string;
  conversationId: string;
  senderId: string;
  text: string;
  slackTs: string;
  createdAt: number;
}

interface PendingRow {
  id: number;
  project_id: string;
  conversation_id: string;
  sender_id: string;
  text: string;
  slack_ts: string;
  created_at: number;
}

function mapRow(r: PendingRow): PendingMessage {
  return {
    id: r.id,
    projectId: r.project_id,
    conversationId: r.conversation_id,
    senderId: r.sender_id,
    text: r.text,
    slackTs: r.slack_ts,
    createdAt: r.created_at,
  };
}

/** The in-flight turn this conversation's new message should fold into — or null when there
 *  is none (no receipt, terminal receipt, or active-but-stale: presumed dead, don't absorb). */
export async function findAbsorbingTurn(
  db: D1Like,
  projectId: string,
  conversationId: string,
  now: number = Date.now(),
): Promise<SlackTurnActivity | null> {
  const activity = await loadSlackTurnActivity(db, projectId, `conv:${conversationId}`);
  if (!activity || activity.status !== 'active') return null;
  return now - activity.updatedAt < ABSORB_FRESH_MS ? activity : null;
}

export async function insertPendingMessage(
  db: D1Like,
  input: { projectId: string; conversationId: string; senderId: string; text: string; slackTs: string; now?: number },
): Promise<void> {
  const now = input.now ?? Date.now();
  await db
    .prepare(
      `INSERT INTO pending_messages(project_id, conversation_id, sender_id, text, slack_ts, status, created_at)
       VALUES(?,?,?,?,?,'pending',?)`,
    )
    .bind(input.projectId, input.conversationId, input.senderId, input.text, input.slackTs, now)
    .run();
}

/** Claim this conversation's parked messages for a consumer (the reply drain or the sweep).
 *  Claim-then-return: rows move to a terminal status atomically per id, so a message is
 *  delivered to exactly one consumer. Returns oldest-first. */
export async function claimPendingMessages(
  db: D1Like,
  projectId: string,
  conversationId: string,
  as: 'absorbed' | 'dispatched',
  now: number = Date.now(),
): Promise<PendingMessage[]> {
  const { results } = await db
    .prepare(
      `SELECT id, project_id, conversation_id, sender_id, text, slack_ts, created_at
         FROM pending_messages
        WHERE project_id=? AND conversation_id=? AND status='pending' ORDER BY id ASC`,
    )
    .bind(projectId, conversationId)
    .all<PendingRow>();
  const rows = results ?? [];
  if (rows.length === 0) return [];
  for (const row of rows) {
    await db
      .prepare(`UPDATE pending_messages SET status=?, claimed_at=? WHERE id=? AND status='pending'`)
      .bind(as, now, row.id)
      .run();
  }
  return rows.map(mapRow);
}

/** One line per parked message, sender-attributed, for handing back to the model. */
export function renderPendingMessages(messages: PendingMessage[]): string {
  return messages.map((m) => `[${m.senderId}]: ${m.text}`).join('\n');
}

/** The reply tool's drain-before-post check. Pending rows → claim them and return the notice
 *  the tool hands back INSTEAD of posting; null → clear to post. Never throws (a D1 hiccup
 *  must not block the reply — the sweep still nets anything missed). */
export async function drainNoticeForReply(
  db: D1Like | undefined,
  projectId: string,
  conversationId: string,
  now: number = Date.now(),
): Promise<string | null> {
  if (!db || !conversationId) return null;
  try {
    const pending = await claimPendingMessages(db, projectId, conversationId, 'absorbed', now);
    if (pending.length === 0) return null;
    return (
      `NOT SENT — ${pending.length} new message(s) arrived in this conversation while you worked:\n` +
      `${renderPendingMessages(pending)}\n` +
      `Revise your reply so ONE message addresses everything (the original request and the new messages), ` +
      `then call reply_to_conversation again.`
    );
  } catch {
    return null;
  }
}

/** Conversations holding pending rows old enough for the sweep to consider. */
export async function listStragglerConversations(
  db: D1Like,
  now: number = Date.now(),
  graceMs: number = SWEEP_GRACE_MS,
  limit = 20,
): Promise<Array<{ projectId: string; conversationId: string }>> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT project_id, conversation_id FROM pending_messages
        WHERE status='pending' AND created_at < ? LIMIT ?`,
    )
    .bind(now - graceMs, limit)
    .all<{ project_id: string; conversation_id: string }>();
  return (results ?? []).map((r) => ({ projectId: r.project_id, conversationId: r.conversation_id }));
}
