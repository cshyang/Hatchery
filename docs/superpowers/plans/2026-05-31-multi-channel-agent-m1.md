# Multi-channel Agent (Milestone 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Hatchery agent work in ANY channel of the known Slack workspace — each channel auto-becomes its own isolated project on first @mention — and give every channel a shared baseline of skills via a `__global__` sentinel project.

**Architecture:** Mirror the proven connections D1+seed cascade (migration 0005 / `loadConnectionSpecs`): a new `bindings` D1 table is the live source of truth, merged over the `bindings.ts` code seed. The Slack gateway auto-creates a binding row (race-safe, team-allowlisted) on the first @mention in an unknown channel, then dispatches. Skill reads union `__global__` with the channel's own skills (channel wins on name); skill WRITES stay channel-scoped so an agent can never edit the shared baseline.

**Tech Stack:** Cloudflare Durable Objects + Flue 0.8.1 + Hono + D1 (`hatchery-skills`). Tests are hand-rolled `FakeD1` + `node:assert`, run per-file via `tsx` under `npm test`. NO vitest.

**Scope:** Milestone 1 ONLY = Components 1 (auto-binding) + 2 (global skills). Component 3 (Nango / self-serve connect) is explicitly EXCLUDED — separate plan.

---

## Background an executor needs

**The hard line (security invariant, must survive every task):** auto-binding is created by the GATEWAY (`.flue/app.ts`), on a verified Slack signature, gated to an allowlisted team id. It is NOT created by the agent/model. The model never writes a binding or a `__global__` skill. Per-channel isolation = `project_id` = the Slack channel id.

**The pattern to mirror — connections D1+seed cascade** (already shipped, `src/connections.ts`):
- `loadConnections(db, projectId)` reads D1 rows.
- `loadConnectionSpecs(db, binding)` merges D1 OVER the binding seed: D1 wins by key, `status='disabled'` removes a seeded entry, and a D1 hiccup (`.catch`) falls back to the seed so a transient error can't strip working config.
- `upsertConnection` is `INSERT ... ON CONFLICT(...) DO UPDATE`.
- The admin route guards writes with a dedicated token; 404 when unauthenticated.
Apply the same shapes to bindings.

**Current `Binding` interface** (`src/bindings.ts:35-59`) — the binding the rest of the app consumes. Fields actually read downstream:
- `provider: 'slack'`, `externalAccountId` (team id), `externalSpaceId` (channel id), `transportBotId` (bot user id, for @mention parsing), `projectId`, `defaultProfile`, `model?`, `sandboxMode`, `transportTokenRef`, `connections?`, `status`.
- `bindingBySlack(accountId, spaceId)` matches `externalAccountId === accountId && externalSpaceId === spaceId && status === 'active'`.
- `bindingByProject(projectId)` matches `projectId === projectId && status === 'active'`.

**Current demo seed row** (`src/bindings.ts:68-85`): team `T0B6VB415TQ`, channel `C0B6VFMVCUW`, bot `U0B6UB2E5HT`, `projectId: 'demo'`, `transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT'`, with the github + notion connections. This stays as the code seed (keeps the demo working with an empty bindings table).

**Skill query call sites to widen** (`src/skills.ts`):
- `loadSkillCatalog(db, projectId)` — line ~53-59, `SELECT name, description ... WHERE project_id=? AND state='active' ORDER BY name`.
- `loadActiveSkillBody(db, projectId, name)` — line ~63-69, `SELECT body_md ... WHERE project_id=? AND name=? AND state='active'`.
- `loadRunnableSkillBody(db, projectId, name)` — line ~81-89 (scheduled fire). **Decision: this one does NOT read global** — scheduled jobs point at a channel's own reminder→skill; a global skill is never the target of a per-channel reminder, and reading global here would let a channel's reminder resolve a global body it doesn't own. Keep it channel-only.
- WRITES (`save_skill`/`archive_skill`/`restore_skill` in `skillTools`, lines ~91-182) stay channel-scoped — DO NOT touch them.

**Deploy/migration reality:**
- Apply a migration: `npx wrangler d1 execute hatchery-skills --remote --file=migrations/<file>.sql`
- Deploy code: `npx flue build --target cloudflare && npx wrangler deploy --name hatchery`
- Setting a secret does NOT deploy.
- `tsc clean` (`npx tsc --noEmit`) and `npm test` are SEPARATE gates; both must pass. Verify against committed state.
- Bash note (macOS): no `timeout`; run long commands directly. The `wrangler tail` JSON format is multi-line — irrelevant here.

---

## File Structure

**Create:**
- `migrations/0006_bindings.sql` — the `bindings` D1 table (mirror of connections).
- `seeds/global/personality.md` — baseline personality skill for `__global__`.
- `seeds/global/using-connections.md` — baseline how-to-use-connections skill for `__global__`.
- `seeds/seed-global.mjs` — emits SQL to seed `__global__` skills (mirror of `seeds/seed.mjs`, fixed projectId `__global__`).

**Modify:**
- `src/bindings.ts` — add `BindingRecord` D1 type; `loadBindings`, `loadBindingSpecs`/merge helpers, `upsertBinding`, `autoCreateBinding`; make `bindingBySlack`/`bindingByProject` D1-aware (async, seed∪D1). Add a `KNOWN_TEAM_IDS` allowlist.
- `.flue/app.ts` — `/slack/events`: when no binding matches AND the team is allowlisted, `autoCreateBinding` then re-resolve and dispatch. (`bindingBySlack`/`byProject` calls become `await`.)
- `src/skills.ts` — `loadSkillCatalog` + `loadActiveSkillBody` union `__global__` with the channel (channel wins on name).
- `src/bindings.test.ts` (NEW test file) — binding D1 cascade + auto-create + allowlist.
- `src/skills.test.ts` — add global-merge tests.
- `package.json` — add `src/bindings.test.ts` to the `test` script.

**Note on `bindingBySlack`/`bindingByProject` becoming async:** every caller must be updated to `await`. Callers (verified by grep target list in Task 4): `.flue/app.ts` (`bindingBySlack` in `/slack/events`, `bindingByProject` in `/__internal/scheduled` and `/__internal/reflect-sweep` is via `agentInstanceId`… confirm), `.flue/agents/project.ts` (`bindingByProject` in the initializer). Task 4 enumerates and fixes them.

---

## Task 1: Bindings D1 table (migration)

**Files:**
- Create: `migrations/0006_bindings.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Per-channel binding METADATA (Milestone 1), in the hatchery-skills D1 db.
-- Apply: npx wrangler d1 execute hatchery-skills --remote --file=migrations/0006_bindings.sql
--
-- Why: src/bindings.ts was ONE hardcoded literal row (one team, one channel), so the bot
-- ignored every other channel. This table lets the gateway auto-create a binding the first
-- time the bot is @mentioned in a new channel of the KNOWN team — no redeploy, one project
-- per channel. Mirrors the connections D1+seed cascade (migration 0005): the bindings.ts
-- seed is a CODE fallback (keeps the demo working with an empty table); D1 rows are the live
-- source, merged OVER the seed by project_id.
--
-- The bot token is NOT stored here — only its REF (transport_token_ref), a Worker-secret
-- name, exactly like the connections table stores token_ref. The secret stays in CF KMS.
--
-- HARD LINE: rows are written by the GATEWAY on a verified Slack signature for an allowlisted
-- team, or by an operator. The agent (model) never writes here.

CREATE TABLE IF NOT EXISTS bindings (
  project_id          TEXT    NOT NULL,            -- = the Slack channel id (the isolation key)
  provider            TEXT    NOT NULL DEFAULT 'slack',
  external_account_id TEXT    NOT NULL,            -- Slack team id
  external_space_id   TEXT    NOT NULL,            -- Slack channel id (= project_id today)
  transport_bot_id    TEXT    NOT NULL,            -- bot user id, for @mention parsing
  transport_token_ref TEXT    NOT NULL,            -- Worker-secret NAME for the bot token (never the token)
  default_profile     TEXT    NOT NULL DEFAULT 'project-assistant',
  model               TEXT,                        -- optional model pin; NULL → DEFAULT_MODEL
  status              TEXT    NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  created_by          TEXT,                        -- 'gateway-autocreate' | 'admin' | operator note
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (project_id)
);

CREATE INDEX IF NOT EXISTS idx_bindings_slack ON bindings(external_account_id, external_space_id, status);
```

- [ ] **Step 2: Apply the migration to remote D1**

Run: `npx wrangler d1 execute hatchery-skills --remote --file=migrations/0006_bindings.sql`
Expected: `Executed N queries`, success true, `num_tables` increases by 1. No error.

- [ ] **Step 3: Verify the table exists**

Run: `npx wrangler d1 execute hatchery-skills --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name='bindings';"`
Expected: one row, `bindings`.

- [ ] **Step 4: Commit**

```bash
git add migrations/0006_bindings.sql
git commit -m "feat(bindings): add bindings D1 table (per-channel metadata)"
```

---

## Task 2: D1 binding records — load + upsert (pure functions, TDD)

**Files:**
- Modify: `src/bindings.ts` (add types + D1 functions; do NOT yet change `bindingBySlack`/`byProject`)
- Create: `src/bindings.test.ts`
- Modify: `package.json` (add the new test file to `test`)

- [ ] **Step 1: Write the failing test**

Create `src/bindings.test.ts`:

```ts
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
      const [projectId, provider, accountId, spaceId, botId, tokenRef, profile, model, status, createdBy, createdAt, updatedAt] = a;
      // ON CONFLICT(project_id) DO NOTHING — a second insert for the same project_id is a no-op.
      if (this.rows.some((r) => r.project_id === projectId)) return;
      this.rows.push({
        project_id: projectId, provider, external_account_id: accountId, external_space_id: spaceId,
        transport_bot_id: botId, transport_token_ref: tokenRef, default_profile: profile, model,
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx src/bindings.test.ts`
Expected: FAIL — `loadBindings`/`upsertBinding`/`autoCreateBinding`/`isKnownTeam`/`bindingRecordToBinding`/`BindingRecord` are not exported (import error or `is not a function`).

- [ ] **Step 3: Add the D1 layer to `src/bindings.ts`**

Add the import near the top of `src/bindings.ts` (after the existing header comment, before `export type SandboxMode`):

```ts
import type { D1Like } from './skills';
```

Add the allowlist constant after `DEFAULT_AGENT_SLUG` (around line 15):

```ts
// Teams whose channels may be AUTO-PROVISIONED by the gateway on first @mention. This is the wall
// that keeps "any channel" from becoming "any workspace": a stray @mention from an unlisted team is
// never auto-bound. Same-workspace scope (Milestone 1) — multi-workspace OAuth install is deferred.
export const KNOWN_TEAM_IDS: readonly string[] = ['T0B6VB415TQ']; // Ecodark

export function isKnownTeam(teamId: string): boolean {
  return !!teamId && KNOWN_TEAM_IDS.includes(teamId);
}
```

Add the D1 record type + functions at the END of `src/bindings.ts` (after `bindingByProject`):

```ts
// ── D1 binding layer (per-channel, auto-provisioned) ─────────────────────────────────────────────
// Mirrors the connections D1+seed cascade (src/connections.ts): the bindings.ts `bindings` array is
// a CODE SEED; D1 rows are the live source, merged OVER the seed by project_id. The bot token lives
// as a Worker secret referenced by transport_token_ref — never stored in this table.

export interface BindingRecord {
  projectId: string;
  provider: 'slack';
  externalAccountId: string;
  externalSpaceId: string;
  transportBotId: string;
  transportTokenRef: string;
  defaultProfile: string;
  model?: string;
  status: 'active' | 'disabled';
}

/** Map a D1 binding record to the full Binding the app consumes (defaults for fields not stored). */
export function bindingRecordToBinding(r: BindingRecord): Binding {
  return {
    provider: r.provider,
    externalAccountId: r.externalAccountId,
    externalSpaceId: r.externalSpaceId,
    transportBotId: r.transportBotId,
    projectId: r.projectId,
    defaultProfile: r.defaultProfile,
    model: r.model,
    sandboxMode: 'virtual',
    transportTokenRef: r.transportTokenRef,
    // connections come from the D1 connections table (loadConnectionSpecs merges over this seed);
    // an auto-created channel starts with none until an operator/self-serve flow adds them.
    connections: undefined,
    status: r.status,
  };
}

/** Live binding rows. Pass a projectId to filter to one; omit for all. Metadata only — never a token. */
export async function loadBindings(db: D1Like, projectId?: string): Promise<BindingRecord[]> {
  const stmt = projectId
    ? db.prepare(
        'SELECT project_id, provider, external_account_id, external_space_id, transport_bot_id, transport_token_ref, default_profile, model, status FROM bindings WHERE project_id=?',
      ).bind(projectId)
    : db.prepare(
        'SELECT project_id, provider, external_account_id, external_space_id, transport_bot_id, transport_token_ref, default_profile, model, status FROM bindings',
      ).bind();
  const { results } = await stmt.all<{
    project_id: string; provider: string; external_account_id: string; external_space_id: string;
    transport_bot_id: string; transport_token_ref: string; default_profile: string; model: string | null; status: string;
  }>();
  return (results ?? []).map((r) => ({
    projectId: r.project_id,
    provider: 'slack',
    externalAccountId: r.external_account_id,
    externalSpaceId: r.external_space_id,
    transportBotId: r.transport_bot_id,
    transportTokenRef: r.transport_token_ref,
    defaultProfile: r.default_profile,
    model: r.model ?? undefined,
    status: r.status === 'disabled' ? 'disabled' : 'active',
  }));
}

export interface AutoCreateBindingInput {
  teamId: string;
  channelId: string;
  transportBotId: string;
  transportTokenRef: string;
  model?: string;
  createdBy?: string;
}

/** Upsert a binding row. INSERT ... ON CONFLICT(project_id) DO NOTHING — race-safe: two near-simultaneous
 *  @mentions in a new channel create exactly one row. The bot token is referenced by name, never stored. */
export async function autoCreateBinding(db: D1Like, input: AutoCreateBindingInput): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO bindings(project_id, provider, external_account_id, external_space_id, transport_bot_id, transport_token_ref, default_profile, model, status, created_by, created_at, updated_at)
       VALUES(?, 'slack', ?, ?, ?, ?, 'project-assistant', ?, 'active', ?, ?, ?)
       ON CONFLICT(project_id) DO NOTHING`,
    )
    .bind(
      input.channelId, // project_id = channel id
      input.teamId,
      input.channelId, // external_space_id = channel id
      input.transportBotId,
      input.transportTokenRef,
      input.model ?? null,
      input.createdBy ?? 'gateway-autocreate',
      now,
      now,
    )
    .run();
}

/** Operator/admin upsert (full update). Distinct from autoCreateBinding (which never overwrites): this
 *  one updates an existing row. Reserved for an admin path; not used by the gateway. */
export async function upsertBinding(db: D1Like, rec: BindingRecord): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO bindings(project_id, provider, external_account_id, external_space_id, transport_bot_id, transport_token_ref, default_profile, model, status, created_by, created_at, updated_at)
       VALUES(?, 'slack', ?, ?, ?, ?, ?, ?, ?, 'admin', ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         external_account_id=excluded.external_account_id,
         external_space_id=excluded.external_space_id,
         transport_bot_id=excluded.transport_bot_id,
         transport_token_ref=excluded.transport_token_ref,
         default_profile=excluded.default_profile,
         model=excluded.model,
         status=excluded.status,
         updated_at=excluded.updated_at`,
    )
    .bind(
      rec.projectId, rec.externalAccountId, rec.externalSpaceId, rec.transportBotId, rec.transportTokenRef,
      rec.defaultProfile, rec.model ?? null, rec.status, now, now,
    )
    .run();
}
```

- [ ] **Step 4: Add the new test file to the `test` script**

In `package.json`, change the `test` script to append the bindings test (run it after connections):

```json
"test": "tsx src/memory.test.ts && tsx src/reflection.test.ts && tsx src/skills.test.ts && tsx src/conversations.test.ts && tsx src/connections.test.ts && tsx src/bindings.test.ts"
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx src/bindings.test.ts`
Expected: PASS — `4 passed, 0 failed`.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 7: Commit**

```bash
git add src/bindings.ts src/bindings.test.ts package.json
git commit -m "feat(bindings): D1 binding records + race-safe autoCreate + team allowlist"
```

---

## Task 3: Make `bindingBySlack`/`bindingByProject` D1-aware (seed ∪ D1)

**Files:**
- Modify: `src/bindings.ts` (`bindingBySlack`, `bindingByProject` → async, seed-first then D1)
- Modify: `src/bindings.test.ts` (add cascade tests)

The current signatures (synchronous, seed-only):
```ts
export function bindingBySlack(accountId: string, spaceId: string): Binding | undefined { ... }
export function bindingByProject(projectId: string): Binding | undefined { ... }
```
They become async and take an optional `db`. Seed is checked FIRST (so the demo row and any future hardcoded row win and need no DB), then D1.

- [ ] **Step 1: Write the failing test**

Append to `src/bindings.test.ts` (before the `main` runner). Reuse the `FakeD1` class already in the file:

```ts
test('bindingBySlack: seed wins first; falls back to D1 for an auto-created channel', async () => {
  const db = new FakeD1();
  // the demo seed row resolves with NO db touch
  const seedHit = await bindingBySlack('T0B6VB415TQ', 'C0B6VFMVCUW', db);
  assert.equal(seedHit?.projectId, 'demo', 'seed row resolves');

  // an unknown channel is not in the seed → null until a D1 row exists
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
```

Also update the import line at the top of the test to include `bindingBySlack, bindingByProject`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx src/bindings.test.ts`
Expected: FAIL — either a TS/runtime error that `bindingBySlack` takes no 3rd arg / is not async (returns a `Binding | undefined`, not a Promise), or the `C_NEW`/`C_P`/`C_OFF` assertions fail because the current functions only read the seed.

- [ ] **Step 3: Rewrite the two resolvers to be async + D1-aware**

Replace the existing `bindingBySlack` and `bindingByProject` in `src/bindings.ts` with:

```ts
/** Route an inbound message to its project by provider account + space. Seed (bindings.ts) is checked
 *  FIRST so the demo row resolves with no DB; then live D1 rows (auto-created per channel). Only active
 *  bindings match. `db` is optional so non-DB call sites/tests still resolve the seed. */
export async function bindingBySlack(accountId: string, spaceId: string, db?: D1Like): Promise<Binding | undefined> {
  const seed = bindings.find(
    (b) => b.externalAccountId === accountId && b.externalSpaceId === spaceId && b.status === 'active',
  );
  if (seed) return seed;
  if (!db) return undefined;
  const rows = await loadBindings(db).catch(() => [] as BindingRecord[]);
  const rec = rows.find((r) => r.externalAccountId === accountId && r.externalSpaceId === spaceId && r.status === 'active');
  return rec ? bindingRecordToBinding(rec) : undefined;
}

/** Resolve a project's binding by projectId. Seed first, then live D1. Only active bindings match. */
export async function bindingByProject(projectId: string, db?: D1Like): Promise<Binding | undefined> {
  const seed = bindings.find((b) => b.projectId === projectId && b.status === 'active');
  if (seed) return seed;
  if (!db) return undefined;
  const rows = await loadBindings(db, projectId).catch(() => [] as BindingRecord[]);
  const rec = rows.find((r) => r.status === 'active');
  return rec ? bindingRecordToBinding(rec) : undefined;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx src/bindings.test.ts`
Expected: PASS — `7 passed, 0 failed`.

- [ ] **Step 5: Typecheck (EXPECT failures in callers — that's Task 4)**

Run: `npx tsc --noEmit`
Expected: errors ONLY of the form "`'Binding | undefined' is not assignable`" / "property X does not exist on `Promise<...>`" at the call sites in `.flue/app.ts` and `.flue/agents/project.ts` (they call the now-async functions without `await`). These are fixed in Task 4. If you see errors in any OTHER file, stop and investigate.

- [ ] **Step 6: Commit**

```bash
git add src/bindings.ts src/bindings.test.ts
git commit -m "feat(bindings): bindingBySlack/byProject become async, seed-first then D1"
```

---

## Task 4: Update callers to await; auto-create on first @mention in the gateway

**Files:**
- Modify: `.flue/app.ts` (`/slack/events` auto-create + await; `/__internal/scheduled` + `/__internal/reflect-sweep` await `bindingByProject`)
- Modify: `.flue/agents/project.ts` (initializer awaits `bindingByProject`)

- [ ] **Step 1: Enumerate every caller**

Run: `grep -rn "bindingBySlack\|bindingByProject" .flue/ src/ | grep -v ".test.ts"`
Expected call sites to fix (anything NOT in `src/bindings.ts` definitions):
- `.flue/app.ts` — `bindingBySlack(...)` in `/slack/events`; `bindingByProject(...)` in `/__internal/scheduled`.
- `.flue/agents/project.ts` — `bindingByProject(projectId)` in the initializer.
Confirm the grep output matches; fix exactly those.

- [ ] **Step 2: Fix `.flue/agents/project.ts` (await + pass db)**

The initializer already has `const db = env.DB as D1Like | undefined;` AFTER the binding lookup. The current line near the top:

```ts
  const { projectId, slug } = parseAgentInstanceId(ctx.id);
  const binding = bindingByProject(projectId);
```

Becauseit needs `db`, move the `env`/`db` resolution ABOVE the binding lookup and await it. Replace those two lines + the early `env`/`db` block so the order is:

```ts
  const { projectId, slug } = parseAgentInstanceId(ctx.id);
  const env = ctx.env as Record<string, unknown>;
  const db = env.DB as D1Like | undefined;
  const binding = await bindingByProject(projectId, db);
```

Then DELETE the later duplicate declarations of `env` and `db` (the original lines `const env = ctx.env as Record<string, unknown>;` and `const db = env.DB as D1Like | undefined;` that sat after the `if (!binding)` block) so they aren't declared twice. Keep the other `env`-derived lines (`ticker`, `heartbeatToken`) where they are.

- [ ] **Step 3: Fix `.flue/app.ts` `/__internal/scheduled` (await)**

Find:
```ts
  const binding = bindingByProject(body.projectId);
  if (!binding || binding.status !== 'active') return c.json({ skipped: 'no active binding' });
```
Replace with (pass the DB so a scheduled fire resolves an auto-created channel project):
```ts
  const binding = await bindingByProject(body.projectId, c.env.DB);
  if (!binding || binding.status !== 'active') return c.json({ skipped: 'no active binding' });
```

- [ ] **Step 4: Fix `.flue/app.ts` `/slack/events` — await + auto-create**

Find the current binding lookup:
```ts
  const binding = bindingBySlack(body.team_id ?? '', ev.channel);
  if (!binding) return c.body(null, 200); // unbound channel: acknowledge, never dispatch
```

Replace with the auto-create-on-known-team logic. This must run AFTER signature verification and AFTER the `ev` shape guard (both already above this line), so we only auto-create on a verified Slack event for a real user message:

```ts
  const teamId = body.team_id ?? '';
  let binding = await bindingBySlack(teamId, ev.channel, c.env.DB);
  if (!binding) {
    // No binding yet. If this is a channel of a KNOWN team and the bot is being addressed, the
    // gateway provisions a per-channel project (HARD LINE: gateway-created on a verified Slack
    // signature for an allowlisted team — NOT the agent). Otherwise acknowledge and stay silent.
    const addressed = mentionsBot(ev.text ?? '', BOT_ID_FOR_AUTOCREATE);
    if (c.env.DB && isKnownTeam(teamId) && addressed) {
      await autoCreateBinding(c.env.DB, {
        teamId,
        channelId: ev.channel,
        transportBotId: BOT_ID_FOR_AUTOCREATE,
        transportTokenRef: DEFAULT_TRANSPORT_TOKEN_REF,
      });
      binding = await bindingBySlack(teamId, ev.channel, c.env.DB);
    }
    if (!binding) return c.body(null, 200); // unknown team, not addressed, or create failed → silent
  }
```

**The auto-create needs the bot id + token ref for the workspace.** These are workspace-level constants (one install). Add them near the top of `.flue/app.ts` imports/region. Source the values from the demo seed (same workspace): bot `U0B6UB2E5HT`, token ref `SLACK_BOT_TOKEN_DEFAULT`. Add after the imports:

```ts
// Workspace-level transport identity for gateway auto-provisioning (same-workspace Milestone 1:
// one bot install, reused across all channels of the known team). These mirror the demo seed row.
const BOT_ID_FOR_AUTOCREATE = 'U0B6UB2E5HT';
const DEFAULT_TRANSPORT_TOKEN_REF = 'SLACK_BOT_TOKEN_DEFAULT';
```

Update the imports from `../src/bindings` in `.flue/app.ts` to include the new symbols:
```ts
import { bindings, bindingBySlack, bindingByProject, agentInstanceId, autoCreateBinding, isKnownTeam } from '../src/bindings';
```

**Note on the engage policy below this block:** the existing code after the binding lookup does the @mention / thread-continuation check (`mentionsBot(text, binding.transportBotId)` …). That stays as-is and still runs — it re-checks engagement using the resolved binding's `transportBotId`. The auto-create `addressed` check is an EARLY gate (don't provision a project for a non-addressed message); the existing engage check is the authoritative one for whether to dispatch. Leave the existing engage block unchanged.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0, no output. (All await/async mismatches from Task 3 Step 5 are now resolved.)

- [ ] **Step 6: Full test suite**

Run: `npm test`
Expected: every file passes; tallies end with `7 passed, 0 failed` for bindings and no failures elsewhere.

- [ ] **Step 7: Build (catch Flue/bundler issues before deploy)**

Run: `npx flue build --target cloudflare`
Expected: `Build complete`, exit 0.

- [ ] **Step 8: Commit**

```bash
git add .flue/app.ts .flue/agents/project.ts
git commit -m "feat(gateway): auto-create per-channel binding on first @mention (team-allowlisted)"
```

---

## Task 5: Global skills merge (`__global__` ∪ channel)

**Files:**
- Modify: `src/skills.ts` (`loadSkillCatalog`, `loadActiveSkillBody`)
- Modify: `src/skills.test.ts` (add global-merge tests)

- [ ] **Step 1: Write the failing test**

The existing `src/skills.test.ts` has a `FakeD1` whose `select` handles the current single-`project_id` queries. The new queries use `project_id IN (?, ?)`. Add handling + tests.

First, extend the `FakeD1.select` in `src/skills.test.ts` to recognize the two-project IN queries. Find the `private select(q, v)` method and add these branches at the TOP of it (before the existing `if (q.includes('body_md, state'))`):

```ts
    // Global-merge catalog: WHERE project_id IN (?, ?) AND state='active'
    if (q.includes('SELECT name, description') && q.includes('IN (')) {
      const [pA, pB] = v as [string, string];
      const seen = new Map<string, { name: string; description: string }>();
      // channel wins on name: iterate channel project LAST so it overwrites global.
      const order = [pA, pB]; // caller binds [GLOBAL, channel]; channel is pB → process global then channel
      for (const pid of order) {
        for (const r of this.rows.filter((x) => x.project_id === pid && x.state === 'active')) {
          seen.set(r.name, { name: r.name, description: r.description });
        }
      }
      return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
    }
    // Global-merge body: WHERE name=? AND project_id IN (?, ?) AND state='active', channel wins
    if (q.includes('SELECT body_md') && q.includes('IN (')) {
      const [name, pA, pB] = v as [string, string, string];
      const channel = this.rows.find((x) => x.project_id === pB && x.name === name && x.state === 'active');
      if (channel) return [{ body_md: channel.body_md }];
      const global = this.rows.find((x) => x.project_id === pA && x.name === name && x.state === 'active');
      return global ? [{ body_md: global.body_md }] : [];
    }
```

Now add the tests (before the existing `main`/runner in `src/skills.test.ts`). The file's helper to insert a row is the `FakeD1` `rows` array; push rows directly as the other tests do. Match the existing row shape used in that file:

```ts
test('catalog merges __global__ with the channel; channel wins on name', async () => {
  const db = new FakeD1();
  const base = { description: 'd', body_md: 'b', state: 'active', created_by: 'seed', updated_by: 'seed', created_at: 1, updated_at: 1, archived_at: null };
  db.rows.push({ project_id: '__global__', name: 'using-connections', ...base });
  db.rows.push({ project_id: '__global__', name: 'personality', description: 'global-personality', body_md: 'GLOBAL', state: 'active', created_by: 'seed', updated_by: 'seed', created_at: 1, updated_at: 1, archived_at: null });
  db.rows.push({ project_id: 'C_X', name: 'personality', description: 'channel-personality', body_md: 'CHANNEL', state: 'active', created_by: 'agent', updated_by: 'agent', created_at: 1, updated_at: 1, archived_at: null });
  db.rows.push({ project_id: 'C_X', name: 'channel-only', ...base });

  const cat = await loadSkillCatalog(db, 'C_X');
  const names = cat.map((c) => c.name);
  assert.deepEqual(names, ['channel-only', 'personality', 'using-connections'], 'global ∪ channel, sorted, deduped');
  assert.equal(cat.find((c) => c.name === 'personality')!.description, 'channel-personality', 'channel wins on name');
});

test('loadActiveSkillBody: channel body wins over global; falls back to global', async () => {
  const db = new FakeD1();
  db.rows.push({ project_id: '__global__', name: 'using-connections', description: 'd', body_md: 'GLOBAL-BODY', state: 'active', created_by: 'seed', updated_by: 'seed', created_at: 1, updated_at: 1, archived_at: null });
  db.rows.push({ project_id: '__global__', name: 'personality', description: 'd', body_md: 'GLOBAL-P', state: 'active', created_by: 'seed', updated_by: 'seed', created_at: 1, updated_at: 1, archived_at: null });
  db.rows.push({ project_id: 'C_X', name: 'personality', description: 'd', body_md: 'CHANNEL-P', state: 'active', created_by: 'agent', updated_by: 'agent', created_at: 1, updated_at: 1, archived_at: null });

  assert.equal(await loadActiveSkillBody(db, 'C_X', 'using-connections'), 'GLOBAL-BODY', 'inherits global');
  assert.equal(await loadActiveSkillBody(db, 'C_X', 'personality'), 'CHANNEL-P', 'channel overrides global');
  assert.equal(await loadActiveSkillBody(db, 'C_X', 'nope'), null, 'absent in both → null');
});

test('a channel agent writing its own skill does NOT touch __global__', async () => {
  const db = new FakeD1();
  // simulate save into the channel project only (skillTools is constructed with the channel projectId)
  db.rows.push({ project_id: 'C_X', name: 'mine', description: 'd', body_md: 'b', state: 'active', created_by: 'agent', updated_by: 'agent', created_at: 1, updated_at: 1, archived_at: null });
  const globalCat = await loadSkillCatalog(db, '__global__');
  assert.equal(globalCat.length, 0, '__global__ unaffected by a channel write');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx src/skills.test.ts`
Expected: FAIL — the merge tests fail because `loadSkillCatalog`/`loadActiveSkillBody` still query a single `project_id`, so `personality` resolves to only the channel row (catalog) but `using-connections` from `__global__` is MISSING (catalog returns `['channel-only','personality']`, not including `using-connections`), and `loadActiveSkillBody(...,'using-connections')` returns `null`.

- [ ] **Step 3: Widen the two read queries in `src/skills.ts`**

Add a sentinel constant near the top of `src/skills.ts` (after the imports):

```ts
// Reserved project holding the shared skill baseline every channel inherits. Double-underscore can't
// collide with a Slack channel id (e.g. "C0B6VFM…"). Skills here are seeded/operator-written; a
// channel agent can only ever write its OWN project's skills (save/archive/restore stay channel-scoped),
// so it can never edit the shared baseline.
export const GLOBAL_PROJECT_ID = '__global__';
```

Replace `loadSkillCatalog`:

```ts
// L1: the cheap catalog (names + descriptions of ACTIVE skills) injected into the system prompt.
// Merges the shared __global__ baseline with the channel's own skills; the channel WINS on name.
export async function loadSkillCatalog(db: D1Like, projectId: string): Promise<{ name: string; description: string }[]> {
  const { results } = await db
    .prepare(
      "SELECT name, description, project_id FROM skills WHERE project_id IN (?, ?) AND state='active' ORDER BY name",
    )
    .bind(GLOBAL_PROJECT_ID, projectId)
    .all<{ name: string; description: string; project_id: string }>();
  // channel overrides global on name collision.
  const byName = new Map<string, { name: string; description: string }>();
  for (const r of results ?? []) {
    if (r.project_id === GLOBAL_PROJECT_ID && byName.has(r.name)) continue; // channel already set it
    byName.set(r.name, { name: r.name, description: r.description });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
```

Wait — the dedup above is order-dependent and `ORDER BY name` interleaves the two projects unpredictably for the "skip global if channel set it" rule. Use a deterministic two-pass instead. Replace the body with:

```ts
export async function loadSkillCatalog(db: D1Like, projectId: string): Promise<{ name: string; description: string }[]> {
  const { results } = await db
    .prepare(
      "SELECT name, description, project_id FROM skills WHERE project_id IN (?, ?) AND state='active'",
    )
    .bind(GLOBAL_PROJECT_ID, projectId)
    .all<{ name: string; description: string; project_id: string }>();
  const byName = new Map<string, { name: string; description: string }>();
  // global first, then channel overwrites on name.
  for (const r of results ?? []) if (r.project_id === GLOBAL_PROJECT_ID) byName.set(r.name, { name: r.name, description: r.description });
  for (const r of results ?? []) if (r.project_id === projectId) byName.set(r.name, { name: r.name, description: r.description });
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
```

Replace `loadActiveSkillBody`:

```ts
// L2 (active-only): full body of an ACTIVE skill, channel-first then __global__ fallback. Used by the
// load_skill tool and to apply the `personality` skill. An archived skill is not loadable → null.
export async function loadActiveSkillBody(db: D1Like, projectId: string, name: string): Promise<string | null> {
  const { results } = await db
    .prepare(
      "SELECT body_md, project_id FROM skills WHERE name=? AND project_id IN (?, ?) AND state='active'",
    )
    .bind(name, GLOBAL_PROJECT_ID, projectId)
    .all<{ body_md: string; project_id: string }>();
  const channel = (results ?? []).find((r) => r.project_id === projectId);
  if (channel) return channel.body_md;
  const global = (results ?? []).find((r) => r.project_id === GLOBAL_PROJECT_ID);
  return global?.body_md ?? null;
}
```

**Leave `loadRunnableSkillBody` (scheduled fire) UNCHANGED — channel-only.** A per-channel reminder targets a channel skill; a global skill is never a reminder target, and reading global here would let a channel reminder resolve a body it doesn't own.

**Update the test FakeD1 `loadActiveSkillBody` branch:** the new query selects `body_md, project_id` and uses `.all()` not `.first()`. The test FakeD1 branch added in Step 1 returns `[{ body_md }]` — confirm it keys off `q.includes('SELECT body_md') && q.includes('IN (')` (it does). The OLD `loadActiveSkillBody` single-project branch in the existing FakeD1 (`if (q.includes('SELECT body_md'))` without `IN (`) is now dead for this function but still used by nothing else — leave it; it won't match the new `IN (` query because the new branch is checked first.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx src/skills.test.ts`
Expected: PASS — the original 8 skill tests PLUS the 3 new ones = `11 passed, 0 failed`.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 6: Commit**

```bash
git add src/skills.ts src/skills.test.ts
git commit -m "feat(skills): merge __global__ baseline with channel skills (channel wins; writes stay channel-scoped)"
```

---

## Task 6: Seed the `__global__` baseline skills

**Files:**
- Create: `seeds/global/personality.md`
- Create: `seeds/global/using-connections.md`
- Create: `seeds/seed-global.mjs`

- [ ] **Step 1: Write the baseline personality skill**

Create `seeds/global/personality.md`:

```markdown
---
name: personality
description: Use always — the default role and voice for a freshly-provisioned channel agent until the channel sets its own.
---

# Personality (default)

You are a capable, straightforward project assistant working in this Slack channel. You are
helpful, concise, and honest. You do real work with your tools rather than describing what you
would do.

## Voice
- Plain, direct, friendly. No filler, no ceremony.
- Say what you did and what happened. If something failed or you couldn't do it, say so plainly
  rather than papering over it.

## How you work here
- This channel is your own project space — your memory and connected tools are scoped to it.
- When you need access to an external tool you don't have yet, say so and ask the person to
  connect it. You request connections; you never handle raw credentials yourself.

A channel can replace this by saving its own `personality` skill — that one overrides this default.
```

- [ ] **Step 2: Write the using-connections how-to skill**

Create `seeds/global/using-connections.md`:

```markdown
---
name: using-connections
description: Use when a task needs an external tool (GitHub, Notion, etc.) — explains how connections work and what to do when one isn't connected yet.
---

# Using connections

Your external tools come from CONNECTIONS scoped to this channel. The "YOUR CONNECTIONS" block in
your context lists what's connected and what's available but not yet wired.

## When a tool you need is connected
- Just call it. For a connected provider you'll have either typed tools or a single
  `<provider>_call_api(method, path, body)` tool — compose the request from your knowledge of that
  API. Reads are free; writes may require approval.

## When a tool you need is NOT connected
- Tell the person plainly that the provider isn't connected yet and that they (or an operator) need
  to connect it. You CANNOT connect it yourself and you must NEVER accept a token, key, or password
  pasted into the channel — a secret in chat is already compromised.
- Keep API work tight: reach the answer in as few calls as you can; don't fan out over every result.
```

- [ ] **Step 3: Write the global seeder script**

Create `seeds/seed-global.mjs` (mirror of `seeds/seed.mjs`, fixed to `__global__`, reading from `seeds/global/`):

```js
// Seed the __global__ project's shared skill baseline (inherited by every channel).
//
// Usage:
//   node seeds/seed-global.mjs > /tmp/seed-global.sql
//   npx wrangler d1 execute hatchery-skills --remote --file=/tmp/seed-global.sql
//
// These are the shared baseline every auto-provisioned channel inherits (a channel can override any
// of them by saving its own skill of the same name). Operator/seed-written ONLY — a channel agent
// can never write __global__.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'global');
const projectId = '__global__';
const esc = (s) => s.replace(/'/g, "''");

const stmts = readdirSync(dir)
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map((f) => {
    const md = readFileSync(join(dir, f), 'utf8');
    const fm = md.match(/^\s*---\s*\n([\s\S]*?)\n---/)[1];
    const name = fm.match(/^name:\s*(.+)$/m)[1].trim();
    const description = fm.match(/^description:\s*(.+)$/m)[1].trim();
    if (description.length > 1024) throw new Error(`${name}: description exceeds 1024 chars`);
    return `INSERT INTO skills(project_id,name,description,body_md,state,created_by,updated_by,created_at,updated_at,archived_at) VALUES('${esc(projectId)}','${esc(name)}','${esc(description)}','${esc(md)}','active','seed','seed',1780000000000,1780000000000,NULL) ON CONFLICT(project_id,name) DO UPDATE SET description=excluded.description, body_md=excluded.body_md, state='active', updated_by='seed', updated_at=excluded.updated_at, archived_at=NULL;`;
  });

process.stdout.write(stmts.join('\n') + '\n');
```

- [ ] **Step 4: Generate the seed SQL and verify it parses**

Run: `node seeds/seed-global.mjs > /tmp/seed-global.sql && head -c 200 /tmp/seed-global.sql`
Expected: SQL beginning `INSERT INTO skills(project_id,name,...) VALUES('__global__','personality',...`. Two INSERT statements total (personality, using-connections).

- [ ] **Step 5: Apply the seed to remote D1**

Run: `npx wrangler d1 execute hatchery-skills --remote --file=/tmp/seed-global.sql`
Expected: `Executed 2 queries`, success true.

- [ ] **Step 6: Verify the global skills landed**

Run: `npx wrangler d1 execute hatchery-skills --remote --command "SELECT project_id, name FROM skills WHERE project_id='__global__';"`
Expected: two rows — `__global__ | personality`, `__global__ | using-connections`.

- [ ] **Step 7: Commit**

```bash
git add seeds/global/personality.md seeds/global/using-connections.md seeds/seed-global.mjs
git commit -m "feat(skills): seed __global__ baseline (personality + using-connections)"
```

---

## Task 7: Full verification + deploy

**Files:** none (verification only)

- [ ] **Step 1: Full test suite green**

Run: `npm test`
Expected: all files pass. Final tallies: memory 5, reflection 5, skills 11, conversations 4, connections 11, bindings 7 — all `0 failed`.

- [ ] **Step 2: Typecheck clean**

Run: `npx tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 3: Build**

Run: `npx flue build --target cloudflare`
Expected: `Build complete`, exit 0.

- [ ] **Step 4: Deploy**

Run: `npx wrangler deploy --name hatchery`
Expected: `Deployed hatchery`, a new `Version ID` printed, exit 0.

- [ ] **Step 5: Live smoke test — auto-binding in a NEW channel**

Manual (operator does this in Slack):
1. Create or pick a channel the bot is NOT yet bound to (anything other than the demo channel `C0B6VFMVCUW`), invite the bot.
2. @mention the bot: `@bot hello`.
3. Expect: the bot REPLIES (previously it would have been silent — no binding). The reply reflects the global baseline personality.

Verify the row was created:
Run: `npx wrangler d1 execute hatchery-skills --remote --command "SELECT project_id, external_space_id, status, created_by FROM bindings;"`
Expected: a row whose `project_id` = the new channel id, `created_by='gateway-autocreate'`, `status='active'`.

- [ ] **Step 6: Live smoke test — global skills present in the new channel**

In the new channel: `@bot what skills do you have?`
Expected: the bot lists at least `using-connections` (the global baseline) even though this channel has authored none of its own.

- [ ] **Step 7: Live smoke test — isolation**

In the new channel: `@bot remember that the sky is green here.` Then in the DEMO channel: `@bot what do you remember about the sky?`
Expected: the demo channel does NOT know the new channel's fact (memory is per-channel/project). Confirms isolation.

- [ ] **Step 8: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "chore: Milestone 1 verification fixes" # only if needed
```

---

## Self-Review notes (for the executor)

- **Spec coverage:** Component 1 → Tasks 1–4; Component 2 → Tasks 5–6; verification → Task 7. Open item #3 (binding columns) resolved in Task 1; #4 (global seed contents) resolved in Task 6. Open items #1/#2 are Component 3 (Milestone 2) — out of scope here.
- **`loadRunnableSkillBody` decision:** stays channel-only (documented in Task 5 Step 3). Do not widen it.
- **The hard line:** auto-create lives ONLY in the gateway (`.flue/app.ts`), gated by `isKnownTeam` + a verified signature + an @mention. No agent tool creates a binding or writes `__global__`. If any task tempts you to add a binding-write or global-write tool to the agent, STOP — that violates the invariant.
- **Async caller sweep:** Task 4 Step 1's grep is the authority on which call sites must be awaited. If the grep shows a caller not listed in Task 4, fix it the same way (add `await` + pass `c.env.DB`/`db`) before moving on.
- **Migrations are remote and idempotent** (`CREATE TABLE IF NOT EXISTS`); re-running is safe. Seeds use `ON CONFLICT DO UPDATE`; re-running re-asserts the baseline.
```
