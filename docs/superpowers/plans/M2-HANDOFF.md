# M2 Handoff — Nango self-serve connect (resume here)

**Date:** 2026-06-01 · **Status:** **CODE COMPLETE (Tasks 1–9) on branch `m2-self-serve-connect`.** tsc clean, 74 tests green (8 files), whole-branch review APPROVED. Remaining = Tasks 10–12 (live Nango account + deploy + live-probe + end-to-end), which need the operator (Nango account + one read-only provider integration). Plan: `docs/superpowers/plans/2026-06-01-m2-self-serve-connect.md`.

## Resume point (what's left — Tasks 10–12, all need the live Nango account)

1. **Operator setup (Task 10):** in Nango, register ONE integration whose **id == catalog slug** (`notion`), with **READ-ONLY OAuth scopes** (the write wall — notion is `methodPolicy:'all'`, so a write scope would be a silent write path until v2b). Then `wrangler secret put NANGO_SECRET_KEY` + `NANGO_WEBHOOK_SECRET` (both `--name hatchery`), `npx flue build --target cloudflare && npx wrangler deploy --name hatchery`, and register the webhook URL `https://hatchery.<sub>.workers.dev/nango/webhook` in Nango (copy its Signing key into `NANGO_WEBHOOK_SECRET`).
2. **Live-probe + reconcile (Task 11):** docs 404 a lot — probe the real wire format (`/connect/sessions` response fields; `/connection/{id}` vs `/connections/{id}`; the webhook payload field names + `x-nango-hmac-sha256`) and fix `src/nango.ts` constants if reality differs, re-run `npm test`.
3. **End-to-end (Task 12):** `@bot connect notion` → click link → authorize → watch `wrangler tail` for `[nango] connected provider "notion"` → confirm the row via `/__admin/connections` → `@bot what notion pages can you see?` → confirm a DIFFERENT channel does NOT see it (isolation) and no token leaked (only `connection_ref`).

**Local config done:** `.dev.vars` renamed `NONGO_AAPI_KEY` → `NANGO_SECRET_KEY` (carried the old value — CONFIRM in Nango UI it's actually the DEV *secret* key, not a public key) + added empty `NANGO_WEBHOOK_SECRET`. `.dev.vars` is gitignored (local-only, no commit).

## Known gaps / decisions logged during build

- **No proactive "✅ connected" Slack message** after the webhook lands — the user discovers tools on the next turn (connectionsBlock reflects the new connection). The webhook has no conversation target without extra plumbing. Reviewer flagged as a UX gap, NOT a defect. Follow-up if the silent confirm bites in the live test.
- **Plan Tasks 3+4 were MERGED into one commit** — the credential-type widening (`ResolvedConnection.secret: string | thunk`) spans connections.ts + api.ts + project.ts and can't be tsc-green if split. Recorded in the plan doc.
- **Branch history has a couple of cosmetic warts** (a duplicate-message commit + the project.ts annotation fix bundled into a docs commit) from an amend dance after a subagent crash. Functionally clean; squash at PR time.
- **Memoized-rejection in the lazy token thunk is intentional** (no in-turn retry; next turn rebuilds) — documented in `resolveConnection`.

**Repo state:** clean, on `main`, M1 merged (`c53c51e`), 57 tests green.

## One-line resume

> "Continue Hatchery Milestone 2. Read `docs/superpowers/plans/M2-HANDOFF.md` and `memory/nango-integration.md`, then write the implementation plan (writing-plans skill) for Component 3 of `docs/superpowers/specs/2026-05-31-multi-channel-self-serve-connect-design.md`. Decisions are already locked — don't re-ask."

## What M2 is

Component 3 of the multi-channel spec: the `@bot connect <provider>` → off-channel consent → `✅ connected` flow, scoped per channel. The `connection_ref` seam was reserved for exactly this in M1 (migration 0005 `connection_ref` column + `ConnectionSpec.connectionRef` in `src/bindings.ts`).

## Decisions LOCKED (do NOT re-ask)

1. **Build the seam now with a FAKE Nango** (TDD, no live dep). User sets up the Nango account + registers one provider's OAuth app in parallel. Wire `NANGO_SECRET_KEY` + live-test at the end.
2. **SINGLE magic-link path for ALL provider types.** The spec's "two backends" (Nango for OAuth + our own secure web form for API-key providers) is CUT. Research proved Nango's hosted Connect UI handles OAuth, API-key, AND Basic auth through the same `connect_link`. Our own `/connect/:token` form is NOT built — it would re-implement what Nango hosts and add attack surface. (User confirmed the cut.)

## Verified Nango facts (full detail in `memory/nango-integration.md`)

Docs 404 a lot — facts came from Nango source (`NangoHQ/nango/packages/webhooks/lib/utils.ts`). Key points:
- **Create session:** `POST https://api.nango.dev/connect/sessions`, `Authorization: Bearer <NANGO_SECRET_KEY>`, body `{ allowed_integrations:['<provider>'], tags:{ end_user_id:'<channelId>' } }`. Returns `{ token, expires_at, connect_link }`. `connect_link` = **plain clickable magic link** (no JS SDK). `end_user`/`organization` top-level fields are DEPRECATED — use `tags`.
- **Fetch token (lazy, per-use):** `GET https://api.nango.dev/connection/{connectionId}?provider_config_key=<integrationId>`, Bearer `<NANGO_SECRET_KEY>`. Nango **auto-refreshes server-side** → don't cache; gate tools on "connectionRef exists" (cheap, in DO initializer), fetch live token only inside `execute()` bounded by `AbortSignal.timeout` (partyserver 30s lesson). Response `.credentials.access_token`. (`/connection/{id}` deprecated → `/connections/{id}`; verify at wire-up.)
- **Auth webhook (learn of success):** Nango POSTs `{ type:'auth', operation:'creation', connectionId, authMode, providerConfigKey, provider, environment, success:true, tags:{ end_user_id } }`. Read `tags.end_user_id`→projectId, `connectionId`→connection_ref, then `upsertConnection`.
- **Webhook verify (from source):** header `X-Nango-Hmac-Sha256` = `crypto.createHmac('sha256', signingKey).update(rawBody).digest('hex')`. MUST use RAW body string. Signing key is a **SEPARATE secret** (Nango UI → Environment Settings → Webhooks → Signing key). Ignore legacy `X-Nango-Signature`.
- **TWO operator secrets:** `NANGO_SECRET_KEY` (API) + `NANGO_WEBHOOK_SECRET` (verify inbound).

## What the plan must cover (the build)

- **`src/nango.ts`** (new — ALL Nango code behind the broker): `startConnectSession(secretKey, projectId, provider)` → `connect_link`; `fetchToken(secretKey, connectionRef, providerConfigKey)` → live token. Bound fetches with `AbortSignal.timeout`.
- **`request_connection` tool** (in `src/connections.ts`): takes provider name (+ optional scope), returns the connect URL. **NO secret parameter** — that's the structural wall. Gated to providers in `PROVIDER_CATALOG`.
- **`resolveConnection`** (`src/connections.ts`): add the `connectionRef` → Nango-fetch branch (currently it returns null when no `tokenRef`). Lazy — called inside the tool's `execute()`, not the initializer.
- **`connectionState`**: a `connectionRef`-only row must read as `connected` (today it only checks `tokenRef` + env secret). This is what makes the connected tools appear after a webhook lands.
- **`/nango/webhook` route** (`.flue/app.ts`): verify `X-Nango-Hmac-Sha256` against raw body, parse, `upsertConnection({ projectId: tags.end_user_id, provider, connectionRef: connectionId })`. Mirror the existing `/__admin/connections` guarded-route pattern.
- **Provider→integrationId mapping:** Nango `providerConfigKey` (integration id) may differ from our `provider` slug. Decide: store it in `config_json`, or keep them equal by convention. (Resolve in plan.)
- **`request_connection` wiring** into `.flue/agents/project.ts` tools array (always available when DB present, like skill tools — it's a request, not a connected-provider tool).
- **Prompt:** `connectionsBlock` / instructions should tell the agent it CAN now offer to connect a not-connected provider via `request_connection`.

## Constraints (must hold — from CLAUDE.md + this project)

- **TDD**, hand-rolled `FakeD1` + `node:assert`, run per-file via `tsx` (NO vitest). Add `tsx src/nango.test.ts` (+ any new) to `package.json` test script. tsc clean + npm test green are SEPARATE gates.
- **Secrets** only as Worker secrets / `.dev.vars`, NEVER in chat/commit/prompt/model/D1. `connection_ref` is non-secret (a Nango id), fine in D1.
- **Hard line:** agent REQUESTS (tool returns a link); human consents off-channel; agent NEVER receives/stores a raw credential (no tool has a secret param).
- **Deploy reality:** secret set ≠ deploy. `npx flue build --target cloudflare && npx wrangler deploy --name hatchery`. Migrations: `npx wrangler d1 execute hatchery-skills --remote --file=...`. (No new migration needed — `connection_ref` column already exists from 0005.)
- **partyserver 30s** `blockConcurrencyWhile(onStart)` reset → bound every external fetch with `AbortSignal.timeout`; keep DO initializer network-light (lazy token fetch).
- **Slack scope changes need a REINSTALL** (M1 lesson — only relevant if scopes change; likely not for M2).

## Execution choice (after plan written)

User has been using **subagent-driven-development** (fresh subagent per task + 2-stage review). Offer that as option 1 again. Deploy/live-test needs Nango account ready first (decision #1 — fake until then).

## Open items to resolve IN the plan (not blockers)

1. provider slug vs Nango `providerConfigKey` mapping (above).
2. Where the `/nango/webhook` URL gets registered in Nango (operator step — document it).
3. `request_connection` return text shape (what the bot posts to Slack around the link).
4. What happens on `success:false` webhook (failed consent) — log + ignore, no row.

## Done since this handoff was written (2026-06-01, follow-up session)

- advisor() pass landed. Incorporated.
- The plan doc IS written: `docs/superpowers/plans/2026-06-01-m2-self-serve-connect.md`. Next step = EXECUTE it (subagent-driven recommended), with the operator (Nango account + read-only provider integration) set up in parallel; live-probe + end-to-end test are the last two tasks.
- Plan-time deltas vs this handoff worth knowing: secure-form path stays CUT (decision #2); provider slug == Nango integration id by **convention** (no override built); **no `scope` param** on `request_connection` (scopes are integration-level in Nango); token fetch is **per-turn memoized** (one round-trip/turn); the **read-only-scope operator step is the write wall** (can't force GET-only — Notion reads use POST).
