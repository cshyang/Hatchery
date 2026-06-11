// Global people record invariants — run: npx tsx src/knowledge/people.test.ts

import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import {
  GLOBAL_PROJECT_ID,
  PERSON_FACT_CAP,
  listPersonFacts,
  savePersonFact,
  forgetPersonFact,
  renderPersonFacts,
} from './people';
import type { D1Like } from '../skills/repository';

const { test, run } = createTestRunner();

interface MemoryRow {
  id: number;
  project_id: string;
  scope: string;
  subject: string;
  fact: string;
  created_by: string;
}

// Pattern-matched fake for the queries the people store issues against `memories`.
class FakeD1 implements D1Like {
  rows: MemoryRow[] = [];
  nextId = 1;

  prepare(query: string) {
    const self = this;
    return {
      bind(...values: unknown[]) {
        return {
          async run(): Promise<unknown> {
            if (query.startsWith('INSERT INTO memories')) {
              const [projectId, subject, fact, createdBy] = values as [string, string, string, string];
              self.rows.push({ id: self.nextId++, project_id: projectId, scope: 'user', subject, fact, created_by: createdBy });
              return { meta: { changes: 1 } };
            }
            if (query.startsWith('DELETE FROM memories')) {
              const [projectId, id] = values as [string, number];
              const before = self.rows.length;
              self.rows = self.rows.filter((r) => !(r.project_id === projectId && r.scope === 'user' && r.id === id));
              return { meta: { changes: before - self.rows.length } };
            }
            throw new Error(`unexpected run query: ${query}`);
          },
          async all<T>(): Promise<{ results: T[] }> {
            if (query.includes("scope='user'")) {
              const [projectId, ...rest] = values as [string, string?, string?];
              let results = self.rows.filter((r) => r.project_id === projectId && r.scope === 'user');
              if (rest.length) {
                const like = String(rest[0]).replaceAll('%', '');
                results = results.filter((r) => r.subject.includes(like) || r.fact.includes(like));
              }
              results = [...results].sort((a, b) => (a.subject === b.subject ? a.id - b.id : a.subject < b.subject ? -1 : 1));
              return { results: results.map((r) => ({ id: r.id, subject: r.subject, fact: r.fact })) as T[] };
            }
            throw new Error(`unexpected all query: ${query}`);
          },
          async first<T>(): Promise<T | null> {
            throw new Error('unused');
          },
        };
      },
    };
  }
}

const SUBJ = 'slack:T1:U1';

test('savePersonFact writes a __global__ scope=user row with source provenance', async () => {
  const db = new FakeD1();
  const res = await savePersonFact(db, { subject: SUBJ, fact: 'Sarah owns the deploy pipeline', sourceProjectId: 'C123' });
  assert.equal(res.saved, true);
  assert.equal(db.rows[0].project_id, GLOBAL_PROJECT_ID);
  assert.equal(db.rows[0].created_by, 'C123');
  assert.deepEqual(await listPersonFacts(db, 'Sarah'), [{ id: 1, subject: SUBJ, fact: 'Sarah owns the deploy pipeline' }]);
});

test('savePersonFact dedupes exact facts and enforces the thin cap', async () => {
  const db = new FakeD1();
  await savePersonFact(db, { subject: SUBJ, fact: 'Sarah is in KL', sourceProjectId: 'C1' });
  const dup = await savePersonFact(db, { subject: SUBJ, fact: 'Sarah is in KL', sourceProjectId: 'C2' });
  assert.equal(dup.saved, false);
  assert.match(dup.reason ?? '', /duplicate/);

  for (let i = db.rows.length; i < PERSON_FACT_CAP; i++) {
    await savePersonFact(db, { subject: SUBJ, fact: `fact ${i}`, sourceProjectId: 'C1' });
  }
  const over = await savePersonFact(db, { subject: SUBJ, fact: 'one too many', sourceProjectId: 'C1' });
  assert.equal(over.saved, false);
  assert.match(over.reason ?? '', /cap/);
  // The cap is per person, not global.
  const other = await savePersonFact(db, { subject: 'slack:T1:U2', fact: 'Bob is in NYC', sourceProjectId: 'C1' });
  assert.equal(other.saved, true);
});

test('savePersonFact validates inputs', async () => {
  const db = new FakeD1();
  await assert.rejects(() => savePersonFact(db, { subject: '', fact: 'x', sourceProjectId: 'C1' }), /subject/);
  await assert.rejects(() => savePersonFact(db, { subject: SUBJ, fact: '  ', sourceProjectId: 'C1' }), /non-empty fact/);
});

test('forgetPersonFact deletes by id; render groups by subject', async () => {
  const db = new FakeD1();
  await savePersonFact(db, { subject: SUBJ, fact: 'Sarah is in KL', sourceProjectId: 'C1' });
  await savePersonFact(db, { subject: SUBJ, fact: 'Sarah owns infra', sourceProjectId: 'C1' });
  assert.deepEqual(await forgetPersonFact(db, 1), { found: true });
  assert.deepEqual(await forgetPersonFact(db, 99), { found: false });
  assert.equal(renderPersonFacts(await listPersonFacts(db)), `${SUBJ}\n  [2] Sarah owns infra`);
  assert.equal(renderPersonFacts([]), 'No global people facts recorded.');
});

await run();
