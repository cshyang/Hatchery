// SchedulerDO — the durable timer Flue can't host itself.
//
// Flue abstracts the Durable Object away: `createAgent` never hands you `this`,
// and `Agent.schedule()` needs a `keyof this` callback method you can't add — so
// the agent's own DO alarm is unreachable. We put the alarm HERE instead, in a
// plain Worker where DOs behave normally. The agent calls a `schedule_self` tool;
// that tool POSTs this worker; this DO holds the per-project job table and a single
// alarm armed to the soonest job. When Flue ships first-class scheduling, this DO
// collapses back into the agent's own DO and we delete it — the tool contract is
// designed to survive that swap.
//
// One instance per project (getByName(projectId)) — matches Hatchery's
// DO-per-project tenancy. Cloudflare gives one alarm per DO, so we multiplex:
// many jobs in the table, the alarm points at min(next_run), and `alarm()` fires
// all due jobs then re-arms to the next-soonest (the agents-SDK / Hermes pattern).

import { DurableObject } from 'cloudflare:workers';

interface Env {
  HATCHERY: { fetch(request: Request): Promise<Response> };
  HEARTBEAT_TOKEN: string;
}

interface EnqueueArgs {
  id: string;
  kind?: string;
  /** One-shot, relative: fire once this many ms from now. */
  inMs?: number;
  /** One-shot, absolute: fire once at this epoch-ms time. */
  runAt?: number;
  /** Recurring: fire every this many ms (first run one interval from now). */
  everyMs?: number;
  payload?: Record<string, unknown>;
}

interface JobRow {
  id: string;
  project_id: string;
  kind: string;
  every_ms: number | null;
  next_run: number;
  payload: string;
  enabled: number;
}

export class SchedulerDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS jobs(
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        every_ms INTEGER,
        next_run INTEGER NOT NULL,
        payload TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1
      )`);
    });
  }

  // Add or replace a schedule. Reusing an `id` updates that job in place;
  // a new `id` adds one. Timing precedence: runAt > inMs > everyMs > now.
  async enqueue(projectId: string, args: EnqueueArgs): Promise<{ id: string; nextRun: number }> {
    if (!args?.id) throw new Error('enqueue requires an id');
    const now = Date.now();
    const nextRun =
      typeof args.runAt === 'number' ? args.runAt
      : typeof args.inMs === 'number' ? now + args.inMs
      : typeof args.everyMs === 'number' ? now + args.everyMs
      : now;
    const everyMs = typeof args.everyMs === 'number' ? args.everyMs : null;
    this.sql.exec(
      `INSERT INTO jobs(id, project_id, kind, every_ms, next_run, payload, enabled)
       VALUES(?,?,?,?,?,?,1)
       ON CONFLICT(id) DO UPDATE SET
         project_id=excluded.project_id, kind=excluded.kind, every_ms=excluded.every_ms,
         next_run=excluded.next_run, payload=excluded.payload, enabled=1`,
      args.id,
      projectId,
      args.kind ?? 'heartbeat',
      everyMs,
      nextRun,
      JSON.stringify(args.payload ?? {}),
    );
    await this.rearm();
    return { id: args.id, nextRun };
  }

  async list(): Promise<JobRow[]> {
    return this.sql.exec<JobRow>('SELECT * FROM jobs ORDER BY next_run').toArray();
  }

  async cancel(id: string): Promise<{ cancelled: string }> {
    this.sql.exec('DELETE FROM jobs WHERE id=?', id);
    await this.rearm();
    return { cancelled: id };
  }

  // Point the single physical alarm at the soonest enabled job (or clear it).
  private async rearm(): Promise<void> {
    const row = this.sql.exec<{ m: number | null }>('SELECT MIN(next_run) AS m FROM jobs WHERE enabled=1').one();
    if (row.m == null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(row.m);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const due = this.sql.exec<JobRow>('SELECT * FROM jobs WHERE enabled=1 AND next_run<=?', now).toArray();
    for (const job of due) {
      await this.fire(job);
      if (job.every_ms != null) {
        // Step from now (not next_run) so a long hibernation can't create a backlog.
        this.sql.exec('UPDATE jobs SET next_run=? WHERE id=?', now + job.every_ms, job.id);
      } else {
        this.sql.exec('DELETE FROM jobs WHERE id=?', job.id);
      }
    }
    await this.rearm();
  }

  // Poke Hatchery to run the job. fireId makes the dispatch idempotent against
  // alarm retries (Hatchery dedups it via KV). Errors are logged, not thrown:
  // a thrown alarm() retries the whole batch. v1 tradeoff — a hard failure here
  // loses a one-shot; acceptable for now, revisit with a retry/dead-letter later.
  private async fire(job: JobRow): Promise<void> {
    const fireId = `${job.project_id}:${job.id}:${job.next_run}`;
    try {
      const res = await this.env.HATCHERY.fetch(
        new Request('https://hatchery.internal/__internal/scheduled', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-hatchery-token': this.env.HEARTBEAT_TOKEN },
          body: JSON.stringify({
            fireId,
            projectId: job.project_id,
            jobId: job.id,
            kind: job.kind,
            payload: JSON.parse(job.payload),
          }),
        }),
      );
      console.log(`[scheduler] fired ${fireId} -> HTTP ${res.status}`);
    } catch (e) {
      console.log(`[scheduler] fire ${fireId} FAILED: ${String(e)}`);
    }
  }
}
