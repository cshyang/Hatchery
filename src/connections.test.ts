// Connection broker invariants (ADR 0003) — run: npx tsx src/connections.test.ts
// v2a backend = Worker-secret refs (like the Slack token). State + resolution come from the
// binding + env; no D1, no crypto. Gating (tools appear only when connected, never the write)
// and not-leaking-the-secret-name-as-the-value are the load-bearing invariants.

import assert from 'node:assert/strict';
import {
  connectionState,
  resolveConnection,
  connectionTools,
  connectionsBlock,
  PROVIDER_CATALOG,
} from './connections';
import { GITHUB_READ_TOOL_NAMES } from './github';
import type { Binding } from './bindings';

const GITHUB_CALL_API_TOOL_NAME = 'github_call_api';
const NOTION_CALL_API_TOOL_NAME = 'notion_call_api';

// A minimal binding with a GitHub connection declared (secret provided via env, not here).
function binding(connections?: Binding['connections']): Binding {
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

const GH = [{ provider: 'github', tokenRef: 'GITHUB_PAT_DEMO', config: { repo: 'o/r' } }];

const tests: [string, () => Promise<void>][] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

test('not connected: a declared connection with no secret present reads as not_connected', async () => {
  const state = connectionState(binding(GH), {}); // env has no GITHUB_PAT_DEMO
  assert.equal(state.length, 1);
  assert.equal(state[0].status, 'not_connected');
  assert.equal(resolveConnection(binding(GH), {}, 'github'), null);
});

test('connected: state flips when the Worker secret is present; resolve returns the token + config', async () => {
  const env = { GITHUB_PAT_DEMO: 'ghp_realtoken' };
  const state = connectionState(binding(GH), env);
  assert.equal(state[0].status, 'connected');
  const resolved = resolveConnection(binding(GH), env, 'github');
  assert.equal(resolved?.secret, 'ghp_realtoken');
  assert.equal(resolved?.config.repo, 'o/r');
});

test('no declared connection → nothing, even if a stray secret exists in env', async () => {
  const state = connectionState(binding(undefined), { GITHUB_PAT_DEMO: 'ghp_x' });
  assert.equal(state.length, 0);
  assert.equal(resolveConnection(binding(undefined), { GITHUB_PAT_DEMO: 'ghp_x' }, 'github'), null);
});

test('gating: GitHub read tools appear only when connected, and the write is NOT exposed (v2a)', async () => {
  // not connected → no tools
  const offState = connectionState(binding(GH), {});
  assert.equal(connectionTools(offState, {}).length, 0, 'no tools before the secret is set');

  // connected → exactly the read tools, never github_create_issue (deferred to v2b)
  const env = { GITHUB_PAT_DEMO: 'ghp_realtoken' };
  const onState = connectionState(binding(GH), env);
  const creds = resolveConnection(binding(GH), env, 'github')!;
  const tools = connectionTools(onState, { github: creds });
  const names: string[] = tools.map((t) => t.name as string).sort();
  assert.ok(!names.includes('github_create_issue'), 'write tool must NOT be exposed in v2a');
  assert.deepEqual(names, [...GITHUB_READ_TOOL_NAMES].sort(), 'exactly the read tools');
});

test('apiMode "generic" (Test A) exposes ONLY github_call_api, not the typed reads', async () => {
  const GEN = [{ provider: 'github', tokenRef: 'GITHUB_PAT_DEMO', config: { repo: 'o/r', apiMode: 'generic' } }];
  const env = { GITHUB_PAT_DEMO: 'ghp_realtoken' };
  const state = connectionState(binding(GEN), env);
  const creds = resolveConnection(binding(GEN), env, 'github')!;
  const tools = connectionTools(state, { github: creds });
  const names = tools.map((t) => t.name as string);
  assert.deepEqual(names, [GITHUB_CALL_API_TOOL_NAME], 'generic mode = exactly the one call tool');
  // and the typed reads must NOT also be present (else the experiment is muddied)
  for (const typed of GITHUB_READ_TOOL_NAMES) assert.ok(!names.includes(typed), `${typed} must be hidden in generic mode`);
});

test('github_call_api refuses non-GET (writes go through the approval gate, not a blind call)', async () => {
  const GEN = [{ provider: 'github', tokenRef: 'GITHUB_PAT_DEMO', config: { repo: 'o/r', apiMode: 'generic' } }];
  const env = { GITHUB_PAT_DEMO: 'ghp_realtoken' };
  const creds = resolveConnection(binding(GEN), env, 'github')!;
  const [callApi] = connectionTools(connectionState(binding(GEN), env), { github: creds });
  await assert.rejects(
    () => (callApi.execute as (a: unknown) => Promise<unknown>)({ method: 'POST', path: '/repos/o/r/issues' }),
    /Only GET is allowed/,
  );
});

test('notion defaults to the generic call_api tool (no typed tools), gated on its secret', async () => {
  const NO = [{ provider: 'notion', tokenRef: 'NOTION_TOKEN_DEMO', config: {} }];
  // not connected → no tools
  assert.equal(connectionTools(connectionState(binding(NO), {}), {}).length, 0, 'no tool before the secret is set');
  // connected → exactly notion_call_api (no apiMode needed: notion has no typed fallback)
  const env = { NOTION_TOKEN_DEMO: 'secret_ntn' };
  const creds = resolveConnection(binding(NO), env, 'notion')!;
  const names = connectionTools(connectionState(binding(NO), env), { notion: creds }).map((t) => t.name as string);
  assert.deepEqual(names, [NOTION_CALL_API_TOOL_NAME], 'notion = exactly the one generic call tool');
});

test('notion_call_api allows POST (reads use POST; token is read-only at the provider)', async () => {
  // Notion search/query are READS via POST — the GET-only rule would wrongly block them. The
  // profile uses methodPolicy 'all', so POST must NOT be refused on the gate (it will hit the
  // network and fail on the fake token, but it must get PAST the method check).
  const NO = [{ provider: 'notion', tokenRef: 'NOTION_TOKEN_DEMO', config: {} }];
  const env = { NOTION_TOKEN_DEMO: 'secret_ntn' };
  const creds = resolveConnection(binding(NO), env, 'notion')!;
  const [callApi] = connectionTools(connectionState(binding(NO), env), { notion: creds });
  await assert.doesNotReject(async () => {
    try {
      await (callApi.execute as (a: unknown) => Promise<unknown>)({ method: 'POST', path: '/v1/search', body: '{}' });
    } catch (e) {
      // A network/auth error is fine — that means it passed the method gate. A method-gate refusal is NOT.
      if (/Only GET is allowed/.test((e as Error).message)) throw e;
    }
  });
});

test('connectionsBlock shows connected vs not-connected from real state', async () => {
  const connected = connectionsBlock(connectionState(binding(GH), { GITHUB_PAT_DEMO: 'x' }), PROVIDER_CATALOG);
  assert.match(connected, /✅ github \(connected\)/);
  const notConnected = connectionsBlock(connectionState(binding(GH), {}), PROVIDER_CATALOG);
  assert.match(notConnected, /⚪ github \(not connected\)/);
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
