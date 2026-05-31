// Binding D1 cascade + auto-create invariants — run: npx tsx src/bindings.test.ts
// Mirrors the connections D1+seed pattern: D1 rows are the live source merged OVER the
// bindings.ts seed; the gateway auto-creates a per-channel binding (race-safe, team-allowlisted).
// Load-bearing: the bot token is referenced by NAME (transport_token_ref), never stored; auto-create
// is gated to KNOWN_TEAM_IDS so "any channel" can never become "any workspace".

import assert from 'node:assert/strict';
import {
  loadBindings,
  upsertBinding,
  autoCreateBinding,
  isKnownTeam,
  bindingRecordToBinding,
  bindingBySlack,
  bindingByProject,
  type BindingRecord,
} from './bindings';
import type { D1Like } from './skills';

// In-memory D1 fake covering only the two statements bindings.ts issues.
interface Row {
  [k: string]: unknown;
}
class FakeD1 implements D1Like {
  rows: Row[] = [];
  prepare(sql: string) {
    const t = sql.trim();
    return {
      bind: (...args: unknown[]) => ({
        run: async (): Promise<unknown> => {
          this.#mutate(t, args);
          return {};
        },
        all: async <T = Record<string, unknown>>(): Promise<{ results: T[] }> => ({ results: this.#query(t, args) as T[] }),
        first: async <T = Record<string, unknown>>(): Promise<T | null> => (this.#query(t, args)[0] ?? null) as T | null,
      }),
    };
  }
  #mutate(sql: string, a: unknown[]) {
    if (sql.startsWith('INSERT INTO bindings')) {
      const [projectId, , accountId, spaceId, botId, tokenRef, , model, status, createdBy, createdAt, updatedAt] = a;
      // ON CONFLICT(project_id) DO NOTHING — a second insert for the same project_id is a no-op.
      if (this.rows.some((r) => r.project_id === projectId)) return;
      this.rows.push({
        project_id: projectId, provider: 'slack', external_account_id: accountId, external_space_id: spaceId,
        transport_bot_id: botId, transport_token_ref: tokenRef, default_profile: 'project-assistant', model,
        status, created_by: createdBy, created_at: createdAt, updated_at: updatedAt,
      });
    }
  }
  #query(sql: string, a: unknown[]): Row[] {
    if (sql.startsWith('SELECT project_id, provider')) {
      // loadBindings(projectId?) — if a projectId arg is bound, filter; else all.
      return a.length ? this.rows.filter((r) => r.project_id === a[0]) : this.rows;
    }
    return [];
  }
}

const tests: [string, () => Promise<void>][] = [];
const test = (n: string, fn: () => Promise<void>) => tests.push([n, fn]);

test('isKnownTeam: only allowlisted team ids pass', async () => {
  assert.equal(isKnownTeam('T0B6VB415TQ'), true);
  assert.equal(isKnownTeam('T_SOME_OTHER_WORKSPACE'), false);
  assert.equal(isKnownTeam(''), false);
});

test('autoCreateBinding inserts a per-channel row keyed by channel id, token by ref', async () => {
  const db = new FakeD1();
  await autoCreateBinding(db, {
    teamId: 'T0B6VB415TQ',
    channelId: 'C_NEW',
    transportBotId: 'U0B6UB2E5HT',
    transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
  });
  const rows = await loadBindings(db, 'C_NEW');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].projectId, 'C_NEW', 'project_id = channel id');
  assert.equal(rows[0].externalSpaceId, 'C_NEW');
  assert.equal(rows[0].externalAccountId, 'T0B6VB415TQ');
  assert.equal(rows[0].transportTokenRef, 'SLACK_BOT_TOKEN_DEFAULT', 'token is a REF, not a value');
  assert.equal(rows[0].status, 'active');
});

test('autoCreateBinding is race-safe: a second call for the same channel is a no-op (DO NOTHING)', async () => {
  const db = new FakeD1();
  const args = { teamId: 'T0B6VB415TQ', channelId: 'C_DUP', transportBotId: 'U', transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT' };
  await autoCreateBinding(db, args);
  await autoCreateBinding(db, args);
  const rows = await loadBindings(db, 'C_DUP');
  assert.equal(rows.length, 1, 'exactly one row after two creates');
});

test('bindingRecordToBinding maps a D1 row to the Binding shape the app consumes', async () => {
  const rec: BindingRecord = {
    projectId: 'C_X', provider: 'slack', externalAccountId: 'T0B6VB415TQ', externalSpaceId: 'C_X',
    transportBotId: 'U', transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT', defaultProfile: 'project-assistant',
    model: undefined, status: 'active',
  };
  const b = bindingRecordToBinding(rec);
  assert.equal(b.provider, 'slack');
  assert.equal(b.projectId, 'C_X');
  assert.equal(b.externalSpaceId, 'C_X');
  assert.equal(b.sandboxMode, 'virtual', 'defaults filled for fields not stored in D1');
  assert.equal(b.status, 'active');
});

test('bindingBySlack: seed wins first; falls back to D1 for an auto-created channel', async () => {
  const db = new FakeD1();
  // the demo seed row resolves with NO db touch
  const seedHit = await bindingBySlack('T0B6VB415TQ', 'C0B6VFMVCUW', db);
  assert.equal(seedHit?.projectId, 'demo', 'seed row resolves');

  // an unknown channel is not in the seed → undefined until a D1 row exists
  assert.equal(await bindingBySlack('T0B6VB415TQ', 'C_NEW', db), undefined);

  // after auto-create, the same lookup resolves from D1
  await autoCreateBinding(db, { teamId: 'T0B6VB415TQ', channelId: 'C_NEW', transportBotId: 'U0B6UB2E5HT', transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT' });
  const d1Hit = await bindingBySlack('T0B6VB415TQ', 'C_NEW', db);
  assert.equal(d1Hit?.projectId, 'C_NEW', 'D1 row resolves after auto-create');
  assert.equal(d1Hit?.transportTokenRef, 'SLACK_BOT_TOKEN_DEFAULT');
});

test('bindingByProject: resolves a D1-only channel project', async () => {
  const db = new FakeD1();
  assert.equal((await bindingByProject('demo', db))?.projectId, 'demo', 'seed');
  await autoCreateBinding(db, { teamId: 'T0B6VB415TQ', channelId: 'C_P', transportBotId: 'U', transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT' });
  assert.equal((await bindingByProject('C_P', db))?.projectId, 'C_P', 'D1');
});

test('disabled D1 binding does not resolve', async () => {
  const db = new FakeD1();
  await upsertBinding(db, {
    projectId: 'C_OFF', provider: 'slack', externalAccountId: 'T0B6VB415TQ', externalSpaceId: 'C_OFF',
    transportBotId: 'U', transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT', defaultProfile: 'project-assistant',
    status: 'disabled',
  });
  assert.equal(await bindingBySlack('T0B6VB415TQ', 'C_OFF', db), undefined, 'disabled is not active');
  assert.equal(await bindingByProject('C_OFF', db), undefined);
});

const main = async () => {
  let pass = 0, fail = 0;
  for (const [n, fn] of tests) {
    try { await fn(); console.log(`  ✓ ${n}`); pass++; }
    catch (e) { console.log(`  ✗ ${n}\n    ${(e as Error).message}`); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
};
await main();
