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

/** Nango enveloping is inconsistent across endpoints: POST /connect/sessions wraps its result as
 *  `{ data: {...} }` (confirmed live 2026-06-01), while other endpoints return the object flat.
 *  Unwrap defensively — use `.data` when present, else the object itself — so a parse works either
 *  way and a future envelope change on one endpoint can't silently break us. */
function nangoBody<T>(json: unknown): T {
  if (json && typeof json === 'object' && 'data' in (json as Record<string, unknown>)) {
    return (json as { data: T }).data;
  }
  return json as T;
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
  const json = nangoBody<{ token?: string; expires_at?: string; connect_link?: string }>(JSON.parse(text));
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
  const json = nangoBody<{ credentials?: { access_token?: string } }>(JSON.parse(text));
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
  // toHex emits lowercase; lowercase the inbound header so an uppercase/mixed-case hex signature
  // verifies instead of opaquely 401-ing every webhook. (Nango's source uses lowercase digest('hex'),
  // so this is defensive — confirmed harmless either way at live-probe.)
  return constantTimeEqual(toHex(mac), header.toLowerCase());
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

/** Parse an inbound auth/deletion webhook → just the connectionId, or null. We target the stored row
 *  by connection_ref (NOT tags.end_user_id) because `tags`/`endUser` are OPTIONAL on the auth webhook
 *  type and were NOT confirmed present on deletion — connectionId is the one guaranteed field. NOTE:
 *  whether Nango even SENDS a deletion webhook is unconfirmed (docs list only creation/override); this
 *  parser is defensive — harmless if the event never fires, correct if it does. */
export function parseNangoDeletionWebhook(rawBody: string): { connectionId: string } | null {
  let body: { type?: string; operation?: string; connectionId?: string };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (body.type !== 'auth' || body.operation !== 'deletion' || !body.connectionId) return null;
  return { connectionId: String(body.connectionId) };
}
