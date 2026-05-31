# M2 — Self-Serve Connect (Component 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a channel agent offer `@bot connect <provider>` → return a Nango magic link → human authorizes off-Slack → an auth webhook stores a `connection_ref` → that provider's tools appear in that channel, with the live token fetched lazily per turn and the agent never touching a credential.

**Architecture:** All Nango wire code lives in a new `src/nango.ts` behind the existing connection broker (`src/connections.ts`). The broker already reserves a `connection_ref` column (migration 0005) and a `ConnectionSpec.connectionRef` field. Component 3 turns that reserved seam on: `connectionState` treats a `connection_ref` + platform key as connected; `resolveConnection` returns a **lazy, per-turn-memoized** token fetch (a thunk) instead of a literal Worker secret; the generic `call_api` tool resolves that thunk at the network boundary. A new `request_connection` tool (no secret parameter — the structural wall) starts a Nango Connect session and returns the magic link; a new `/nango/webhook` route verifies the HMAC and writes the connection row.

**Tech Stack:** TypeScript, `@flue/runtime` (`defineTool`/`Type`), Hono (gateway routes), Cloudflare Workers (Web Crypto for HMAC, `AbortSignal.timeout` for fetch bounds), D1 (`connections` table, no schema change), Nango (hosted Connect + auth webhooks). Tests: hand-rolled `FakeD1` + `node:assert/strict`, run per-file via `tsx` (NO vitest).

---

## Locked decisions (do NOT re-litigate — from `M2-HANDOFF.md` + `memory/nango-integration.md`, confirmed 2026-06-01)

1. **Build the seam fake-first (TDD), live-probe at the end.** Unit tests inject a fake `fetch`/`startConnectSession` — they prove the *code* shape. The operator (Shyang) sets up the Nango account + registers one provider's OAuth app **in parallel**. A dedicated late task probes the *real* wire shape and reconciles `src/nango.ts` constants before the live end-to-end test.
2. **ONE magic-link path for all provider types.** Nango's hosted Connect UI handles OAuth, API-key, and Basic auth through the same `connect_link`. The spec's "two backends, one button" (Nango for OAuth + our own `/connect/:token` secure form for API-key providers) is **CUT** — our own credential-accepting HTML endpoint would re-implement what Nango hosts and add attack surface. There is **no** `/connect/:token` route in this plan.
3. **Route is `/nango/webhook`, not `/nango/callback`.** We learn of a successful connection via Nango's auth webhook (server→server, HMAC-verified), not a browser redirect.
4. **`connect_link` is a plain clickable URL** (no embedded JS SDK). `request_connection` drops the URL into the reply; the human clicks it.
5. **Provider slug == Nango `providerConfigKey` (integration id), by convention.** No mapping table, no `config` override. The operator MUST name each Nango integration exactly the catalog slug (`notion`, `github`, …). The webhook guards on this (Task 9).
6. **No new migration** — `connection_ref` already exists (migration 0005). `connection_ref` is a non-secret Nango id; storing it in D1 is fine.
7. **Lazy token, per-turn-memoized.** The DO initializer must stay network-light (partyserver's `blockConcurrencyWhile(onStart)` resets a DO if a turn drags past ~30s). So gate on "`connection_ref` exists" cheaply in the initializer; fetch the live token only inside the tool's `execute()`, bounded by `AbortSignal.timeout`, and memoize the fetch **per initializer build** so a multi-call turn pays exactly one Nango round-trip.
8. **No `scope` parameter on `request_connection`.** OAuth scopes are configured on the Nango *integration* (operator side), not per Connect session — a `scope` param would be a no-op. Omit it (YAGNI).

---

## Security model (must hold — the hard line)

```
   AGENT   requests a connection (request_connection → a link)     ✅ model can do
   HUMAN   clicks consent / authorizes off-Slack                    ✅ verified human
   AGENT   receives / stores / wires a raw credential               ❌ no tool exists
```

- `request_connection` has **no parameter that accepts a secret** — a prompt-injected agent has no tool to receive or store a token. The credential's only path in is the off-channel Nango consent.
- The token is fetched live per turn and lives only in the tool-call closure for that turn — never in D1, the prompt, the transcript, REM, or the model. Only the non-secret `connection_ref` is stored.
- **OAuth-scope is the write wall (LOAD-BEARING operator step — read this twice).** Today `notion`'s `methodPolicy: 'all'` (in `src/api.ts`) is safe *only* because the manual Notion token is provisioned read-only at Notion. A Nango OAuth token carries whatever scopes the consent granted. We **cannot** force `get-only` for Nango connections — Notion's genuine *reads* use POST (`/v1/search`, `/v1/databases/{id}/query`), so a method gate would break reads. Therefore the read-only guarantee comes from **the operator registering each Nango integration with read-only OAuth scopes** — identical in spirit to the v2a read-only-token model. A write-scoped Nango integration on a `methodPolicy:'all'` provider would expose a silent write path with no approval gate. The proper approval gate is v2b (deferred). **Until v2b: operators register read-only scopes only.** (Task 10 makes this an explicit operator step; this risk is restated in the runbook.)
- Auto-binding and the admin route are unchanged; the webhook is HMAC-verified and inert until `NANGO_WEBHOOK_SECRET` is set.

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src/nango.ts` | **Create** | All Nango wire code: `startConnectSession`, `fetchToken`, `verifyNangoWebhook`, `parseNangoAuthWebhook`. Injectable `fetch` for tests; every call bounded by `AbortSignal.timeout`. Nothing else imports Nango. |
| `src/nango.test.ts` | **Create** | TDD for the four `nango.ts` functions against an injected fake `fetch`. |
| `src/connections.ts` | **Modify** | `connectionState` (connection_ref → connected), `resolveConnection` (lazy memoized Nango branch + `ResolvedConnection` type), `connectionsBlock` (`canRequest` wording), `connectionTools`/`secrets` type widen, new `requestConnectionTool` factory. |
| `src/connections.test.ts` | **Modify** | New tests for each of the above. |
| `src/api.ts` | **Modify** | `genericApiTool` accepts `secret: string \| (() => Promise<string>)` and resolves it inside `execute()`. |
| `.flue/agents/project.ts` | **Modify** | Wire `request_connection` into the tools array (gated on `DB` + `NANGO_SECRET_KEY`); pass `canRequest` to `connectionsBlock`. Lazy-credential path already flows through the existing initializer loop. |
| `.flue/app.ts` | **Modify** | New `/nango/webhook` route (verify → parse → catalog-guard → `upsertConnection`); add `NANGO_SECRET_KEY` + `NANGO_WEBHOOK_SECRET` to the `Env` interface. |
| `.dev.vars` | **Modify** | Replace the typo'd `NONGO_AAPI_KEY` with `NANGO_SECRET_KEY` + `NANGO_WEBHOOK_SECRET`. |
| `package.json` | **Modify** | Add `tsx src/nango.test.ts` to the `test` script. |

**Why `nango.ts` holds the webhook verify/parse (not `app.ts`):** `app.ts` and `project.ts` have no unit tests in this codebase by design — testable logic is extracted into modules (e.g. `src/slack/verify.ts` is tested; `app.ts` just wires it). Putting `verifyNangoWebhook` + `parseNangoAuthWebhook` in `nango.ts` lets `nango.test.ts` cover the security-critical logic; `app.ts` becomes thin wiring verified by `tsc` + the live test.

---

## Task 1: `src/nango.ts` — the Nango backend (fake-first, TDD)

**Files:**
- Create: `src/nango.ts`
- Create: `src/nango.test.ts`
- Modify: `package.json` (test script)

- [ ] **Step 1: Write the failing test**

Create `src/nango.test.ts`:

```typescript
// Nango backend invariants (Hatchery M2) — run: npx tsx src/nango.test.ts
// Fake fetch proves the CODE shape (URL, headers, body, parsing, bounds). The real WIRE shape is
// reconciled live in the integration task (see the plan's live-probe task) — green here != Nango-correct.

import assert from 'node:assert/strict';
import { startConnectSession, fetchToken, verifyNangoWebhook, parseNangoAuthWebhook } from './nango';

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

test('fetchToken: GETs /connection/{id}?provider_config_key=… with Bearer, returns credentials.access_token', async () => {
  const { fn, calls } = fakeFetch(() => new Response(JSON.stringify({ credentials: { access_token: 'live_at_999' } }), { status: 200 }));
  const token = await fetchToken({ secretKey: 'nk_secret', connectionId: 'conn_42', providerConfigKey: 'notion' }, { fetchImpl: fn });
  assert.equal(token, 'live_at_999');
  assert.match(calls[0].url, /\/connection\/conn_42\?provider_config_key=notion$/);
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer nk_secret');
});

test('fetchToken: throws when no access_token present', async () => {
  const { fn } = fakeFetch(() => new Response(JSON.stringify({ credentials: {} }), { status: 200 }));
  await assert.rejects(() => fetchToken({ secretKey: 'x', connectionId: 'c', providerConfigKey: 'notion' }, { fetchImpl: fn }), /access_token/);
});

test('verifyNangoWebhook: accepts a correct hex HMAC-SHA256 over the RAW body, rejects a wrong one', async () => {
  const signingKey = 'whsec_test';
  const raw = '{"type":"auth","operation":"creation"}';
  // Compute the expected signature the same way the impl does (Web Crypto), so the test is self-contained.
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(signingKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  assert.equal(await verifyNangoWebhook(signingKey, raw, hex), true);
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd "/Users/cshyang/Documents/Coding Repositories/Hetchery" && npx tsx src/nango.test.ts`
Expected: FAIL — `Cannot find module './nango'` (the implementation does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `src/nango.ts`:

```typescript
// Nango backend (Hatchery M2). ALL Nango wire code lives here, behind the connection broker
// (src/connections.ts). The agent never imports this; it reaches Nango only via the broker's
// request_connection tool (start a session) and the lazy token fetch inside a connected provider's
// call tool. Verified facts in memory/nango-integration.md (docs 404 a lot; the webhook signature
// truth came from reading NangoHQ/nango/packages/webhooks/lib/utils.ts directly).
//
// Two operator secrets (set with `wrangler secret put`, never in code/D1/prompt/model):
//   NANGO_SECRET_KEY      — Bearer for the API (create session, fetch token)
//   NANGO_WEBHOOK_SECRET  — HMAC signing key to verify inbound auth webhooks
//
// Every external call is bounded by AbortSignal.timeout: a DO turn holds the input gate; an
// uncapped fetch that hangs past ~30s lets a concurrent blockConcurrencyWhile(onStart) time out and
// reset the DO mid-turn (the partyserver lesson). Same 12s ceiling as api.ts / github.ts.

const NANGO_API = 'https://api.nango.dev';
const NANGO_FETCH_TIMEOUT_MS = 12_000;

/** Optional fetch injection — tests pass a fake; production uses the global fetch. */
export interface FetchDeps {
  fetchImpl?: typeof fetch;
}

async function nangoFetch(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(NANGO_FETCH_TIMEOUT_MS) });
  } catch (e) {
    const aborted = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new Error(
      aborted
        ? `Nango request timed out after ${NANGO_FETCH_TIMEOUT_MS}ms (${url}).`
        : `Nango request failed: ${(e as Error).message}`,
    );
  }
}

export interface StartConnectSessionArgs {
  secretKey: string;
  /** Binds the future connection to this Hatchery project (the Slack channel id). Filed under
   *  tags.end_user_id — top-level end_user/organization fields are DEPRECATED. */
  endUserId: string;
  /** Nango integration id to lock the session to. By convention == the catalog provider slug. */
  integrationId: string;
}

/** Create a Connect session; return the magic link (a plain clickable URL — no JS SDK). */
export async function startConnectSession(
  args: StartConnectSessionArgs,
  deps: FetchDeps = {},
): Promise<{ connectLink: string; token: string; expiresAt: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await nangoFetch(
    `${NANGO_API}/connect/sessions`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${args.secretKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ allowed_integrations: [args.integrationId], tags: { end_user_id: args.endUserId } }),
    },
    fetchImpl,
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`Nango connect session failed (${res.status}): ${text.slice(0, 200)}`);
  const json = JSON.parse(text) as { token?: string; expires_at?: string; connect_link?: string };
  if (!json.connect_link) throw new Error('Nango connect session returned no connect_link');
  return { connectLink: json.connect_link, token: json.token ?? '', expiresAt: json.expires_at ?? '' };
}

export interface FetchTokenArgs {
  secretKey: string;
  /** The connectionId Nango assigned (stored as connection_ref). */
  connectionId: string;
  /** Integration id (== provider slug by convention). */
  providerConfigKey: string;
}

/** Fetch a live access token. Nango auto-refreshes server-side, so we never cache at rest — the
 *  caller memoizes per-turn. Returns the OAUTH2 access_token string. */
export async function fetchToken(args: FetchTokenArgs, deps: FetchDeps = {}): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `${NANGO_API}/connection/${encodeURIComponent(args.connectionId)}?provider_config_key=${encodeURIComponent(args.providerConfigKey)}`;
  const res = await nangoFetch(url, { method: 'GET', headers: { authorization: `Bearer ${args.secretKey}` } }, fetchImpl);
  const text = await res.text();
  if (!res.ok) throw new Error(`Nango token fetch failed (${res.status}): ${text.slice(0, 200)}`);
  const json = JSON.parse(text) as { credentials?: { access_token?: string } };
  const token = json.credentials?.access_token;
  if (!token) throw new Error('Nango connection has no access_token in credentials');
  return token;
}

// ── Webhook verify + parse ──────────────────────────────────────────────────────────────────────
// constantTimeEqual + toHex mirror src/slack/verify.ts (kept private there); duplicated here (8 lines)
// rather than refactoring a slack-named module — lower risk than reshaping verify.ts.

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Verify X-Nango-Hmac-Sha256 = hex(HMAC-SHA256(signingKey, rawBody)). MUST use the RAW body string
 *  — re-stringifying parsed JSON breaks it (Nango signs a stable stringification). Web Crypto so it
 *  runs on Workers. The legacy X-Nango-Signature (plain sha256, length-extension-vulnerable) is
 *  intentionally NOT supported. */
export async function verifyNangoWebhook(signingKey: string, rawBody: string, header: string | undefined | null): Promise<boolean> {
  if (!signingKey || !header) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(signingKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  return constantTimeEqual(toHex(mac), header);
}

export interface NangoAuthEvent {
  projectId: string; // tags.end_user_id → the Slack channel id
  provider: string; // Nango provider (== catalog slug by convention)
  providerConfigKey: string;
  connectionId: string; // stored as connection_ref
}

/** Parse an inbound webhook; return a normalized auth-creation-success event, or null for anything
 *  we don't act on (non-auth, non-creation, success:false → failed/abandoned consent, missing
 *  end_user_id, garbage). The route logs + ignores a null and writes no row. */
export function parseNangoAuthWebhook(rawBody: string): NangoAuthEvent | null {
  let body: {
    type?: string;
    operation?: string;
    success?: boolean;
    connectionId?: string;
    provider?: string;
    providerConfigKey?: string;
    tags?: { end_user_id?: string };
  };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (body.type !== 'auth' || body.operation !== 'creation' || body.success !== true) return null;
  const projectId = body.tags?.end_user_id;
  const { connectionId, provider, providerConfigKey } = body;
  if (!projectId || !connectionId || !provider || !providerConfigKey) return null;
  return { projectId: String(projectId), provider: String(provider), providerConfigKey: String(providerConfigKey), connectionId: String(connectionId) };
}
```

- [ ] **Step 4: Add the test to the package.json test script**

In `package.json`, change the `test` script to append `nango.test.ts` (run it alongside the others):

```json
    "test": "tsx src/memory.test.ts && tsx src/reflection.test.ts && tsx src/skills.test.ts && tsx src/conversations.test.ts && tsx src/connections.test.ts && tsx src/bindings.test.ts && tsx src/users.test.ts && tsx src/nango.test.ts"
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd "/Users/cshyang/Documents/Coding Repositories/Hetchery" && npx tsx src/nango.test.ts`
Expected: PASS — `6 passed, 0 failed`.

- [ ] **Step 6: Typecheck and commit**

Run: `cd "/Users/cshyang/Documents/Coding Repositories/Hetchery" && npx tsc --noEmit && npm test`
Expected: tsc clean; all test files pass.

```bash
git add src/nango.ts src/nango.test.ts package.json
git commit -m "feat(nango): connect-session, lazy token fetch, webhook verify/parse (M2 backend)"
```

---

## Task 2: `connectionState` — a `connection_ref` row reads as connected

**Files:**
- Modify: `src/connections.ts:34-43` (`connectionState`)
- Test: `src/connections.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/connections.test.ts`, add these tests (place after the existing "no declared connection" test, ~line 113):

```typescript
const NANGO_REF: ConnectionSpec[] = [{ provider: 'notion', connectionRef: 'conn_42', config: {} }];

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd "/Users/cshyang/Documents/Coding Repositories/Hetchery" && npx tsx src/connections.test.ts`
Expected: FAIL — the connectionRef row reads `not_connected` even with `NANGO_SECRET_KEY` (the Nango branch isn't implemented).

- [ ] **Step 3: Write the minimal implementation**

In `src/connections.ts`, replace `connectionState` (lines 34-43) with:

```typescript
export function connectionState(specs: ConnectionSpec[], env: Record<string, unknown>): ConnectionState[] {
  const nangoKey = env.NANGO_SECRET_KEY;
  const hasNangoPlatform = typeof nangoKey === 'string' && !!nangoKey;
  return specs.map((s) => {
    const token = s.tokenRef ? env[s.tokenRef] : undefined;
    const hasWorkerSecret = typeof token === 'string' && !!token;
    // Managed-OAuth (Nango): a connection_ref means a connection exists; the platform key means we
    // can fetch its token. Both → connected (the token itself is fetched lazily in the tool).
    const hasNango = !!s.connectionRef && hasNangoPlatform;
    return {
      provider: s.provider,
      status: hasWorkerSecret || hasNango ? 'connected' : 'not_connected',
      config: s.config ?? {},
    };
  });
}
```

Also update the docstring on `connectionState` (lines 30-33): replace the last sentence `A connectionRef-only row reads as not_connected until that backend lands.` with `A connectionRef row reads as connected once NANGO_SECRET_KEY is present (the managed-OAuth backend; the token is fetched lazily in the tool).`

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd "/Users/cshyang/Documents/Coding Repositories/Hetchery" && npx tsx src/connections.test.ts`
Expected: PASS — all existing + the two new tests.

- [ ] **Step 5: Commit**

```bash
git add src/connections.ts src/connections.test.ts
git commit -m "feat(connections): connection_ref + platform key reads as connected"
```

---

> **EXECUTION NOTE (2026-06-01):** Tasks 3 and 4 are executed as ONE atomic commit. The credential-type widening (`ResolvedConnection.secret: string | (() => Promise<string>)`) spans `connections.ts` (resolveConnection return + connectionTools param/body) AND `api.ts` (genericApiTool param), and `connectionTools`'s edit (e) passes the widened union straight into `genericApiTool` — so neither file type-checks without the other. Splitting them breaks the per-task `tsc` gate. Treat Task 3 + Task 4 below as a single unit.

## Task 3: `resolveConnection` — lazy, per-turn-memoized Nango token

**Files:**
- Modify: `src/connections.ts` (imports, new `ResolvedConnection` type, `resolveConnection` lines 45-58, `connectionTools` signature line 188-191)
- Test: `src/connections.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/connections.test.ts`, add (after the Task 2 tests):

```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd "/Users/cshyang/Documents/Coding Repositories/Hetchery" && npx tsx src/connections.test.ts`
Expected: FAIL — `resolveConnection` returns `null` for the connectionRef row (current code requires `tokenRef`) and doesn't accept a 4th `deps` arg.

- [ ] **Step 3: Write the minimal implementation**

In `src/connections.ts`:

(a) Add the import for the lazy fetch (top of file, with the other imports near line 22):

```typescript
import { fetchToken } from './nango';
```

(b) Add the `ResolvedConnection` type just above `resolveConnection` (before line 45):

```typescript
/** A resolved credential for one provider. `secret` is EITHER a literal Worker-secret string
 *  (operator/static backend) OR a lazy, per-turn-memoized token fetch (managed-OAuth/Nango). The
 *  generic call tool resolves it at the network boundary, so a Nango token is fetched only when a
 *  tool actually runs — never in the DO initializer. */
export interface ResolvedConnection {
  secret: string | (() => Promise<string>);
  config: Record<string, unknown>;
}
```

(c) Replace `resolveConnection` (lines 45-58) with:

```typescript
/** Resolve a provider's credential from specs, or null if not declared / unusable. The ONE
 *  resolution path (the swappable seam). Worker-secret backend → a literal string; managed-OAuth
 *  (Nango) backend → a lazy thunk that fetches a live token on first call and memoizes it for the
 *  rest of the turn. `deps.fetchToken` is injectable for tests. */
export function resolveConnection(
  specs: ConnectionSpec[],
  env: Record<string, unknown>,
  provider: string,
  deps: { fetchToken?: typeof fetchToken } = {},
): ResolvedConnection | null {
  const spec = specs.find((s) => s.provider === provider);
  if (!spec) return null;

  // Worker-secret backend (operator/static): a literal secret present in env.
  if (spec.tokenRef) {
    const token = env[spec.tokenRef];
    if (typeof token === 'string' && token) return { secret: token, config: spec.config ?? {} };
  }

  // Managed-OAuth backend (Nango): connection_ref + platform key → a lazy, per-turn-memoized token
  // fetch. Memoizing the PROMISE dedupes concurrent tool calls AND caps a multi-call turn at ONE
  // Nango round-trip (keeps us off the ~30s DO-turn wall). The token is never stored at rest.
  const nangoKey = env.NANGO_SECRET_KEY;
  if (spec.connectionRef && typeof nangoKey === 'string' && nangoKey) {
    const fetchTok = deps.fetchToken ?? fetchToken;
    const secretKey = nangoKey;
    const connectionId = spec.connectionRef;
    const providerConfigKey = provider; // convention: Nango integration id == catalog slug
    let cached: Promise<string> | undefined;
    const secret = () => (cached ??= fetchTok({ secretKey, connectionId, providerConfigKey }));
    return { secret, config: spec.config ?? {} };
  }

  return null;
}
```

(d) Widen the `connectionTools` `secrets` parameter type (line 188-191) to use `ResolvedConnection`:

```typescript
export function connectionTools(
  state: ConnectionState[],
  secrets: Record<string, ResolvedConnection>,
): ToolDefinition[] {
```

(e) **CRITICAL — patch the `connectionTools` BODY so a thunk (Nango) secret never reaches the typed path.** `github` is in BOTH `PROVIDER_CATALOG` and `TYPED_TOOL_PROVIDERS`, so a Nango-backed `github` connection falls through to `githubReadTools(creds.secret, repo)` (line ~208-211), which takes a `string` PAT — passing a thunk is a `tsc` error AND a runtime 401 (`Bearer () => …`). `githubReadTools` is the legacy v2a typed path; the generic `github_call_api` path (which Task 4 makes thunk-aware) is the right home for any Nango connection. Route thunk secrets to generic.

Replace the generic-path guard inside the `for` loop (currently `if (useGenericApi(s.provider, creds.config) && profile) {`, line ~202) with:

```typescript
    // A Nango-backed credential is a lazy thunk; the typed tools (githubReadTools) take a string PAT
    // and cannot consume it. Route any thunk secret through the generic call_api path (Task 4 made it
    // thunk-aware). A provider with a thunk secret but NO api profile would be toolless — that can't
    // happen today (PROVIDER_CATALOG ⊆ providers-with-a-profile), but guard so it degrades to "no
    // tool" rather than a crash.
    const isLazy = typeof creds.secret === 'function';
    if ((useGenericApi(s.provider, creds.config) || isLazy) && profile) {
      tools.push(genericApiTool(profile, creds.secret, creds.config));
      continue;
    }
```

The typed-`github` branch below it (line ~208) is now reached ONLY by a string-secret github connection, so `githubReadTools(creds.secret, repo)` still type-checks. **But TS doesn't narrow `creds.secret` to `string` there** — add a defensive cast (the `isLazy` check above guarantees it at runtime):

```typescript
    if (s.provider === 'github') {
      const repo = typeof creds.config.repo === 'string' ? creds.config.repo : undefined;
      tools.push(...githubReadTools(creds.secret as string, repo)); // string-only here: thunks took the generic path above
      // v2b plugs the github_create_issue propose-tool in here.
    }
```

- [ ] **Step 4: Typecheck + run the test to verify it passes**

Run: `cd "/Users/cshyang/Documents/Coding Repositories/Hetchery" && npx tsc --noEmit && npx tsx src/connections.test.ts`
Expected: tsc clean (the body patch in (e) is what keeps `githubReadTools` type-safe — without it, tsc fails on the widened `ResolvedConnection` secret); then PASS. (The existing tests at lines 105-107 / 117-118 still pass — `tokenRef` resolves to a string.)

> **Why tsc here and not just tsx:** `npm test` runs via `tsx`, which STRIPS types — it will not catch the `githubReadTools` mismatch. The `tsc --noEmit` gate in this step is what surfaces blocker (e) inside this task instead of letting it propagate to Task 4. Do not skip it.

- [ ] **Step 5: Commit**

```bash
git add src/connections.ts src/connections.test.ts
git commit -m "feat(connections): lazy per-turn-memoized Nango token in resolveConnection"
```

---

## Task 4: `genericApiTool` — resolve a lazy secret at the network boundary

**Files:**
- Modify: `src/api.ts:80` (signature) and `src/api.ts:106-111` (`execute` header build)
- Test: `src/connections.test.ts` (the generic tool is exercised through `connectionTools`)

- [ ] **Step 1: Write the failing test**

In `src/connections.test.ts`, add (after the Task 3 tests):

```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd "/Users/cshyang/Documents/Coding Repositories/Hetchery" && npx tsx src/connections.test.ts`
Expected: FAIL on the new test's `assert.ok(fetchCount >= 1)` — the current `execute` never calls the thunk (it passes the function straight to `profile.auth`, building a junk `Bearer () => …` header), so `fetchCount` stays 0. (The test swallows the resulting network/auth error because notion is `methodPolicy:'all'`; it only rethrows a method-gate refusal — so the *visible* failure is the `fetchCount` assertion, not the bad header.) Note: `tsx` strips types, so the type mismatch is NOT what fails here — that surfaces at Step 5's `tsc` gate.

- [ ] **Step 3: Write the minimal implementation**

In `src/api.ts`:

(a) Widen the `genericApiTool` signature (line 80):

```typescript
export function genericApiTool(profile: ProviderApiProfile, secret: string | (() => Promise<string>), config: Record<string, unknown>): ToolDefinition {
```

(b) In `execute` (around lines 100-111), resolve the secret before building headers. Replace the header-build block:

```typescript
    async execute({ method, path, body }) {
      const m = String(method).toUpperCase();
      if (getOnly && m !== 'GET') {
        throw new Error(`Only GET is allowed for ${profile.provider} via ${profile.provider}_call_api; "${m}" is a write and needs approval (not wired yet).`);
      }
      // Resolve the credential at the network boundary: a literal Worker secret, or a lazy Nango
      // token fetched (and per-turn-memoized) only now that a call is actually being made.
      const resolvedSecret = typeof secret === 'function' ? await secret() : secret;
      const p = String(path).startsWith('/') ? String(path) : `/${String(path)}`;
      const headers: Record<string, string> = {
        ...profile.auth(resolvedSecret),
        ...(profile.staticHeaders ?? {}),
        'user-agent': UA,
      };
```

(Leave the rest of `execute` — `init`, fetch, error handling, truncation — unchanged.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd "/Users/cshyang/Documents/Coding Repositories/Hetchery" && npx tsx src/connections.test.ts`
Expected: PASS. The existing `github_call_api` / `notion_call_api` tests (string secret) still pass.

- [ ] **Step 5: Typecheck and commit**

Run: `cd "/Users/cshyang/Documents/Coding Repositories/Hetchery" && npx tsc --noEmit`
Expected: clean.

```bash
git add src/api.ts src/connections.test.ts
git commit -m "feat(api): genericApiTool resolves a lazy (Nango) secret at call time"
```

---

## Task 5: `request_connection` tool — the agent's connect request (no secret param)

**Files:**
- Modify: `src/connections.ts` (imports for `defineTool`/`Type` and `startConnectSession`; new `requestConnectionTool` factory)
- Test: `src/connections.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/connections.test.ts`, add the import at the top (extend the existing `./connections` import list to include `requestConnectionTool`):

```typescript
import {
  connectionState,
  resolveConnection,
  connectionTools,
  connectionsBlock,
  loadConnections,
  loadConnectionSpecs,
  upsertConnection,
  requestConnectionTool,
  PROVIDER_CATALOG,
} from './connections';
```

Then add these tests:

```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd "/Users/cshyang/Documents/Coding Repositories/Hetchery" && npx tsx src/connections.test.ts`
Expected: FAIL — `requestConnectionTool` is not exported.

- [ ] **Step 3: Write the minimal implementation**

In `src/connections.ts`:

(a) Change the runtime import (line 18) from a type-only import to also pull `defineTool` + `Type`, and add the nango import. Replace line 18:

```typescript
import { defineTool, Type, type ToolDefinition } from '@flue/runtime';
```

and ensure the nango import covers `startConnectSession`. **Task 3 already added `import { fetchToken } from './nango';` — EXTEND that existing line, do not add a second import:**

```typescript
import { fetchToken, startConnectSession } from './nango';
```

(If you are executing Task 5 in isolation and the `fetchToken` import line is absent, Task 3 wasn't applied — apply Task 3 first; these tasks are ordered.)

(b) Add the factory at the end of `src/connections.ts`:

```typescript
/** The agent's connect request (Component 3). Returns a tool that starts a Nango Connect session for
 *  THIS channel and hands back the magic link for the agent to share. THE STRUCTURAL WALL: there is
 *  no parameter that accepts a secret — a prompt-injected agent has no tool to receive or store a
 *  token. Gated to the provider catalog (the agent can't request an arbitrary provider).
 *  `deps.startConnectSession` is injectable for tests. */
export function requestConnectionTool(
  args: { nangoSecretKey: string; projectId: string; catalog?: { provider: string; summary: string }[] },
  deps: { startConnectSession?: typeof startConnectSession } = {},
): ToolDefinition {
  const catalog = args.catalog ?? PROVIDER_CATALOG;
  const allowed = catalog.map((c) => c.provider);
  const start = deps.startConnectSession ?? startConnectSession;
  return defineTool({
    name: 'request_connection',
    description:
      'Start connecting an external service for THIS channel. Pass the provider name; you get back a ' +
      'secure authorization link to share with the person. They click it and authorize off-Slack — you ' +
      "NEVER receive or handle the credential. Once they finish, that provider's tools appear " +
      `automatically. Connectable providers: ${allowed.join(', ')}.`,
    parameters: Type.Object({
      provider: Type.String({ description: `The provider to connect. One of: ${allowed.join(', ')}.` }),
    }),
    async execute({ provider }) {
      const p = String(provider).toLowerCase();
      if (!allowed.includes(p)) {
        return `Cannot connect "${provider}" — not a supported provider. Supported: ${allowed.join(', ')}.`;
      }
      // integrationId == provider slug, by convention (the operator names the Nango integration to match).
      const { connectLink } = await start({ secretKey: args.nangoSecretKey, endUserId: args.projectId, integrationId: p });
      return (
        `Share this link with the user to connect ${p} (it opens ${p}'s secure authorization page off-Slack — ` +
        `you never see the credential):\n${connectLink}\n` +
        `Once they authorize, ${p} tools will appear automatically and you can use them.`
      );
    },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd "/Users/cshyang/Documents/Coding Repositories/Hetchery" && npx tsx src/connections.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `cd "/Users/cshyang/Documents/Coding Repositories/Hetchery" && npx tsc --noEmit`
Expected: clean.

```bash
git add src/connections.ts src/connections.test.ts
git commit -m "feat(connections): request_connection tool (no-secret-param connect request)"
```

---

## Task 6: `connectionsBlock` — tell the agent it can self-serve connect

**Files:**
- Modify: `src/connections.ts:165-181` (`connectionsBlock`)
- Test: `src/connections.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/connections.test.ts`, add (after the existing `connectionsBlock` test at ~line 172):

```typescript
test('connectionsBlock: canRequest=true tells the agent to use request_connection; default does not', async () => {
  const withReq = connectionsBlock(connectionState(GH, {}), PROVIDER_CATALOG, true);
  assert.match(withReq, /request_connection/);
  const without = connectionsBlock(connectionState(GH, {}), PROVIDER_CATALOG);
  assert.doesNotMatch(without, /request_connection/);
  assert.match(without, /wired by an operator first/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd "/Users/cshyang/Documents/Coding Repositories/Hetchery" && npx tsx src/connections.test.ts`
Expected: FAIL — `connectionsBlock` ignores a third arg and never mentions `request_connection`.

- [ ] **Step 3: Write the minimal implementation**

In `src/connections.ts`, replace `connectionsBlock` (lines 165-181) with:

```typescript
export function connectionsBlock(
  state: ConnectionState[],
  catalog: { provider: string; summary: string }[],
  canRequest = false,
): string {
  const byProvider = new Map(state.map((s) => [s.provider, s]));
  const lines = catalog.map((c) => {
    const s = byProvider.get(c.provider);
    if (s?.status === 'connected') return `  ✅ ${c.provider} (connected) — ${c.summary}`;
    return `  ⚪ ${c.provider} (not connected) — ${c.summary}`;
  });
  const intro = canRequest
    ? 'External services you can reach. Connected ones expose tools you can call now. For one that is NOT ' +
      'connected, call request_connection with the provider name — you get a secure link to share; the ' +
      'person authorizes off-Slack (you never see the credential) and that provider\'s tools appear ' +
      'automatically once they finish.'
    : 'External services you can reach. Connected ones expose tools you can call now; the rest must be ' +
      'wired by an operator first (mention that you need it — you cannot connect it yourself).';
  return (
    'YOUR CONNECTIONS\n' +
    intro +
    '\n' +
    lines.join('\n') +
    '\nKeep API work tight: reach the answer in as few calls as you can (ideally 1–3). Do NOT fan out ' +
    'to read every result of a search/list — fetch the list, then read details only for what the user ' +
    'actually asked about. Long chains of calls can stall the turn.'
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd "/Users/cshyang/Documents/Coding Repositories/Hetchery" && npx tsx src/connections.test.ts`
Expected: PASS (the existing block test at ~line 167 still matches `✅ github (connected)` / `⚪ github (not connected)`).

- [ ] **Step 5: Commit**

```bash
git add src/connections.ts src/connections.test.ts
git commit -m "feat(connections): connectionsBlock advertises request_connection when available"
```

---

## Task 7: Wire `request_connection` + lazy credentials into the project agent

**Files:**
- Modify: `.flue/agents/project.ts` (import, gate, tools array, `connectionsBlock` call)

No new test file — `project.ts` is the initializer wiring (no unit test in this codebase; verified by `tsc` + the live test in Task 11). The lazy-credential path already flows through the existing loop at lines 79-83 (now that Tasks 2-4 make `connectionState`/`resolveConnection` return a connected Nango credential).

- [ ] **Step 1: Add the imports (incl. the widened credential type)**

In `.flue/agents/project.ts`, extend the `connections` import (lines 11-19) to include `requestConnectionTool` AND `type ResolvedConnection`. The latter is REQUIRED: Task 3 widened `resolveConnection`'s return to `ResolvedConnection`, so the `connSecrets` annotation at line 78 (`Record<string, { secret: string; … }>`) no longer matches what `resolveConnection` returns — without this import + the Step 2 annotation fix, `tsc` fails with TS2322 at line 82.

```typescript
import {
  connectionState,
  resolveConnection,
  connectionTools,
  connectionsBlock,
  loadConnectionSpecs,
  requestConnectionTool,
  PROVIDER_CATALOG,
  type ConnectionState,
  type ResolvedConnection,
} from '../../src/connections';
```

- [ ] **Step 2: Fix the `connSecrets` annotation to the widened type**

In `.flue/agents/project.ts`, change the `connSecrets` declaration (line 78) from the inline `{ secret: string; config }` shape to `ResolvedConnection` (whose `secret` is `string | (() => Promise<string>)`). The existing loop at lines 79-83 assigns `resolveConnection(...)`'s result into it, so the annotation must match.

Replace line 78:

```typescript
  const connSecrets: Record<string, ResolvedConnection> = {};
```

(The loop body at lines 79-83 is unchanged — it already does `connSecrets[s.provider] = resolved;`.)

- [ ] **Step 3: Compute the gate + the request tool, then wire the tools array + block**

These three edits must land together and in this ORDER inside the initializer, because the `connBlock` rewrite consumes `canRequestConnect`. Final layout: `connState` + `connSecrets` (existing, lines 77-83) → gate block (new) → `connBlock` assignment (rewritten).

(a) **Replace** the existing `connBlock` line (line 84) and insert the gate block IMMEDIATELY BEFORE it, so the two together become:

```typescript
  // request_connection is a REQUEST (not a connected-provider tool), so it's always available when we
  // can actually start a session: DB present (to eventually store the row via the webhook) AND the
  // platform key present (no broken tool when Nango isn't configured). Mirrors how skill tools are
  // always-on when a DB exists.
  const nangoSecretKey = typeof env.NANGO_SECRET_KEY === 'string' ? env.NANGO_SECRET_KEY : '';
  const canRequestConnect = !!db && !!nangoSecretKey;
  const requestConnect = canRequestConnect ? [requestConnectionTool({ nangoSecretKey, projectId })] : [];

  const connBlock = connState.length || canRequestConnect ? connectionsBlock(connState, PROVIDER_CATALOG, canRequestConnect) : null;
```

(b) Update the `tools` array (lines 144-152) to include `requestConnect` (before `connectionTools`):

```typescript
  const tools: ToolDefinition[] = [
    replyToConversation,
    updateStatus,
    ...(db ? skillTools(db, projectId) : []),
    ...reminderTools(ticker, heartbeatToken, projectId),
    ...(db ? memoryTools(db, projectId) : []),
    ...userTools(db, botToken),
    ...requestConnect,
    ...connectionTools(connState, connSecrets),
  ];
```

- [ ] **Step 4: Typecheck**

Run: `cd "/Users/cshyang/Documents/Coding Repositories/Hetchery" && npx tsc --noEmit && npm test`
Expected: tsc clean; all tests pass (no behavior change to tested modules).

- [ ] **Step 5: Commit**

```bash
git add .flue/agents/project.ts
git commit -m "feat(agent): wire request_connection + lazy Nango credentials into the project agent"
```

---

## Task 8: `/nango/webhook` route — verify, parse, guard, store

**Files:**
- Modify: `.flue/app.ts` (`Env` interface; new route before the `flue()` mount; imports)

The verify/parse logic is already unit-tested in `nango.test.ts` (Task 1). This task is the wiring, verified by `tsc` + the live test.

- [ ] **Step 1: Add Nango secrets to the `Env` interface**

In `.flue/app.ts`, add to the `Env` interface (after line 24, the `ADMIN_CONNECTIONS_TOKEN` line):

```typescript
  NANGO_SECRET_KEY?: string; // platform Bearer for the Nango API (create session / fetch token)
  NANGO_WEBHOOK_SECRET?: string; // HMAC signing key to verify inbound Nango auth webhooks
```

- [ ] **Step 2: Add the imports**

In `.flue/app.ts`, extend the connections import (line 13) and add the nango import:

```typescript
import { upsertConnection, loadConnections, PROVIDER_CATALOG } from '../src/connections';
import { verifyNangoWebhook, parseNangoAuthWebhook } from '../src/nango';
```

- [ ] **Step 3: Add the route**

In `.flue/app.ts`, add this route **before** `app.route('/', flue());` (currently line 349) — place it after the `/__admin/connections` GET route (line 213):

```typescript
// Nango auth webhook (Component 3). Nango POSTs here when a Connect flow completes. HMAC-verified
// against the RAW body with NANGO_WEBHOOK_SECRET (a DEDICATED webhook secret, NOT the API key).
// Inert (404) until that secret is set. On a verified auth/creation/success event we store the
// connection_ref under the channel project (tags.end_user_id) — the row makes that provider's tools
// appear next turn. HARD LINE: this writes only a non-secret connection_ref; no token touches D1.
app.post('/nango/webhook', async (c) => {
  const signingKey = c.env.NANGO_WEBHOOK_SECRET;
  if (!signingKey) return c.body(null, 404); // inert/invisible until configured

  const raw = await c.req.text();
  const ok = await verifyNangoWebhook(signingKey, raw, c.req.header('x-nango-hmac-sha256'));
  if (!ok) return c.text('unauthorized', 401);

  const event = parseNangoAuthWebhook(raw);
  if (!event) {
    // non-auth, non-creation, or success:false (failed/abandoned consent) — acknowledge, write nothing.
    console.log('[nango] webhook ignored (not an auth-creation-success event)');
    return c.json({ ignored: true });
  }

  const db = c.env.DB;
  if (!db) return c.json({ error: 'no DB binding' }, 500);

  // Convention guard: the Nango integration id MUST equal a catalog provider slug, else the row would
  // be connected-but-toolless (no API profile / typed tools). Log loudly and skip rather than store a
  // dead row. (See the runbook: operators name the Nango integration exactly the catalog slug.)
  if (!PROVIDER_CATALOG.some((p) => p.provider === event.provider)) {
    console.log(`[nango] webhook for unknown provider "${event.provider}" (cfg "${event.providerConfigKey}") — skipping upsert; name the Nango integration to match a catalog slug`);
    return c.json({ ignored: 'unknown provider' });
  }

  await upsertConnection(db, {
    projectId: event.projectId,
    provider: event.provider,
    connectionRef: event.connectionId,
    createdBy: 'nango-webhook',
  });
  console.log(`[nango] connected provider "${event.provider}" for project ${event.projectId} (connection ${event.connectionId})`);
  return c.json({ ok: true, projectId: event.projectId, provider: event.provider });
});
```

- [ ] **Step 4: Typecheck**

Run: `cd "/Users/cshyang/Documents/Coding Repositories/Hetchery" && npx tsc --noEmit && npm test`
Expected: tsc clean; all tests pass.

- [ ] **Step 5: Commit**

```bash
git add .flue/app.ts
git commit -m "feat(gateway): /nango/webhook — HMAC-verified connection_ref upsert"
```

---

## Task 9: Local config — rename the typo'd Nango var, add the two secrets

**Files:**
- Modify: `.dev.vars`

- [ ] **Step 1: Confirm the typo isn't referenced anywhere**

Run: `cd "/Users/cshyang/Documents/Coding Repositories/Hetchery" && grep -rn "NONGO" . --include="*.ts" --include="*.jsonc" --include="*.json" --include="*.vars" 2>/dev/null | grep -v node_modules`
Expected: only the `.dev.vars` line (the var is unused in code — safe to rename).

- [ ] **Step 2: Edit `.dev.vars`**

In `.dev.vars`, remove the line `NONGO_AAPI_KEY="83f590e9-21e4-4e65-b76d-dd59d060d965"` and add (use the operator's real Nango DEV API key for `NANGO_SECRET_KEY`, and the Nango webhook signing key once registered — placeholder until then):

```
NANGO_SECRET_KEY="<operator's Nango DEV secret key — Connect, scope connect_sessions:write>"
NANGO_WEBHOOK_SECRET="<Nango UI → Environment Settings → Webhooks → Signing key>"
```

> The value `83f590e9-…` was the half-set Nango key under a typo'd name; carry it over to `NANGO_SECRET_KEY` only if it is in fact the DEV secret key (confirm in the Nango UI — Nango distinguishes a public key from a secret key).

- [ ] **Step 3: Verify local boot doesn't error on the rename**

Run: `cd "/Users/cshyang/Documents/Coding Repositories/Hetchery" && npx tsc --noEmit`
Expected: clean (no code references the old name).

- [ ] **Step 4: Commit**

```bash
git add .dev.vars
git commit -m "chore(config): rename NONGO_AAPI_KEY → NANGO_SECRET_KEY + NANGO_WEBHOOK_SECRET"
```

> `.dev.vars` is git-ignored in most setups — if `git add` reports it's ignored, skip the commit; the rename still applies locally. Confirm with `git check-ignore .dev.vars`.

---

## Task 10: Operator setup (Nango account) + deploy

This task is **operator actions + deploy**, not code. It can run in parallel with Tasks 1-9 (the account setup) but the webhook registration needs the deployed URL.

- [ ] **Step 1: Register the provider integration in Nango (read-only scopes)**

In the Nango dashboard: create an integration whose **integration id EQUALS the catalog slug** (`notion`, then `github` later). Register its OAuth app. **CRITICAL (the write wall): grant read-only OAuth scopes only.** A write-scoped integration on a `methodPolicy:'all'` provider (e.g. notion) is a silent write path with no approval gate until v2b ships. (See the Security model section.)

- [ ] **Step 2: Set the two Worker secrets**

Run:
```bash
cd "/Users/cshyang/Documents/Coding Repositories/Hetchery"
npx wrangler secret put NANGO_SECRET_KEY --name hatchery
npx wrangler secret put NANGO_WEBHOOK_SECRET --name hatchery
```
Expected: each prompts for the value and confirms it's stored. (No migration — `connection_ref` already exists from 0005.)

- [ ] **Step 3: Build + deploy**

Run:
```bash
cd "/Users/cshyang/Documents/Coding Repositories/Hetchery"
npx flue build --target cloudflare && npx wrangler deploy --name hatchery
```
Expected: a new version deployed. (Secret set ≠ deploy — the new routes/tools ship only on deploy.)

- [ ] **Step 4: Register the webhook URL in Nango**

In Nango UI → Environment Settings → Webhooks: set the callback URL to `https://hatchery.<your-subdomain>.workers.dev/nango/webhook` and copy the **Signing key** into `NANGO_WEBHOOK_SECRET` (re-run Step 2 if it changed). Confirm the URL with `npx wrangler deployments list --name hatchery` or the dashboard.

---

## Task 11: Live wire-format probe + reconcile (the fake→real gate)

**Why (advisor):** the unit tests prove the *code* shape against a fake `fetch` you wrote — green tests say nothing about Nango's *actual* contract, and the docs 404 constantly. Reconcile the assumptions in `src/nango.ts` against real responses **before** trusting the end-to-end flow. Do this once Task 10 has a live Nango account.

- [ ] **Step 1: Probe a real Connect session**

Run (substitute the real DEV secret key):
```bash
curl -sS -X POST https://api.nango.dev/connect/sessions \
  -H "authorization: Bearer $NANGO_SECRET_KEY" \
  -H "content-type: application/json" \
  -d '{"allowed_integrations":["notion"],"tags":{"end_user_id":"PROBE_TEST"}}' | tee /tmp/nango_session.json
```
Verify the response has `connect_link` (and note `token` / `expires_at`). If the field names differ, update `startConnectSession`'s parse in `src/nango.ts` and its test.

- [ ] **Step 2: Reconcile the token-fetch endpoint**

> **Depends on Step 3:** you need a real `connectionId`, which only exists after a completed consent + webhook. Do Step 3 (open the Step 1 link → authorize → capture the webhook payload) FIRST, then return here with the `connectionId` in hand. (Kept in this order because it groups with the other `nango.ts` reconciliations.)

Probe both endpoint spellings (the memo flags `/connection/{id}` as deprecated in favor of `/connections/{id}`):
```bash
curl -sS "https://api.nango.dev/connection/<CONN_ID>?provider_config_key=notion" -H "authorization: Bearer $NANGO_SECRET_KEY" | head -c 400
curl -sS "https://api.nango.dev/connections/<CONN_ID>?provider_config_key=notion" -H "authorization: Bearer $NANGO_SECRET_KEY" | head -c 400
```
Confirm which path your account serves and that `credentials.access_token` exists. If it's `/connections/{id}`, update the URL in `fetchToken` (and its test) accordingly.

- [ ] **Step 3: Capture a real webhook payload + signature**

Watch the deployed logs while completing a consent:
```bash
npx wrangler tail --name hatchery --format json
```
Confirm the inbound `/nango/webhook` body field names (`type`, `operation`, `connectionId`, `provider`, `providerConfigKey`, `tags.end_user_id`, `success`) and that the `x-nango-hmac-sha256` header verifies. If any field name differs, update `parseNangoAuthWebhook` (and its test). If verification fails, double-check you're verifying the **raw** body and using the **webhook signing key** (not the API key).

- [ ] **Step 4: Re-run the unit suite after any reconciliation**

Run: `cd "/Users/cshyang/Documents/Coding Repositories/Hetchery" && npm test && npx tsc --noEmit`
Expected: green. Commit any wire-format corrections:
```bash
git add src/nango.ts src/nango.test.ts
git commit -m "fix(nango): reconcile wire format against live Nango account"
```

---

## Task 12: Live end-to-end test (the real proof)

- [ ] **Step 1: Drive the flow in a real channel**

In a test channel of the known team (or auto-create one with a fresh `@mention`):
1. `@bot connect notion` → the bot should reply with a `connect.nango.dev/...` link.
2. Click the link → authorize in Nango's hosted consent → see Nango's success page.
3. Watch `npx wrangler tail --name hatchery --format json` for `[nango] connected provider "notion" for project <channel>`.

- [ ] **Step 2: Confirm the row + the tool appearance**

Verify the connection row was written (operator route, metadata only):
```bash
curl -sS "https://hatchery.<subdomain>.workers.dev/__admin/connections?projectId=<channelId>" -H "x-hatchery-admin-token: $ADMIN_CONNECTIONS_TOKEN"
```
Expected: a `notion` row with a `connection_ref` (no secret). Then in the channel: `@bot what notion pages can you see?` → the agent should call `notion_call_api` (lazy token fetched once) and answer from real Notion data.

- [ ] **Step 3: Confirm isolation + the wall**

- A *different* channel must NOT see this Notion connection (per-channel `project_id` isolation).
- Confirm no secret leaked: the transcript / `__admin/connections` output / logs show only `connection_ref`, never an access token.

- [ ] **Step 4: Final verification**

Run: `cd "/Users/cshyang/Documents/Coding Repositories/Hetchery" && npm test && npx tsc --noEmit`
Expected: all green. M2 Component 3 complete.

---

## Self-review (run against the spec + handoff)

**Spec Component 3 coverage:**
- `request_connection` returning a link, no secret param → Task 5 ✅
- `resolveConnection` gains the `connection_ref` → Nango-fetch branch → Task 3 ✅
- `src/nango.ts` (`startConnectSession`, `fetchToken`, ALL Nango code) → Task 1 ✅
- Webhook path to store the connection row → Task 8 ✅ (spec said `/nango/callback`; locked decision #3 → `/nango/webhook`)
- `connect_link` magic link, single path for all auth modes → Tasks 1/5, decision #2 (secure form CUT) ✅
- Per-channel isolation via `end_user_id` = channel id → Tasks 1/5 (`endUserId: projectId`) + Task 12 ✅
- `connectionState` connectionRef → connected → Task 2 ✅

**Handoff "what the plan must cover":** `src/nango.ts` ✅, `request_connection` ✅, `resolveConnection` branch ✅, `connectionState` ✅, `/nango/webhook` route ✅, provider→integrationId mapping (convention, decision #5; webhook guard Task 8) ✅, `request_connection` wiring into `project.ts` ✅, prompt/`connectionsBlock` update ✅.

**Handoff open items:** (1) provider/integration mapping → convention, guarded ✅; (2) webhook URL registration → Task 10 Step 4 ✅; (3) `request_connection` return text → Task 5 (locked text) ✅; (4) `success:false` → `parseNangoAuthWebhook` returns null, route logs + ignores ✅.

**Advisor items:** (1) per-turn memoized token → Task 3 (memoized promise) ✅; (2) live wire-format probe before trusting integration → Task 11 ✅; (3) OAuth-scope write path → can't force `get-only` (breaks Notion POST-reads), so read-only scopes are an operator step + restated risk (Security model + Task 10 Step 1) ✅; (4) webhook catalog guard → Task 8 ✅; (5) `.dev.vars` rename → Task 9 ✅.

**Constraints:** TDD + `tsx` per-file + `FakeD1` + `node:assert` ✅; secrets only as Worker secrets / `.dev.vars` ✅; no new migration ✅; every external fetch bounded by `AbortSignal.timeout` ✅; tsc clean + `npm test` as separate gates ✅.

**Type consistency:** `ResolvedConnection` (Task 3) is used by `connectionTools` (Task 3d), `genericApiTool` (Task 4), and `project.ts` (Task 7). `StartConnectSessionArgs`/`FetchTokenArgs`/`NangoAuthEvent` (Task 1) are consumed by `resolveConnection` (Task 3), `requestConnectionTool` (Task 5), and the webhook route (Task 8). `requestConnectionTool({ nangoSecretKey, projectId })` signature matches its call site in Task 7.

**Review fixes folded in (subagent code-review, 2026-06-01) — the two tsc blockers the union-widening introduced:**
- **`githubReadTools` takes a `string` PAT, but `github` is in both `PROVIDER_CATALOG` and `TYPED_TOOL_PROVIDERS`** → a Nango-backed github connection would pass a thunk to the typed path (tsc error + runtime 401). FIXED in Task 3 step (e): route any thunk secret through the generic `call_api` path; the typed branch is now string-only (`creds.secret as string`). Task 3 Step 4 gains a `tsc --noEmit` gate so this surfaces in-task, not downstream.
- **`connSecrets` annotation in `project.ts:78` was `Record<string, { secret: string; … }>`** → no longer matches `resolveConnection`'s widened return. FIXED in Task 7 Steps 1-2: import `type ResolvedConnection` and re-annotate. Task 7 Step 3 reorders the gate/`connBlock` edits so `canRequestConnect` is declared before use.

---

## Known residual risks / follow-ups (NOT in scope — log, don't build)

- **Write-scoped Nango token + `methodPolicy:'all'` = silent write path.** Mitigated by the operator registering read-only scopes; the durable fix is the v2b approval gate (deferred). If a write-capable provider must connect before v2b, do NOT add it to the catalog yet.
- **A catalog provider with no API profile and no typed tools** connects-but-is-toolless. Keep `PROVIDER_CATALOG ⊆ (PROVIDER_API_PROFILES ∪ typed-tool providers)`. Today both catalog entries (github, notion) have profiles.
- **`fetchHeartbeat` still fans out over code-seed bindings only** (M1 deferred item) — unrelated to M2 but worth remembering when an auto-channel needs autonomous connect prompts.
- **`/connection/{id}` vs `/connections/{id}`** — resolved empirically in Task 11; if Nango migrates the account mid-flight, re-probe.
