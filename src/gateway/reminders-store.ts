// D1-backed reminder store — the SchedulerDO's jobs table moved in-house (Flue 0.11
// hosts its own cron, so the external ticker worker is retired). The agent's reminder
// tools write here; the minutely scheduled scan calls takeDueReminders and fires each
// row through the existing /__internal/scheduled route (KV fireId dedupe and the
// active-binding gate live there, unchanged).

import type { D1Like } from '../skills/repository';
import { isValidCron, nextCron, KL_OFFSET_MIN } from './cron';

export interface ReminderArgs {
  id: string;
  kind?: string;
  /** Recurring at wall-clock times, e.g. "0 9 * * *" (interpreted in KL / UTC+8). */
  cron?: string;
  /** One-shot, relative: fire once this many ms from now. */
  inMs?: number;
  /** One-shot, absolute: fire once at this epoch-ms time. */
  runAt?: number;
  /** Recurring: fire every this many ms (first run one interval from now). */
  everyMs?: number;
  payload?: Record<string, unknown>;
}

export interface ReminderRow {
  id: string;
  project_id: string;
  kind: string;
  cron: string | null;
  every_ms: number | null;
  next_run: number;
  payload: string;
  enabled: number;
}

/** A due reminder claimed for firing. fireId is stable per (project, id, scheduled time)
 *  so alarm/scan retries dedupe in KV exactly as the SchedulerDO's fires did. */
export interface DueReminder {
  fireId: string;
  projectId: string;
  jobId: string;
  kind: string;
  payload: Record<string, unknown>;
}

// First fire time for a new/updated reminder. Precedence: cron > runAt > inMs > everyMs > now.
function firstRun(now: number, args: ReminderArgs): number {
  if (args.cron) {
    if (!isValidCron(args.cron)) throw new Error(`invalid cron: "${args.cron}"`);
    const t = nextCron(args.cron, now, KL_OFFSET_MIN);
    if (t < 0) throw new Error(`cron has no upcoming run within a year: "${args.cron}"`);
    return t;
  }
  if (typeof args.runAt === 'number') return args.runAt;
  if (typeof args.inMs === 'number') return now + args.inMs;
  if (typeof args.everyMs === 'number') return now + args.everyMs;
  return now;
}

/** Add or replace a reminder. Reusing an id updates it in place; a new id adds one. */
export async function upsertReminder(
  db: D1Like,
  projectId: string,
  args: ReminderArgs,
  now: number = Date.now(),
): Promise<{ id: string; nextRun: number }> {
  if (!args?.id) throw new Error('a reminder requires an id');
  const nextRun = firstRun(now, args);
  await db
    .prepare(
      `INSERT INTO reminders (id, project_id, kind, cron, every_ms, next_run, payload, enabled, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,1,?,?)
       ON CONFLICT(project_id, id) DO UPDATE SET
         kind=excluded.kind, cron=excluded.cron, every_ms=excluded.every_ms,
         next_run=excluded.next_run, payload=excluded.payload, enabled=1, updated_at=excluded.updated_at`,
    )
    .bind(
      args.id,
      projectId,
      args.kind ?? 'heartbeat',
      args.cron ?? null,
      typeof args.everyMs === 'number' ? args.everyMs : null,
      nextRun,
      JSON.stringify(args.payload ?? {}),
      now,
      now,
    )
    .run();
  return { id: args.id, nextRun };
}

export async function listReminders(db: D1Like, projectId: string): Promise<ReminderRow[]> {
  const res = await db
    .prepare('SELECT * FROM reminders WHERE project_id=? ORDER BY next_run')
    .bind(projectId)
    .all<ReminderRow>();
  return res.results ?? [];
}

export async function cancelReminder(db: D1Like, projectId: string, id: string): Promise<void> {
  await db.prepare('DELETE FROM reminders WHERE project_id=? AND id=?').bind(projectId, id).run();
}

export async function setReminderEnabled(
  db: D1Like,
  projectId: string,
  id: string,
  enabled: boolean,
): Promise<{ found: boolean }> {
  const cur = await db
    .prepare('SELECT COUNT(*) AS n FROM reminders WHERE project_id=? AND id=?')
    .bind(projectId, id)
    .all<{ n: number }>();
  await db
    .prepare('UPDATE reminders SET enabled=?, updated_at=? WHERE project_id=? AND id=?')
    .bind(enabled ? 1 : 0, Date.now(), projectId, id)
    .run();
  return { found: (cur.results?.[0]?.n ?? 0) > 0 };
}

/** Claim all due reminders: advance each row past its fire (recurring) or delete it
 *  (one-shot) BEFORE returning it, using next_run as a compare-and-swap so overlapping
 *  scans can't double-claim. A claimed-but-failed fire is the same v1 tradeoff the
 *  SchedulerDO made: a one-shot is lost, a recurring fires again next interval —
 *  and the KV fireId claim downstream dedupes genuine retries. */
export async function takeDueReminders(db: D1Like, now: number = Date.now()): Promise<DueReminder[]> {
  const res = await db
    .prepare('SELECT * FROM reminders WHERE enabled=1 AND next_run<=? ORDER BY next_run LIMIT 50')
    .bind(now)
    .all<ReminderRow>();
  const due = res.results ?? [];
  const claimed: DueReminder[] = [];

  for (const row of due) {
    // D1's run() reports meta.changes; D1Like types it as unknown, so narrow here.
    let advanced: unknown;
    if (row.cron) {
      const next = nextCron(row.cron, now, KL_OFFSET_MIN);
      advanced =
        next < 0
          ? await db
              .prepare('DELETE FROM reminders WHERE project_id=? AND id=? AND next_run=?')
              .bind(row.project_id, row.id, row.next_run)
              .run()
          : await db
              .prepare('UPDATE reminders SET next_run=?, updated_at=? WHERE project_id=? AND id=? AND next_run=?')
              .bind(next, now, row.project_id, row.id, row.next_run)
              .run();
    } else if (row.every_ms != null) {
      // Step from now (not next_run) so a long outage can't create a backlog.
      advanced = await db
        .prepare('UPDATE reminders SET next_run=?, updated_at=? WHERE project_id=? AND id=? AND next_run=?')
        .bind(now + row.every_ms, now, row.project_id, row.id, row.next_run)
        .run();
    } else {
      advanced = await db
        .prepare('DELETE FROM reminders WHERE project_id=? AND id=? AND next_run=?')
        .bind(row.project_id, row.id, row.next_run)
        .run();
    }
    const changes = (advanced as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0;
    if (changes === 0) continue; // lost the CAS race — another scan claimed it

    claimed.push({
      fireId: `${row.project_id}:${row.id}:${row.next_run}`,
      projectId: row.project_id,
      jobId: row.id,
      kind: row.kind,
      payload: safeParse(row.payload),
    });
  }
  return claimed;
}

function safeParse(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
