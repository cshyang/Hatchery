// Connection broker invariants (ADR 0003) — run: npx tsx src/connections.test.ts
// Backend = Worker-secret refs (like the Slack token). The pure functions (state/resolve/tools)
// operate on ConnectionSpec[]; the initializer resolves those from D1 (live) merged over the
// binding seed via loadConnectionSpecs. Load-bearing invariants: gating (tools appear only when
// connected, never the write), the secret-name is never the value, generic-vs-typed selection,
// per-provider method policy, and the D1 metadata layer (operator add without redeploy).

import assert from 'node:assert/strict';
import {
  connectionState,
  resolveConnection,
  connectionTools,
  connectionsBlock,
  loadConnections,
  loadConnectionSpecs,
  upsertConnection,
  PROVIDER_CATALOG,
  requestConnectionTool,
  connectedNotice,
} from './connections';
import { GITHUB_READ_TOOL_NAMES } from './github';
import type { D1Like } from './skills';
import type { Binding, ConnectionSpec } from './bindings';

const GITHUB_CALL_API_TOOL_NAME = 'github_call_api';
const NOTION_CALL_API_TOOL_NAME = 'notion_call_api';

// A minimal binding carrying a connections seed (used by the loadConnectionSpecs tests).
function binding(connections?: ConnectionSpec[]): Binding {
  return {
    provider: 'slack',
    externalAccountId: 'T',
    externalSpaceId: 'C',
    transportBotId: 'U',
    projectId: 'demo',
    defaultProfile: 'p',
    sandboxMode: 'virtual',
    transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
    connections,
    status: 'active',
  };
}

const GH: ConnectionSpec[] = [{ provider: 'github', tokenRef: 'GITHUB_PAT_DEMO', config: { repo: 'o/r' } }];
const NANGO_REF: ConnectionSpec[] = [{ provider: 'notion', connectionRef: 'conn_42', config: {} }];

// In-memory D1 fake — only the two statements connections.ts issues (coupled on purpose).
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
  #mutate(sql: string, args: unknown[]) {
    if (sql.startsWith('INSERT INTO connections')) {
      const [projectId, provider, tokenRef, connectionRef, configJson, status, createdBy, createdAt, updatedAt] = args;
      const existing = this.rows.find((r) => r.project_id === projectId && r.provider === provider);
      const next = {
        project_id: projectId,
        provider,
        token_ref: tokenRef,
        connection_ref: connectionRef,
        config_json: configJson,
        status,
        created_by: createdBy,
        created_at: createdAt,
        updated_at: updatedAt,
      };
      if (existing) Object.assign(existing, { token_ref: tokenRef, connection_ref: connectionRef, config_json: configJson, status, updated_at: updatedAt });
      else this.rows.push(next);
    }
  }
  #query(sql: string, args: unknown[]): Row[] {
    if (sql.startsWith('SELECT provider, token_ref')) {
      const [projectId] = args;
      return this.rows.filter((r) => r.project_id === projectId);
    }
    return [];
  }
}

const tests: [string, () => Promise<void>][] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

test('not connected: a declared spec with no secret present reads as not_connected', async () => {
  const state = connectionState(GH, {});
  assert.equal(state.length, 1);
  assert.equal(state[0].status, 'not_connected');
  assert.equal(resolveConnection(GH, {}, 'github'), null);
});

test('connected: state flips when the Worker secret is present; resolve returns the token + config', async () => {
  const env = { GITHUB_PAT_DEMO: 'ghp_realtoken' };
  const state = connectionState(GH, env);
  assert.equal(state[0].status, 'connected');
  const resolved = resolveConnection(GH, env, 'github');
  assert.equal(resolved?.secret, 'ghp_realtoken');
  assert.equal(resolved?.config.repo, 'o/r');
});

test('no declared connection → nothing, even if a stray secret exists in env', async () => {
  assert.equal(connectionState([], { GITHUB_PAT_DEMO: 'ghp_x' }).length, 0);
  assert.equal(resolveConnection([], { GITHUB_PAT_DEMO: 'ghp_x' }, 'github'), null);
});

test('connectionRef + NANGO_SECRET_KEY present → connected (managed-OAuth backend)', async () => {
  assert.equal(connectionState(NANGO_REF, {}).length, 1);
  assert.equal(connectionState(NANGO_REF, {})[0].status, 'not_connected', 'no platform key → cannot fetch → not connected');
  assert.equal(connectionState(NANGO_REF, { NANGO_SECRET_KEY: 'nk_secret' })[0].status, 'connected');
});

test('a Worker-secret connection still drives state independently of NANGO_SECRET_KEY', async () => {
  // tokenRef path is unaffected by the Nango branch.
  assert.equal(connectionState(GH, { NANGO_SECRET_KEY: 'nk_secret' })[0].status, 'not_connected');
  assert.equal(connectionState(GH, { GITHUB_PAT_DEMO: 'ghp_x' })[0].status, 'connected');
});

test('gating: GitHub typed read tools appear only when connected, and the write is NOT exposed', async () => {
  assert.equal(connectionTools(connectionState(GH, {}), {}).length, 0, 'no tools before the secret is set');
  const env = { GITHUB_PAT_DEMO: 'ghp_realtoken' };
  const creds = resolveConnection(GH, env, 'github')!;
  const names = connectionTools(connectionState(GH, env), { github: creds }).map((t) => t.name as string).sort();
  assert.ok(!names.includes('github_create_issue'), 'write tool must NOT be exposed');
  assert.deepEqual(names, [...GITHUB_READ_TOOL_NAMES].sort(), 'exactly the typed read tools');
});

test('apiMode "generic" exposes ONLY github_call_api, not the typed reads', async () => {
  const GEN: ConnectionSpec[] = [{ provider: 'github', tokenRef: 'GITHUB_PAT_DEMO', config: { repo: 'o/r', apiMode: 'generic' } }];
  const env = { GITHUB_PAT_DEMO: 'ghp_realtoken' };
  const creds = resolveConnection(GEN, env, 'github')!;
  const names = connectionTools(connectionState(GEN, env), { github: creds }).map((t) => t.name as string);
  assert.deepEqual(names, [GITHUB_CALL_API_TOOL_NAME], 'generic mode = exactly the one call tool');
  for (const typed of GITHUB_READ_TOOL_NAMES) assert.ok(!names.includes(typed), `${typed} must be hidden in generic mode`);
});

test('github_call_api refuses non-GET (writes go through the approval gate, not a blind call)', async () => {
  const GEN: ConnectionSpec[] = [{ provider: 'github', tokenRef: 'GITHUB_PAT_DEMO', config: { repo: 'o/r', apiMode: 'generic' } }];
  const env = { GITHUB_PAT_DEMO: 'ghp_realtoken' };
  const creds = resolveConnection(GEN, env, 'github')!;
  const [callApi] = connectionTools(connectionState(GEN, env), { github: creds });
  await assert.rejects(
    () => (callApi.execute as (a: unknown) => Promise<unknown>)({ method: 'POST', path: '/repos/o/r/issues' }),
    /Only GET is allowed/,
  );
});

test('notion defaults to the generic call_api tool (no typed tools), gated on its secret', async () => {
  const NO: ConnectionSpec[] = [{ provider: 'notion', tokenRef: 'NOTION_TOKEN_DEMO', config: {} }];
  assert.equal(connectionTools(connectionState(NO, {}), {}).length, 0, 'no tool before the secret is set');
  const env = { NOTION_TOKEN_DEMO: 'secret_ntn' };
  const creds = resolveConnection(NO, env, 'notion')!;
  const names = connectionTools(connectionState(NO, env), { notion: creds }).map((t) => t.name as string);
  assert.deepEqual(names, [NOTION_CALL_API_TOOL_NAME], 'notion = exactly the one generic call tool');
});

test('notion_call_api allows POST (reads use POST; token is read-only at the provider)', async () => {
  const NO: ConnectionSpec[] = [{ provider: 'notion', tokenRef: 'NOTION_TOKEN_DEMO', config: {} }];
  const env = { NOTION_TOKEN_DEMO: 'secret_ntn' };
  const creds = resolveConnection(NO, env, 'notion')!;
  const [callApi] = connectionTools(connectionState(NO, env), { notion: creds });
  await assert.doesNotReject(async () => {
    try {
      await (callApi.execute as (a: unknown) => Promise<unknown>)({ method: 'POST', path: '/v1/search', body: '{}' });
    } catch (e) {
      if (/Only GET is allowed/.test((e as Error).message)) throw e; // a network/auth error is fine; a method-gate refusal is not
    }
  });
});

test('connectionsBlock shows connected vs not-connected from real state', async () => {
  const connected = connectionsBlock(connectionState(GH, { GITHUB_PAT_DEMO: 'x' }), PROVIDER_CATALOG);
  assert.match(connected, /✅ github \(connected\)/);
  const notConnected = connectionsBlock(connectionState(GH, {}), PROVIDER_CATALOG);
  assert.match(notConnected, /⚪ github \(not connected\)/);
});

test('D1 layer: loadConnectionSpecs merges live rows over the binding seed (D1 wins, disabled removes)', async () => {
  const db = new FakeD1();
  const seeded = binding([
    { provider: 'github', tokenRef: 'GH_SEED', config: { repo: 'seed/repo' } },
    { provider: 'notion', tokenRef: 'NOTION_SEED', config: {} },
  ]);

  // No rows yet → specs == seed (demo keeps working with an empty table).
  let specs = await loadConnectionSpecs(db, seeded);
  assert.deepEqual(specs.map((s) => s.provider).sort(), ['github', 'notion']);
  assert.equal(specs.find((s) => s.provider === 'github')!.tokenRef, 'GH_SEED');

  // Operator overrides github live (new tokenRef + config) and adds linear → no redeploy.
  await upsertConnection(db, { projectId: 'demo', provider: 'github', tokenRef: 'GH_LIVE', config: { repo: 'live/repo', apiMode: 'generic' } });
  await upsertConnection(db, { projectId: 'demo', provider: 'linear', tokenRef: 'LINEAR_LIVE', config: {} });
  specs = await loadConnectionSpecs(db, seeded);
  const gh = specs.find((s) => s.provider === 'github')!;
  assert.equal(gh.tokenRef, 'GH_LIVE', 'live D1 row overrides the seed');
  assert.equal(gh.config!.apiMode, 'generic');
  assert.ok(specs.some((s) => s.provider === 'linear'), 'a live-only provider appears with no redeploy');

  // Disabling removes a seeded provider.
  await upsertConnection(db, { projectId: 'demo', provider: 'notion', status: 'disabled' });
  specs = await loadConnectionSpecs(db, seeded);
  assert.ok(!specs.some((s) => s.provider === 'notion'), 'disabled removes the seeded connection');
});

test('D1 layer: loadConnections returns metadata only and never a secret value', async () => {
  const db = new FakeD1();
  await upsertConnection(db, { projectId: 'p', provider: 'github', tokenRef: 'GITHUB_PAT_X', config: { repo: 'a/b' } });
  const rows = await loadConnections(db, 'p');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tokenRef, 'GITHUB_PAT_X'); // a NAME, not a token value
  assert.equal(rows[0].config.repo, 'a/b');
  assert.equal(rows[0].status, 'active');
  // the record shape carries no secret/value field at all
  assert.ok(!('secret' in rows[0]) && !('value' in rows[0]));
});

test('connectedNotice: a friendly ✅ confirmation naming the provider (the webhook posts this to the channel)', async () => {
  const msg = connectedNotice('notion');
  assert.match(msg, /✅/);
  assert.match(msg, /notion/i);
});

test('resolveConnection: tokenRef path still returns a literal string secret', async () => {
  const resolved = resolveConnection(GH, { GITHUB_PAT_DEMO: 'ghp_realtoken' }, 'github');
  assert.equal(typeof resolved?.secret, 'string');
  assert.equal(resolved?.secret, 'ghp_realtoken');
});

test('resolveConnection: connectionRef path returns a LAZY thunk, memoized to ONE fetch per turn', async () => {
  let fetchCount = 0;
  const fakeFetchToken = async () => { fetchCount++; return 'live_at_777'; };
  const resolved = resolveConnection(NANGO_REF, { NANGO_SECRET_KEY: 'nk' }, 'notion', { fetchToken: fakeFetchToken });
  assert.equal(typeof resolved?.secret, 'function', 'Nango credential is a deferred fetch');
  assert.equal(fetchCount, 0, 'building the credential must NOT fetch (initializer stays network-light)');
  const get = resolved!.secret as () => Promise<string>;
  assert.equal(await get(), 'live_at_777');
  assert.equal(await get(), 'live_at_777');
  assert.equal(fetchCount, 1, 'a multi-call turn pays exactly one Nango round-trip (memoized)');
});

test('resolveConnection: connectionRef but NO platform key → null (no broken tool)', async () => {
  assert.equal(resolveConnection(NANGO_REF, {}, 'notion'), null);
});

test('a Nango-backed notion connection builds notion_call_api whose execute resolves the lazy token', async () => {
  let fetchCount = 0;
  const fakeFetchToken = async () => { fetchCount++; return 'live_notion_at'; };
  const specs: ConnectionSpec[] = [{ provider: 'notion', connectionRef: 'conn_42', config: {} }];
  const env = { NANGO_SECRET_KEY: 'nk' };
  const creds = resolveConnection(specs, env, 'notion', { fetchToken: fakeFetchToken })!;
  const tools = connectionTools(connectionState(specs, env), { notion: creds });
  assert.deepEqual(tools.map((t) => t.name), ['notion_call_api'], 'connected Nango notion exposes the generic call tool');
  assert.equal(fetchCount, 0, 'building the tool must not fetch a token');
  // execute resolves the lazy token (a network error after that is fine; a method-gate refusal is not).
  await assert.doesNotReject(async () => {
    try {
      await (tools[0].execute as (a: unknown) => Promise<unknown>)({ method: 'POST', path: '/v1/search', body: '{}' });
    } catch (e) {
      if (/Only GET is allowed/.test((e as Error).message)) throw e;
    }
  });
  assert.ok(fetchCount >= 1, 'execute resolved the lazy token at least once');
});

test('request_connection: schema has provider but NO secret/token parameter (the structural wall)', async () => {
  const tool = requestConnectionTool({ nangoSecretKey: 'nk', projectId: 'C123' });
  assert.equal(tool.name, 'request_connection');
  const props = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
  const keys = Object.keys(props);
  assert.deepEqual(keys, ['provider'], 'exactly one param: provider — no secret/token field exists');
  for (const k of keys) assert.ok(!/secret|token|key|credential/i.test(k), `no credential-shaped param (${k})`);
});

test('request_connection: starts a session bound to the channel (end_user_id = projectId) and returns the link', async () => {
  const calls: { secretKey: string; endUserId: string; integrationId: string }[] = [];
  const fakeStart = async (a: { secretKey: string; endUserId: string; integrationId: string }) => {
    calls.push(a);
    return { connectLink: 'https://connect.nango.dev/xyz', token: 't', expiresAt: 'e' };
  };
  const tool = requestConnectionTool({ nangoSecretKey: 'nk', projectId: 'C123' }, { startConnectSession: fakeStart });
  const out = (await (tool.execute as (a: unknown) => Promise<string>)({ provider: 'notion' }));
  assert.match(out, /https:\/\/connect\.nango\.dev\/xyz/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { secretKey: 'nk', endUserId: 'C123', integrationId: 'notion' });
});

test('request_connection: refuses a provider not in the catalog (no session started)', async () => {
  let started = 0;
  const fakeStart = async () => { started++; return { connectLink: 'x', token: 't', expiresAt: 'e' }; };
  const tool = requestConnectionTool({ nangoSecretKey: 'nk', projectId: 'C123' }, { startConnectSession: fakeStart });
  const out = await (tool.execute as (a: unknown) => Promise<string>)({ provider: 'salesforce' });
  assert.match(out, /not a supported provider/i);
  assert.equal(started, 0, 'no Nango session for an unsupported provider');
});

test('connectionsBlock: canRequest=true tells the agent to use request_connection; default does not', async () => {
  const withReq = connectionsBlock(connectionState(GH, {}), PROVIDER_CATALOG, true);
  assert.match(withReq, /request_connection/);
  const without = connectionsBlock(connectionState(GH, {}), PROVIDER_CATALOG);
  assert.doesNotMatch(without, /request_connection/);
  assert.match(without, /wired by an operator first/);
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
