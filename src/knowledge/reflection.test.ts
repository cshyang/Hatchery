// Reflection invariants — run: npm test
// The load-bearing one is the watermark: each message is consolidated exactly once (no
// re-processing, no loss), and the nightly gate only surfaces projects with something new.

import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { logMessage, projectsWithUnreflected, projectsWithUnreflectedRuns, takeUnreflectedBatch, takeUnreflectedRuns, buildReflectInstructions } from './reflection';
import type { D1Like } from '../skills/repository';

interface MsgRow { id: number; project_id: string; conversation_id: string; sender_id: string; role: string; text: string; ambient: number; created_at: number; }
interface RunRow { project_id: string; status: string; source_type: string; linear_identifier: string | null; target_repo: string; kit: string; summary: string | null; error: string | null; pr_url: string | null; completed_at: number | null; }

// Minimal D1 fake covering the fixed queries in reflection.ts (messages + runs + reflection_state).
class FakeD1 implements D1Like {
  msgs: MsgRow[] = [];
  runs: RunRow[] = [];
  state = new Map<string, number>(); // project_id -> last_message_id
  runState = new Map<string, number>(); // project_id -> last_run_completed_at
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
    if (q.includes('FROM agent_runs_m1 r')) {
      // projectsWithUnreflectedRuns: terminal runs past max(run watermark, lookback cutoff).
      const [cutoff] = v as [number];
      const seen = new Set<string>();
      const out: { project_id: string }[] = [];
      for (const r of this.runs) {
        const since = Math.max(this.runState.get(r.project_id) ?? 0, cutoff);
        if (r.completed_at != null && ['completed', 'failed', 'cancelled'].includes(r.status) && r.completed_at > since && !seen.has(r.project_id)) {
          seen.add(r.project_id);
          out.push({ project_id: r.project_id });
        }
      }
      return out;
    }
    if (q.includes('SELECT last_run_completed_at FROM reflection_state')) {
      const [pid] = v as [string];
      return this.runState.has(pid) ? [{ last_run_completed_at: this.runState.get(pid) }] : [];
    }
    if (q.includes('FROM agent_runs_m1') && q.includes('WHERE project_id=?')) {
      const [pid, since] = v as [string, number];
      const limit = Number((q.match(/LIMIT (\d+)/) ?? [])[1] ?? 1e9);
      return this.runs
        .filter((r) => r.project_id === pid && r.completed_at != null && r.completed_at > since && ['completed', 'failed', 'cancelled'].includes(r.status))
        .sort((a, b) => a.completed_at! - b.completed_at!)
        .slice(0, limit)
        .map((r) => ({ ...r }));
    }
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
    } else if (q.includes('last_run_completed_at, last_reflected_at) VALUES')) {
      // Run-watermark upsert: touches ONLY the run watermark (update arm), never last_message_id.
      // Binds are (project_id, last_run_completed_at, last_reflected_at) — last_message_id is a SQL literal 0.
      const [project_id, last_run_completed_at] = v as [string, number];
      this.runState.set(project_id, last_run_completed_at);
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

// ── The run record (rung one) ───────────────────────────────────────────────────────────────────

const NOW = 1_750_000_000_000;
const run_ = (over: Partial<RunRow>): RunRow => ({
  project_id: 'A', status: 'completed', source_type: 'linear', linear_identifier: 'FRD-1',
  target_repo: 'acme/api', kit: 'harness', summary: 'shipped', error: null, pr_url: null,
  completed_at: NOW - 1000, ...over,
});

test('run gate: a project with only terminal runs (no messages) still surfaces for REM', async () => {
  const db = new FakeD1();
  db.runs.push(run_({}));
  assert.deepEqual(await projectsWithUnreflected(db), [], 'no messages');
  assert.deepEqual(await projectsWithUnreflectedRuns(db, NOW), ['A']);
});

test('run watermark: each terminal run reflects exactly once; message watermark untouched', async () => {
  const db = new FakeD1();
  await log(db, 'A', 'hello');
  db.runs.push(run_({ linear_identifier: 'FRD-7' }));
  const digest1 = (await takeUnreflectedRuns(db, 'A', NOW))!;
  assert.match(digest1, /FRD-7/);
  assert.equal(await takeUnreflectedRuns(db, 'A', NOW), null, 'consumed');
  assert.deepEqual(await projectsWithUnreflectedRuns(db, NOW), [], 'gate quiet after consume');
  // Taking runs must not consume the conversation stream.
  assert.ok((await takeUnreflectedBatch(db, 'A'))!.includes('hello'), 'message stream independent');
});

test('run digest: failed runs carry the error, completed carry summary + pr; non-terminal and stale runs excluded', async () => {
  const db = new FakeD1();
  db.runs.push(run_({ status: 'failed', linear_identifier: 'FRD-2', error: 'npm install exploded\nstack...' }));
  db.runs.push(run_({ status: 'completed', linear_identifier: 'FRD-3', summary: 'fixed slugify', pr_url: 'https://github.com/x/pr/1', completed_at: NOW - 500 }));
  db.runs.push(run_({ status: 'running', linear_identifier: 'FRD-4', completed_at: null }));
  db.runs.push(run_({ linear_identifier: 'FRD-OLD', completed_at: NOW - 8 * 24 * 60 * 60 * 1000 }));
  const digest = (await takeUnreflectedRuns(db, 'A', NOW))!;
  assert.match(digest, /\[failed\] linear FRD-2 → acme\/api \(kit harness\): error: npm install exploded stack\.\.\./);
  assert.match(digest, /\[completed\] linear FRD-3 .* fixed slugify \(https:\/\/github\.com\/x\/pr\/1\)/);
  assert.ok(!digest.includes('FRD-4'), 'running run not reflected');
  assert.ok(!digest.includes('FRD-OLD'), 'older than the lookback window');
});

test('buildReflectInstructions: sections appear only for streams with material', async () => {
  const both = buildReflectInstructions('a: hi', '[failed] linear FRD-1 → r (kit harness): error: x');
  assert.match(both, /RUN RECORD → memory ONLY/);
  assert.match(both, /--- CONVERSATION TO CONSOLIDATE ---/);
  assert.match(both, /--- RUN RECORD TO CONSOLIDATE ---/);
  const chatOnly = buildReflectInstructions('a: hi', null);
  assert.ok(!chatOnly.includes('RUN RECORD'), 'no run section without a digest');
  const runsOnly = buildReflectInstructions(null, '[failed] …');
  assert.match(runsOnly, /NO NEW CONVERSATION TONIGHT/);
  assert.match(runsOnly, /--- RUN RECORD TO CONSOLIDATE ---/);
});

await run();
