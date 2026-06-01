// Nango backend invariants (Hatchery M2) — run: npx tsx src/nango.test.ts
// Fake fetch proves the CODE shape (URL, headers, body, parsing, bounds). The real WIRE shape is
// reconciled live in the integration task (see the plan's live-probe task) — green here != Nango-correct.

import assert from 'node:assert/strict';
import { startConnectSession, fetchToken, deleteConnection, verifyNangoWebhook, parseNangoAuthWebhook, parseNangoDeletionWebhook } from './nango';

// A fake fetch that records the last call and returns a canned Response.
function fakeFetch(responder: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    return responder(String(url), (init ?? {}) as RequestInit);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const tests: [string, () => Promise<void>][] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

test('startConnectSession: POSTs to /connect/sessions with Bearer + allowed_integrations + tags.end_user_id, returns connect_link', async () => {
  const { fn, calls } = fakeFetch(() =>
    new Response(JSON.stringify({ token: 'tok_1', expires_at: '2026-06-01T00:30:00Z', connect_link: 'https://connect.nango.dev/abc' }), { status: 200 }),
  );
  const out = await startConnectSession({ secretKey: 'nk_secret', endUserId: 'C123', integrationId: 'notion' }, { fetchImpl: fn });
  assert.equal(out.connectLink, 'https://connect.nango.dev/abc');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/connect\/sessions$/);
  assert.equal((calls[0].init.method ?? 'GET'), 'POST');
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer nk_secret');
  const body = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(body.allowed_integrations, ['notion']);
  assert.equal(body.tags.end_user_id, 'C123');
});

test('startConnectSession: throws on non-2xx', async () => {
  const { fn } = fakeFetch(() => new Response('nope', { status: 401 }));
  await assert.rejects(() => startConnectSession({ secretKey: 'x', endUserId: 'C1', integrationId: 'notion' }, { fetchImpl: fn }), /401/);
});

test('startConnectSession: unwraps the live { data: {...} } envelope (confirmed via live probe 2026-06-01)', async () => {
  // Nango's real POST /connect/sessions wraps the result under `data`; flat-reading it returned undefined.
  const { fn } = fakeFetch(() =>
    new Response(JSON.stringify({ data: { token: 'tok', expires_at: 'e', connect_link: 'https://connect.nango.dev/wrapped' } }), { status: 201 }),
  );
  const out = await startConnectSession({ secretKey: 'nk', endUserId: 'C1', integrationId: 'notion' }, { fetchImpl: fn });
  assert.equal(out.connectLink, 'https://connect.nango.dev/wrapped');
});

test('fetchToken: GETs /connection/{id}?provider_config_key=… with Bearer, returns credentials.access_token', async () => {
  const { fn, calls } = fakeFetch(() => new Response(JSON.stringify({ credentials: { access_token: 'live_at_999' } }), { status: 200 }));
  const token = await fetchToken({ secretKey: 'nk_secret', connectionId: 'conn_42', providerConfigKey: 'notion' }, { fetchImpl: fn });
  assert.equal(token, 'live_at_999');
  assert.match(calls[0].url, /\/connection\/conn_42\?provider_config_key=notion$/);
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer nk_secret');
});

test('fetchToken: unwraps the { data: {...} } envelope too (Nango wraps inconsistently across endpoints)', async () => {
  const { fn } = fakeFetch(() => new Response(JSON.stringify({ data: { credentials: { access_token: 'live_wrapped' } } }), { status: 200 }));
  const token = await fetchToken({ secretKey: 'nk', connectionId: 'c', providerConfigKey: 'notion' }, { fetchImpl: fn });
  assert.equal(token, 'live_wrapped');
});

test('fetchToken: throws when no access_token present', async () => {
  const { fn } = fakeFetch(() => new Response(JSON.stringify({ credentials: {} }), { status: 200 }));
  await assert.rejects(() => fetchToken({ secretKey: 'x', connectionId: 'c', providerConfigKey: 'notion' }, { fetchImpl: fn }), /access_token/);
});

test('deleteConnection: DELETEs /connection/{id}?provider_config_key=… with Bearer; resolves on 2xx', async () => {
  const { fn, calls } = fakeFetch(() => new Response(JSON.stringify({ success: true }), { status: 200 }));
  await deleteConnection({ secretKey: 'nk_secret', connectionId: 'conn_42', providerConfigKey: 'notion' }, { fetchImpl: fn });
  assert.equal((calls[0].init.method ?? 'GET'), 'DELETE');
  assert.match(calls[0].url, /\/connection\/conn_42\?provider_config_key=notion$/);
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer nk_secret');
});

test('deleteConnection: already-gone is idempotent success — Nango returns 400 {unknown_connection} on DELETE (verified live), 404 {not_found} elsewhere', async () => {
  // The real wire (live-probed 2026-06-01): DELETE of a gone connection → 400 unknown_connection,
  // NOT 404. We must treat "already gone" by the error CODE, not the HTTP status.
  const del400 = fakeFetch(() => new Response(JSON.stringify({ error: { code: 'unknown_connection' } }), { status: 400 }));
  await assert.doesNotReject(() => deleteConnection({ secretKey: 'nk', connectionId: 'gone', providerConfigKey: 'notion' }, { fetchImpl: del400.fn }));

  const del404 = fakeFetch(() => new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 }));
  await assert.doesNotReject(() => deleteConnection({ secretKey: 'nk', connectionId: 'gone', providerConfigKey: 'notion' }, { fetchImpl: del404.fn }));
});

test('deleteConnection: a GENUINE failure (500) still throws — never falsely report teardown success', async () => {
  const { fn } = fakeFetch(() => new Response('boom', { status: 500 }));
  await assert.rejects(() => deleteConnection({ secretKey: 'nk', connectionId: 'c', providerConfigKey: 'notion' }, { fetchImpl: fn }), /500/);
});

test('deleteConnection: a 400 that is NOT unknown_connection still throws (a real bad request, not idempotent)', async () => {
  const { fn } = fakeFetch(() => new Response(JSON.stringify({ error: { code: 'invalid_request' } }), { status: 400 }));
  await assert.rejects(() => deleteConnection({ secretKey: 'nk', connectionId: 'c', providerConfigKey: 'notion' }, { fetchImpl: fn }), /400/);
});

test('verifyNangoWebhook: accepts a correct hex HMAC-SHA256 over the RAW body, rejects a wrong one', async () => {
  const signingKey = 'whsec_test';
  const raw = '{"type":"auth","operation":"creation"}';
  // Compute the expected signature the same way the impl does (Web Crypto), so the test is self-contained.
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(signingKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  assert.equal(await verifyNangoWebhook(signingKey, raw, hex), true);
  assert.equal(await verifyNangoWebhook(signingKey, raw, hex.toUpperCase()), true, 'uppercase/mixed-case hex header still verifies');
  assert.equal(await verifyNangoWebhook(signingKey, raw, 'deadbeef'), false);
  assert.equal(await verifyNangoWebhook(signingKey, raw, undefined), false);
  assert.equal(await verifyNangoWebhook('', raw, hex), false);
});

test('parseNangoAuthWebhook: normalizes an auth/creation/success event; null for everything else', async () => {
  const ok = parseNangoAuthWebhook(JSON.stringify({
    type: 'auth', operation: 'creation', success: true,
    connectionId: 'conn_42', provider: 'notion', providerConfigKey: 'notion', tags: { end_user_id: 'C123' },
  }));
  assert.deepEqual(ok, { projectId: 'C123', provider: 'notion', providerConfigKey: 'notion', connectionId: 'conn_42' });

  assert.equal(parseNangoAuthWebhook(JSON.stringify({ type: 'auth', operation: 'creation', success: false, connectionId: 'c', provider: 'notion', providerConfigKey: 'notion', tags: { end_user_id: 'C1' } })), null, 'success:false → null (failed consent, no row)');
  assert.equal(parseNangoAuthWebhook(JSON.stringify({ type: 'sync', operation: 'creation', success: true })), null, 'non-auth → null');
  assert.equal(parseNangoAuthWebhook(JSON.stringify({ type: 'auth', operation: 'creation', success: true, connectionId: 'c', provider: 'notion', providerConfigKey: 'notion' })), null, 'missing end_user_id → null');
  assert.equal(parseNangoAuthWebhook('not json'), null, 'garbage → null');
  // a deletion event must NOT be mistaken for a creation
  assert.equal(parseNangoAuthWebhook(JSON.stringify({ type: 'auth', operation: 'deletion', success: true, connectionId: 'c', provider: 'notion', providerConfigKey: 'notion', tags: { end_user_id: 'C1' } })), null, 'deletion → null for the creation parser');
});

test('parseNangoDeletionWebhook: extracts connectionId on auth/deletion; null otherwise. Targets by connectionId (the only guaranteed field — tags may be absent on deletion).', async () => {
  // Guaranteed-present fields only: type, operation, connectionId. tags/end_user_id NOT relied on.
  const del = parseNangoDeletionWebhook(JSON.stringify({ type: 'auth', operation: 'deletion', connectionId: 'conn_42', provider: 'notion', providerConfigKey: 'notion' }));
  assert.deepEqual(del, { connectionId: 'conn_42' });

  // still works if tags happen to ride along
  assert.deepEqual(
    parseNangoDeletionWebhook(JSON.stringify({ type: 'auth', operation: 'deletion', connectionId: 'conn_9', tags: { end_user_id: 'C1' } })),
    { connectionId: 'conn_9' },
  );

  assert.equal(parseNangoDeletionWebhook(JSON.stringify({ type: 'auth', operation: 'creation', connectionId: 'c' })), null, 'creation → null for the deletion parser');
  assert.equal(parseNangoDeletionWebhook(JSON.stringify({ type: 'auth', operation: 'deletion' })), null, 'no connectionId → null');
  assert.equal(parseNangoDeletionWebhook(JSON.stringify({ type: 'sync', operation: 'deletion', connectionId: 'c' })), null, 'non-auth → null');
  assert.equal(parseNangoDeletionWebhook('not json'), null, 'garbage → null');
});

const main = async () => {
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); pass++; }
    catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
};
await main();
