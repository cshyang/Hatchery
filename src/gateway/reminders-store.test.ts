import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { isValidCron, nextCron, KL_OFFSET_MIN } from './cron';
import {
  upsertReminder,
  listReminders,
  cancelReminder,
  setReminderEnabled,
  takeDueReminders,
  type ReminderRow,
} from './reminders-store';
import type { D1Like } from '../skills/repository';

const { test, run } = createTestRunner();

// Pattern-matched fake for the exact queries the store issues, with real CAS
// semantics on next_run so the double-claim guard is actually exercised.
class FakeD1 implements D1Like {
  rows: ReminderRow[] = [];

  prepare(query: string) {
    const self = this;
    return {
      bind(...values: unknown[]) {
        return {
          async run(): Promise<unknown> {
            if (query.startsWith('INSERT INTO reminders')) {
              const [id, projectId, kind, cron, everyMs, nextRun, payload, createdAt, updatedAt] = values as [
                string, string, string, string | null, number | null, number, string, number, number,
              ];
              const existing = self.rows.find((r) => r.project_id === projectId && r.id === id);
              if (existing) {
                Object.assign(existing, { kind, cron, every_ms: everyMs, next_run: nextRun, payload, enabled: 1 });
              } else {
                self.rows.push({ id, project_id: projectId, kind, cron, every_ms: everyMs, next_run: nextRun, payload, enabled: 1 });
              }
              return { meta: { changes: 1 } };
            }
            if (query.startsWith('UPDATE reminders SET enabled=')) {
              const [enabled, , projectId, id] = values as [number, number, string, string];
              const row = self.rows.find((r) => r.project_id === projectId && r.id === id);
              if (row) row.enabled = enabled;
              return { meta: { changes: row ? 1 : 0 } };
            }
            if (query.startsWith('UPDATE reminders SET next_run=')) {
              const [nextRun, , projectId, id, casNextRun] = values as [number, number, string, string, number];
              const row = self.rows.find((r) => r.project_id === projectId && r.id === id && r.next_run === casNextRun);
              if (row) row.next_run = nextRun;
              return { meta: { changes: row ? 1 : 0 } };
            }
            if (query.startsWith('DELETE FROM reminders') && query.includes('next_run=?')) {
              const [projectId, id, casNextRun] = values as [string, string, number];
              const before = self.rows.length;
              self.rows = self.rows.filter((r) => !(r.project_id === projectId && r.id === id && r.next_run === casNextRun));
              return { meta: { changes: before - self.rows.length } };
            }
            if (query.startsWith('DELETE FROM reminders')) {
              const [projectId, id] = values as [string, string];
              const before = self.rows.length;
              self.rows = self.rows.filter((r) => !(r.project_id === projectId && r.id === id));
              return { meta: { changes: before - self.rows.length } };
            }
            throw new Error(`unexpected run query: ${query}`);
          },
          async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
            if (query.includes('COUNT(*)')) {
              const [projectId, id] = values as [string, string];
              const n = self.rows.filter((r) => r.project_id === projectId && r.id === id).length;
              return { results: [{ n } as T] };
            }
            if (query.includes('WHERE project_id=?')) {
              const [projectId] = values as [string];
              const results = self.rows.filter((r) => r.project_id === projectId).sort((a, b) => a.next_run - b.next_run);
              return { results: results as T[] };
            }
            if (query.includes('enabled=1 AND next_run<=?')) {
              const [now] = values as [number];
              const results = self.rows
                .filter((r) => r.enabled === 1 && r.next_run <= now)
                .sort((a, b) => a.next_run - b.next_run);
              return { results: results.map((r) => ({ ...r })) as T[] };
            }
            throw new Error(`unexpected all query: ${query}`);
          },
          async first<T = Record<string, unknown>>(): Promise<T | null> {
            throw new Error('unused');
          },
        };
      },
    };
  }
}

// 2026-06-10 00:00 UTC = 08:00 KL.
const T0 = Date.UTC(2026, 5, 10, 0, 0, 0);

test('cron: nextCron computes KL wall-clock fires, strictly after from', () => {
  // 9am KL daily from 8am KL → today 9am KL = 01:00 UTC.
  assert.equal(nextCron('0 9 * * *', T0, KL_OFFSET_MIN), Date.UTC(2026, 5, 10, 1, 0, 0));
  // From exactly 9am KL → tomorrow.
  assert.equal(nextCron('0 9 * * *', Date.UTC(2026, 5, 10, 1, 0, 0), KL_OFFSET_MIN), Date.UTC(2026, 5, 11, 1, 0, 0));
  // 2026-06-10 is a Wednesday; Monday 9am KL → 2026-06-15 01:00 UTC.
  assert.equal(nextCron('0 9 * * 1', T0, KL_OFFSET_MIN), Date.UTC(2026, 5, 15, 1, 0, 0));
  assert.equal(isValidCron('0 9 * * *'), true);
  assert.equal(isValidCron('not a cron'), false);
  assert.equal(nextCron('0 0 31 2 *', T0, KL_OFFSET_MIN), -1); // Feb 31 never fires
});

test('upsertReminder inserts, replaces in place by id, and validates cron', async () => {
  const db = new FakeD1();
  const first = await upsertReminder(db, 'P', { id: 'digest', cron: '0 9 * * *' }, T0);
  assert.equal(first.nextRun, Date.UTC(2026, 5, 10, 1, 0, 0));

  const replaced = await upsertReminder(db, 'P', { id: 'digest', inMs: 60_000, payload: { prompt: 'hi' } }, T0);
  assert.equal(replaced.nextRun, T0 + 60_000);
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].payload, JSON.stringify({ prompt: 'hi' }));

  await assert.rejects(() => upsertReminder(db, 'P', { id: 'bad', cron: 'nope' }, T0), /invalid cron/);
  await assert.rejects(() => upsertReminder(db, 'P', { id: '' }, T0), /requires an id/);
});

test('list, cancel, pause and resume reminders', async () => {
  const db = new FakeD1();
  await upsertReminder(db, 'P', { id: 'a', inMs: 1000 }, T0);
  await upsertReminder(db, 'P', { id: 'b', everyMs: 5000 }, T0);
  await upsertReminder(db, 'OTHER', { id: 'c', inMs: 1000 }, T0);

  assert.deepEqual((await listReminders(db, 'P')).map((r) => r.id), ['a', 'b']);

  assert.deepEqual(await setReminderEnabled(db, 'P', 'a', false), { found: true });
  assert.equal(db.rows.find((r) => r.id === 'a')?.enabled, 0);
  assert.deepEqual(await setReminderEnabled(db, 'P', 'missing', false), { found: false });

  await cancelReminder(db, 'P', 'b');
  assert.deepEqual((await listReminders(db, 'P')).map((r) => r.id), ['a']);
});

test('takeDueReminders claims one-shots, advances recurring, skips paused', async () => {
  const db = new FakeD1();
  await upsertReminder(db, 'P', { id: 'once', runAt: T0 + 1000, payload: { prompt: 'go' } }, T0);
  await upsertReminder(db, 'P', { id: 'interval', everyMs: 10_000 }, T0); // due at T0+10s
  await upsertReminder(db, 'P', { id: 'daily', cron: '0 9 * * *' }, T0); // due at 09:00 KL
  await upsertReminder(db, 'P', { id: 'paused', runAt: T0 + 1000 }, T0);
  await setReminderEnabled(db, 'P', 'paused', false);

  const now = Date.UTC(2026, 5, 10, 1, 0, 0); // 09:00 KL — everything due
  const due = await takeDueReminders(db, now);
  assert.deepEqual(due.map((j) => j.jobId).sort(), ['daily', 'interval', 'once']);

  const onceJob = due.find((j) => j.jobId === 'once');
  assert.equal(onceJob?.fireId, `P:once:${T0 + 1000}`);
  assert.deepEqual(onceJob?.payload, { prompt: 'go' });
  // One-shot consumed; interval re-armed from now; cron re-armed to tomorrow 9am KL.
  assert.equal(db.rows.find((r) => r.id === 'once'), undefined);
  assert.equal(db.rows.find((r) => r.id === 'interval')?.next_run, now + 10_000);
  assert.equal(db.rows.find((r) => r.id === 'daily')?.next_run, Date.UTC(2026, 5, 11, 1, 0, 0));
  assert.equal(db.rows.find((r) => r.id === 'paused')?.next_run, T0 + 1000); // untouched

  // Nothing due → empty; nothing double-fires.
  assert.deepEqual(await takeDueReminders(db, now + 1000), []);
});

test('takeDueReminders CAS-skips rows another scan already advanced', async () => {
  const db = new FakeD1();
  await upsertReminder(db, 'P', { id: 'raced', runAt: T0 + 1000 }, T0);
  // Simulate a concurrent scan advancing the row between SELECT and claim by
  // intercepting the due-scan read to return a stale snapshot.
  const stale = db.rows.map((r) => ({ ...r }));
  db.rows[0].next_run = T0 + 99_999; // "other scan" moved it
  const realPrepare = db.prepare.bind(db);
  db.prepare = (query: string) => {
    if (query.includes('enabled=1 AND next_run<=?')) {
      return { bind: () => ({ run: async () => ({}), all: async <T,>() => ({ results: stale as T[] }), first: async () => null }) };
    }
    return realPrepare(query);
  };
  assert.deepEqual(await takeDueReminders(db, T0 + 2000), []);
});

run();
