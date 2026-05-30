// Connection broker invariants (ADR 0003) — run: npx tsx src/connections.test.ts
// Exercises src/connections.ts against an in-memory D1 fake. Project isolation + secret-at-rest
// + gating are the load-bearing invariants.

import assert from 'node:assert/strict';
import {
  connectionState,
  resolveConnection,
  upsertConnection,
  createPending,
  connectionTools,
  connectionsBlock,
  PROVIDER_CATALOG,
} from './connections';
import { argsHash } from './crypto';
import { GITHUB_READ_TOOL_NAMES } from './github';
import type { D1Like } from './skills';

const KEY = 'a'.repeat(64);

interface ConnRow {
  project_id: string;
  provider: string;
  secret_ciphertext: string | null;
  fingerprint: string | null;
  config_json: string | null;
  status: string;
}
interface PendingRow {
  id: string;
  project_id: string;
  provider: string;
  action: string;
  args_json: string;
  args_hash: string;
  conversation_id: string;
  status: string;
}

class FakeD1 implements D1Like {
  conns: ConnRow[] = [];
  pending: PendingRow[] = [];

  prepare(query: string) {
    const db = this;
    return {
      bind(...values: unknown[]) {
        return {
          async run(): Promise<unknown> {
            db.exec(query, values);
            return { meta: { changes: 1 } };
          },
          async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
            return { results: db.select(query, values) as T[] };
          },
          async first<T = Record<string, unknown>>(): Promise<T | null> {
            return (db.select(query, values)[0] ?? null) as T | null;
          },
        };
      },
    };
  }

  private select(q: string, v: unknown[]): Record<string, unknown>[] {
    if (q.includes('SELECT provider, status, fingerprint, config_json FROM connections')) {
      const [pid] = v;
      return this.conns
        .filter((r) => r.project_id === pid)
        .map((r) => ({ provider: r.provider, status: r.status, fingerprint: r.fingerprint, config_json: r.config_json }));
    }
    if (q.includes('SELECT secret_ciphertext, config_json FROM connections')) {
      const [pid, provider] = v;
      return this.conns
        .filter((r) => r.project_id === pid && r.provider === provider && r.status === 'connected')
        .map((r) => ({ secret_ciphertext: r.secret_ciphertext, config_json: r.config_json }));
    }
    return [];
  }

  private exec(q: string, v: unknown[]): void {
    if (q.includes('INSERT INTO connections')) {
      const [project_id, provider, secret_ciphertext, fingerprint, config_json] = v as string[];
      const existing = this.conns.find((r) => r.project_id === project_id && r.provider === provider);
      if (existing) {
        Object.assign(existing, { secret_ciphertext, fingerprint, config_json, status: 'connected' });
      } else {
        this.conns.push({ project_id, provider, secret_ciphertext, fingerprint, config_json, status: 'connected' });
      }
    } else if (q.includes('INSERT INTO pending_actions')) {
      const [id, project_id, provider, action, args_json, args_hash, conversation_id] = v as string[];
      this.pending.push({ id, project_id, provider, action, args_json, args_hash, conversation_id, status: 'pending' });
    }
  }
}

const tests: [string, () => Promise<void>][] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

test('project isolation: connections are scoped to their project', async () => {
  const db = new FakeD1();
  await upsertConnection(db, 'A', 'github', 'patA', KEY, { repo: 'a/r' });
  assert.equal((await connectionState(db, 'A')).length, 1);
  assert.equal((await connectionState(db, 'B')).length, 0);
  assert.equal(await resolveConnection(db, 'B', 'github', KEY), null, "B cannot resolve A's secret");
});

test('secret at rest: D1 holds ciphertext + fingerprint, never plaintext; resolve decrypts', async () => {
  const db = new FakeD1();
  await upsertConnection(db, 'A', 'github', 'super_secret_pat', KEY, { repo: 'o/r' });
  const row = db.conns[0];
  assert.ok(row.secret_ciphertext && !row.secret_ciphertext.includes('super_secret_pat'), 'ciphertext, not plaintext');
  assert.match(row.fingerprint ?? '', /^sha256:/);
  const resolved = await resolveConnection(db, 'A', 'github', KEY);
  assert.equal(resolved?.secret, 'super_secret_pat', 'round-trips back to plaintext');
  assert.equal(resolved?.config.repo, 'o/r');
});

test('wrong master key cannot decrypt a stored secret', async () => {
  const db = new FakeD1();
  await upsertConnection(db, 'A', 'github', 'pat', KEY, {});
  await assert.rejects(resolveConnection(db, 'A', 'github', 'b'.repeat(64)));
});

test('gating: GitHub read tools appear only when connected, never the write (v2a)', async () => {
  const db = new FakeD1();
  // not connected → no tools
  let state = await connectionState(db, 'A');
  assert.equal(connectionTools(db, 'A', state, {}).length, 0, 'no tools before connection');

  // connected → the 5 read tools, and crucially NOT github_create_issue (deferred to v2b)
  await upsertConnection(db, 'A', 'github', 'pat', KEY, { repo: 'o/r' });
  state = await connectionState(db, 'A');
  const creds = (await resolveConnection(db, 'A', 'github', KEY))!;
  const tools = connectionTools(db, 'A', state, { github: creds });
  const names: string[] = tools.map((t) => t.name as string).sort();
  // Check the write-tool exclusion BEFORE deepEqual: node's assert.deepEqual is typed as an
  // assertion that narrows `names` to the expected array's element type, which would make the
  // subsequent .includes() reject a non-read tool name.
  assert.ok(!names.includes('github_create_issue'), 'write tool must NOT be exposed in v2a');
  assert.deepEqual(names, [...GITHUB_READ_TOOL_NAMES].sort(), 'exactly the read tools');
});

test('createPending stores canonical args + a matching hash (D10 foundation)', async () => {
  const db = new FakeD1();
  const args = { repo: 'o/r', title: 'Bug', body: 'x' };
  const { id, hash } = await createPending(db, {
    projectId: 'A',
    provider: 'github',
    action: 'create_issue',
    args,
    conversationId: 'C123',
  });
  const row = db.pending.find((p) => p.id === id)!;
  assert.equal(row.status, 'pending');
  assert.equal(row.args_hash, hash);
  assert.equal(row.args_hash, await argsHash(args), 'stored hash matches a fresh hash of the args');
  assert.equal(JSON.parse(row.args_json).title, 'Bug');
});

test('connectionsBlock shows connected vs not-connected from real state', async () => {
  const db = new FakeD1();
  await upsertConnection(db, 'A', 'github', 'pat', KEY, { repo: 'o/r' });
  const block = connectionsBlock(await connectionState(db, 'A'), PROVIDER_CATALOG);
  assert.match(block, /✅ github \(connected\)/);

  const empty = connectionsBlock([], PROVIDER_CATALOG);
  assert.match(empty, /⚪ github \(not connected\)/);
});

const main = async () => {
  let pass = 0;
  let fail = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      pass++;
    } catch (e) {
      console.log(`  ✗ ${name}\n    ${(e as Error).message}`);
      fail++;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
};

await main();
