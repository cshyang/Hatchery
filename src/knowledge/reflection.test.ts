// Reflection invariants — run: npm test
// The load-bearing one is the watermark: each message is consolidated exactly once (no
// re-processing, no loss), and the nightly gate only surfaces projects with something new.

import assert from 'node:assert/strict';
import { createTestRunner } from '../test-utils';
import { logMessage, projectsWithUnreflected, takeUnreflectedBatch } from './reflection';
import type { D1Like } from '../skills/repository';

interface MsgRow { id: number; project_id: string; conversation_id: string; sender_id: string; role: string; text: string; ambient: number; created_at: number; }

// Minimal D1 fake covering the fixed queries in reflection.ts (messages + reflection_state).
class FakeD1 implements D1Like {
  msgs: MsgRow[] = [];
  state = new Map<string, number>(); // project_id -> last_message_id
  private nextId = 1;

  prepare(query: string) {
    const db = this;
    return {
      bind(...v: unknown[]) {
        return {
          async run(): Promise<unknown> {
            db.exec(query, v);
            return {};
          },
          async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
            return { results: db.select(query, v) as T[] };
          },
          async first<T = Record<string, unknown>>(): Promise<T | null> {
            return (db.select(query, v)[0] ?? null) as T | null;
          },
        };
      },
    };
  }

  private select(q: string, v: unknown[]): Record<string, unknown>[] {
    if (q.includes('LEFT JOIN reflection_state')) {
      const seen = new Set<string>();
      const out: { project_id: string }[] = [];
      for (const m of this.msgs) {
        if (!m.ambient && m.id > (this.state.get(m.project_id) ?? 0) && !seen.has(m.project_id)) {
          seen.add(m.project_id);
          out.push({ project_id: m.project_id });
        }
      }
      return out;
    }
    if (q.includes('SELECT last_message_id FROM reflection_state')) {
      const [pid] = v as [string];
      return this.state.has(pid) ? [{ last_message_id: this.state.get(pid) }] : [];
    }
    if (q.includes('WHERE project_id=? AND id>?')) {
      const [pid, since] = v as [string, number];
      const limit = Number((q.match(/LIMIT (\d+)/) ?? [])[1] ?? 1e9);
      return this.msgs
        .filter((m) => m.project_id === pid && m.id > since && !m.ambient)
        .sort((a, b) => a.id - b.id)
        .slice(0, limit)
        .map((m) => ({ id: m.id, conversation_id: m.conversation_id, sender_id: m.sender_id, role: m.role, text: m.text }));
    }
    return [];
  }

  private exec(q: string, v: unknown[]): void {
    if (q.startsWith('INSERT INTO messages')) {
      const [project_id, conversation_id, sender_id, role, text, ambient, created_at] = v as [string, string, string, string, string, number, number];
      this.msgs.push({ id: this.nextId++, project_id, conversation_id, sender_id, role, text, ambient, created_at });
    } else if (q.includes('INSERT INTO reflection_state')) {
      const [project_id, last_message_id] = v as [string, number];
      this.state.set(project_id, last_message_id);
    }
  }
}

const log = (db: FakeD1, project: string, text: string, sender = 'slack:T:U1') =>
  logMessage(db, { projectId: project, conversationId: 'c1', senderId: sender, role: 'user', text });

const { test, run } = createTestRunner();

test('gate: only projects with messages past their watermark appear', async () => {
  const db = new FakeD1();
  await log(db, 'A', 'hi');
  await log(db, 'B', 'yo');
  assert.deepEqual((await projectsWithUnreflected(db)).sort(), ['A', 'B']);
  await takeUnreflectedBatch(db, 'A'); // consume A
  assert.deepEqual(await projectsWithUnreflected(db), ['B']);
});

test('watermark: each message consolidated exactly once', async () => {
  const db = new FakeD1();
  await log(db, 'A', 'one');
  await log(db, 'A', 'two');
  const first = await takeUnreflectedBatch(db, 'A');
  assert.ok(first && first.includes('one') && first.includes('two'));
  assert.equal(await takeUnreflectedBatch(db, 'A'), null, 'nothing new after consume');
  await log(db, 'A', 'three');
  const second = await takeUnreflectedBatch(db, 'A');
  assert.ok(second && second.includes('three') && !second.includes('one'), 'only the new message');
});

test('empty: takeUnreflectedBatch returns null when nothing new', async () => {
  const db = new FakeD1();
  assert.equal(await takeUnreflectedBatch(db, 'A'), null);
});

test('cap: a batch never exceeds the limit, and the rest are caught next take', async () => {
  const db = new FakeD1();
  for (let i = 0; i < 305; i++) await log(db, 'A', `m${i}`);
  const batch1 = (await takeUnreflectedBatch(db, 'A'))!.split('\n');
  assert.equal(batch1.length, 300, 'first batch capped at 300');
  const batch2 = (await takeUnreflectedBatch(db, 'A'))!.split('\n');
  assert.equal(batch2.length, 5, 'remaining 5 next time');
});

test('attribution: agent posts render as "you", people by sender id', async () => {
  const db = new FakeD1();
  await logMessage(db, { projectId: 'A', conversationId: 'c1', senderId: 'slack:T:U9', role: 'user', text: 'hello' });
  await logMessage(db, { projectId: 'A', conversationId: 'c1', senderId: 'agent', role: 'agent', text: 'hi back' });
  const t = (await takeUnreflectedBatch(db, 'A'))!;
  assert.match(t, /slack:T:U9: hello/);
  assert.match(t, /you: hi back/);
});

test('reflection skips ambient rows: only engaged messages are consolidated', async () => {
  const db = new FakeD1();
  await logMessage(db, { projectId: 'A', conversationId: 'c1', senderId: 'slack:T:U1', role: 'user', text: 'engaged-msg' });
  await logMessage(db, { projectId: 'A', conversationId: 'c1', senderId: 'slack:T:U2', role: 'user', text: 'ambient-msg', ambient: true });
  assert.deepEqual(await projectsWithUnreflected(db), ['A']);
  const batch = (await takeUnreflectedBatch(db, 'A'))!;
  assert.ok(batch.includes('engaged-msg'), 'engaged message consolidated');
  assert.ok(!batch.includes('ambient-msg'), 'ambient message skipped by REM');
  // After consuming the engaged row, the trailing ambient row must NOT keep re-surfacing the
  // project: the watermark advances past it and the gate goes quiet. Guards against a future
  // regression where ambient rows leak back into REM.
  assert.deepEqual(await projectsWithUnreflected(db), [], 'ambient tail does not re-trigger REM');
  assert.equal(await takeUnreflectedBatch(db, 'A'), null, 'nothing new after the engaged row');
});

test('reflection gate ignores ambient-only projects (no REM turn for pure chatter)', async () => {
  const db = new FakeD1();
  await logMessage(db, { projectId: 'B', conversationId: 'c1', senderId: 'slack:T:U1', role: 'user', text: 'just chatter', ambient: true });
  assert.deepEqual(await projectsWithUnreflected(db), [], 'ambient-only project does not trigger REM');
  assert.equal(await takeUnreflectedBatch(db, 'B'), null, 'nothing to consolidate');
});

await run();
