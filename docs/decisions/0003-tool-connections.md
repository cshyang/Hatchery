# 0003 — Tool Connections (broker + GitHub adapter + human-approved writes)

Status: Proposed (design) · Date: 2026-05-30 · Builds on [0001](0001-runtime-and-tenancy.md), [0002](0002-skill-self-improvement.md)

> **Update 2026-05-30 — v2a simplification (supersedes the secret-storage parts below).**
> v2a as built does NOT use encrypted-D1 secret storage. Codex + a simplicity review surfaced
> that "self-service UX" and "self-managed secret vault" are independent decisions I'd wrongly
> welded: the operator (you) provisions a handful of projects, so a credential is a **Worker
> secret referenced by name from the binding** (`connections: [{provider, tokenRef, config}]`,
> resolved as `env[tokenRef]`) — identical to how `transportTokenRef` already handles the Slack
> token, and no less secure at rest (CF KMS, write-only) than hand-rolled ciphertext.
>
> **Cut from v2a:** `crypto.ts` (AES envelope), `MASTER_ENCRYPTION_KEY`, `ADMIN_CONNECTIONS_TOKEN`,
> `/__admin/connections`, the `connections`/`pending_actions`/`approval_policies` D1 tables
> (migration 0005), and `secret_ciphertext`. No new secrets, no key-management burden.
> **Kept:** the `resolveConnection` SEAM, REST read tools, gating, the prompt block.
>
> The encrypted-D1 design below (D5/D9/D10/D11, schema, admin route) is NOT deleted — it is the
> documented answer for the day a backend must hold a raw secret that arrives at RUNTIME:
> **static-key self-service** (a client pastes a key in Slack, no operator). Its code lives in git
> history at commit `56cc049`. Per-provider routing of the seam:
> - **operator static keys (NOW):** Worker-secret ref — the v2a path.
> - **OAuth providers (Google Ads, Meta — LATER):** a Composio/Nango account-ref; the vendor holds
>   + refreshes the token, MoreHands stores only the ref. No master key.
> - **static-key self-service (IF the pain is real):** encrypted D1 or a managed vault — decide then.
>
> `pending_actions`/`approval_policies` (the write-approval machinery) return in **v2b**, which is
> where they're actually used.

> **Update 2026-05-31 — Test A (bet-on-intelligence) result + the generalization finding.**
> Built ONE generic tool `github_call_api(method, path)` (gated to `apiMode: 'generic'` on the
> connection config; default stays the typed v2a reads). The broker injects the PAT at the network
> boundary; the model composes the REST call from its own knowledge. Deployed live (version
> `7286e71a`). **Result: passed cold through Tier 4.** The model correctly composed endpoints we
> never hand-wrote — `/repos/{r}/languages` (exact byte counts) and `/repos/{r}/contributors`
> (commit counts) — plus README-via-contents (base64-decoded). Transcript verified in D1.
>
> **What it proves and what it does NOT.** It proves the *mechanism*: a single generic tool +
> broker-injected credential lets the model reach the long tail of an API for free, so for a
> well-represented provider we need neither hand-written typed tools nor a vendor's bundled tools.
> It does NOT prove universal coverage. Bet-on-intelligence is really a bet on **training density ×
> API regularity**, and GitHub REST maxes both — it's the ceiling, not the floor. Two structural
> limits surfaced, not tuning issues:
> 1. **The method-based write-gate is GitHub-shaped.** "GET = read, POST = write→approval" breaks
>    on APIs that read via POST. **Notion** queries a database with `POST /v1/databases/{id}/query`
>    and searches with `POST /v1/search` — both reads. **Linear** is GraphQL: one endpoint, every
>    op is `POST /graphql`. So a GET-only gate blocks legitimate reads on both. Read-vs-write must
>    be a per-provider classification, not an HTTP-method heuristic.
> 2. **Low-density / quirky providers need a crib.** Notion needs a required `Notion-Version`
>    header the model routinely omits; PostHog's project-scoped paths and HogQL are sparse in
>    training; Google/Meta Ads paths are versioned and arcane. The fix is a small per-provider
>    **crib** (base URL, required headers, the handful of endpoints that matter, GraphQL pointer)
>    injected into the prompt via the existing skills/blocks mechanism — a few hundred tokens, not
>    a maintained typed toolkit.
>
> **Architecture conclusion (refines the vendor question):** generic `call_api` is the DEFAULT for
> every provider; a per-provider crib closes the density gap only where needed; the read/write
> classification is per-provider. The **vendor stays auth-only** — Composio's tool-bundling is not
> needed. Next: a live test on a LOW-density provider (Notion) to find the floor; that test, not
> GitHub, decides the design. See `src/github.ts` (`githubCallApiTool`) and the `apiMode` seam.

## Context

The agent has identity, skills, memory, and self-scheduling — but no hands. It can't
reach GitHub, analytics, or any external service. Tool-connectivity is the capability that
turns MoreHands from "Slack assistant that remembers" into "agent that does work," and it's
use-case-independent: every real job needs it.

This ADR specifies the **connection layer**: how a project's external credentials are
stored, resolved, and exposed to the agent as tools — with a human in the loop for
consequential actions. First adapter: **GitHub** — reads as a small set of **direct-REST
tools** (the v2a path; GitHub's remote MCP is a deferred swap, see Build sequence), plus one
gated write, `create_issue`.

Scope note — this is **GitHub-the-API-connection** (issues, search, read code, comment),
NOT GitHub-the-coding-agent (clone, edit, test, push). The latter is the deferred
`sandboxMode` axis, not the connection axis. Don't let "GitHub" smuggle the sandbox in.

## The crux (reads via direct REST; the write goes through our own gated tool)

GitHub exposes two surfaces — a maintained **remote MCP server**
(`https://api.githubcopilot.com/mcp/`, PAT-as-Bearer, `/readonly` + `X-MCP-Toolsets`) and the
plain **REST API**. The "use the robust MCP, don't hand-roll" thesis argued for MCP. But Flue's
MCP client is an **imperative connection** with a lifetime problem in a Durable Object (see
Build sequence), so **v2a leads with direct REST** and treats MCP as a later swap.

For completeness, the verified Flue MCP API (installed `@flue/runtime/dist/mcp-*.d.mts`) — note
it's imperative, NOT a declarative config field:

```ts
connectMcpServer(name: string, {
  url: string | URL,               // remote endpoint (GitHub: https://api.githubcopilot.com/mcp/)
  transport?: 'streamable-http' | 'sse',   // defaults to streamable HTTP
  headers?: HeadersInit,           // -> Authorization: Bearer <PAT>
  requestInit?, fetch?, clientName?, clientVersion?,
}): Promise<{ name: string; tools: ToolDefinition[]; close(): Promise<void> }>
```

There is **no `allowedTools` option and no declarative `mcpServers` config field** — both of
which an earlier draft assumed. You call `connectMcpServer` yourself, it returns plain
`ToolDefinition[]`, and **you own `close()`**. Whichever read transport we use, **the write
does NOT go through it** — three reasons:

1. **Approval resolves in a *separate request*.** The operator clicks a Slack button minutes
   later, after the turn (and any live connection) is gone. The write executor therefore must
   be a **stateless, direct-REST** call from the button-click handler — it can't depend on a
   connection held open during the turn.
2. **So the write is never a model-callable tool at all.** The agent's `github_create_issue`
   only *proposes* (records a pending action + posts the approval prompt). The actual REST
   write lives in the gateway, behind the operator gate.
3. **Reads are read-only by construction** — REST tools that only GET, or (if MCP is later
   swapped in) `conn.tools` filtered to `READ_TOOLS` on top of the server's `/readonly`.

> The broker gives control; the read transport gives breadth; the gate gives safety.

```
                    +--------------- BROKER (src/connections.ts) ----------------+
   agent turn ----> |  resolveConnection(projectId, provider) -> decrypt PAT     |
                    |  connectionState(projectId) -> which providers connected    |
                    +------+------------------------------------------+-----------+
                           | gating (initializer builds tools[])       |
              READS -------v-----------                    WRITES ------v-----------
        githubReadTools(pat):                 github_create_issue  (our defineTool)
          ~5 direct-REST defineTools            -> records pending_action (+ args_hash)
          (list_issues, get_issue, ...)         -> posts Block Kit [once][always][deny]
          model calls list_issues (read-only)   -> returns "awaiting approval"
                                                       |
                                       operator clicks v (Slack interactivity)
                                       /slack/interactivity (app.ts)
                                         -> verify sig FIRST, then read user.id
                                         -> OPERATOR check; resolve pending (status-guard)
                                         -> execute via direct GitHub REST (args from row)
                                         -> chat.update the message with the outcome
```

This reuses the project's load-bearing finding (author-blindness): the agent/tool layer
can't see *who* acts, so the **operator-only** check lives at the **gateway** (`app.ts`),
where Slack's `user.id` is visible — exactly where the message-logging and engage checks
already live.

## Decisions

| # | Decision | Reason |
|---|----------|--------|
| D1 | **Broker owns secrets + policy; vendors are swappable adapters** behind `resolveConnection(projectId, provider)` | Lets us defer vendor choice without redesign. Native today; a Composio/Nango adapter slots behind the same interface the day OAuth-heavy providers land. |
| D2 | **Per-project credentials**, operator-provisioned | Agency model: you connect a client's account once. Keys off `projectId` (from `ctx.id`) — sidesteps the author-blindness wall that killed per-user memory. |
| D3 | **Reads as direct-REST tools (v2a); GitHub remote MCP is a deferred swap** | The "use the robust MCP" thesis is sound, but MCP-in-DO connection lifetime is suspect (see Build sequence + Open #1). REST is ~5 trivial GET endpoints, stateless, nothing to `close()`. If the MCP-lifetime spike passes, swap REST->MCP behind the same `githubReadTools` seam for breadth. |
| D4 | **The write is NOT a model-callable tool; it's a propose-tool + direct-REST executor** | Approval resolves in a *separate request* (the button click) where any live connection is gone — so the executor must be stateless direct REST regardless. The agent only proposes; the only code that exercises the PAT's write scope is the post-approval executor. |
| D5 | **Credential values envelope-encrypted (AES-GCM) in D1; metadata-only columns otherwise** | One secret-zero (`MASTER_ENCRYPTION_KEY`, a Worker secret). No new vendor, no per-call bill. D1 stores ciphertext + fingerprint + status, never plaintext. **Honest scope:** the key lives in the same Worker env as the decrypt code and `DB`, so this defends against a *credential-store-only* leak (misscoped read replica, backup export where Worker secrets don't travel) — NOT against Worker/CF-account compromise (which yields the key too). A narrow, real win, not "strong encryption at rest." Upgrade to a KMS/Secrets-Store-backed key if the threat model hardens. |
| D6 | **check_fn gating = the initializer builds the tool array from connection state** | MoreHands already does this for skills/memory (conditional `tools.push`). A tool is visible iff its credential is `connected`. Cleaner than a per-tool callback and fits the existing pattern. |
| D7 | **Approval scope tiers: once / always / deny** (Block Kit buttons) | From Hermes ("Approved once by Shyang"). `once` = approve this action; `always` = + write an `approval_policies` row so future *matching* calls skip the gate (scope rules in D9); `deny` = mark denied. Makes HITL bearable. |
| D8 | **Operator-only approval, enforced at `app.ts` `/slack/interactivity`** | Multi-tenant: the person in-channel may be a *client*. Letting them approve a write = privilege escalation. The interactivity POST carries `user.id`. **Order matters:** verify the Slack signature FIRST, then read `user.id` ONLY from the verified payload — never from the button `value` (attacker-controllable). Known limitation: operator ids hardcoded in `bindings.ts` means a personnel change is a deploy; acceptable for v2/demo, revisit before real multi-tenant. |
| D9 | **`always` is scoped + bounded, never "blanket approve this action"** | An `approval_policies` row is NOT keyed only by `(project, provider, action)` — that would auto-approve *any* future args (any issue, any repo). It carries a `constraint_json` (e.g. pinned `repo`), an `expires_at`, and an optional `max_per_day`. The executor re-checks the constraint at fire time. For v2b this can be **deferred entirely** (offer only `once`/`deny`); if `always` ships, it ships scoped. This is the guardrail that matters the day the same machinery points at ad-spend writes. |
| D10 | **Approved artifact = executed artifact (confused-deputy guard), ENFORCED** | Not just a convention. `pending_actions` stores `args_json` + an `args_hash` (sha256 of canonicalized args) written at propose time. The approval message renders those exact args; the executor reads args **only** from the row by `id`, recomputes the hash, and refuses if it doesn't match. The click payload carries only the pending `id` + decision — never args. Tested (see v2b). |
| D11 | **Provisioning is out-of-band via a DEDICATED admin token** (v2; self-service deferred to v2c) | You are the operator; you set the PAT once. The route takes a raw PAT, so it is guarded by its **own** `ADMIN_CONNECTIONS_TOKEN` — NOT the `HEARTBEAT_TOKEN`/scheduler trust boundary (reusing that would let any heartbeat/scheduler caller provision credentials). Prefer Cloudflare Access or a local-only operator workflow if available. In-Slack self-service connect + side-channel secret capture is v2c. |

## Schema (`migrations/0005_connections.sql`)

**v2a scope is intentionally a single GitHub connection per project.** The `connections` PK is
`(project_id, provider)` — correct for "one client account per provider." Multi-account (the
Composio/Nango OAuth future, where one provider has many connected accounts) needs a
`connection_id` PK + `external_account_id`/`subject`; that is a deliberate **v3 migration**, not
v2a. The columns below reserve the seam without building it.

```sql
-- v2a: one credential per (project, provider). Values are ciphertext; never plaintext in D1.
-- v3 (multi-account OAuth) will add connection_id PK + external_account_id; reserved, not used now.
CREATE TABLE IF NOT EXISTS connections (
  project_id TEXT NOT NULL,
  provider TEXT NOT NULL,                 -- 'github'
  external_account_id TEXT,               -- reserved for v3 multi-account; NULL in v2a
  secret_ciphertext TEXT,                 -- base64(iv || AES-GCM ct); NULL until connected
  fingerprint TEXT,                       -- sha256(plaintext) prefix, for display only
  config_json TEXT,                       -- non-secret config, e.g. {"repo":"owner/name"}
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','connected','revoked')),
  created_by TEXT, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, provider)      -- v3: -> connection_id; keep (project,provider) UNIQUE
);

-- A proposed write, parked until a human decides. The id (only) rides in the Block Kit button value.
CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY,                     -- random; the ONLY thing in the button value
  project_id TEXT NOT NULL, provider TEXT NOT NULL,
  action TEXT NOT NULL,                    -- 'create_issue'
  args_json TEXT NOT NULL,                 -- canonical args; rendered in the approval message
  args_hash TEXT NOT NULL,                 -- sha256(canonical args); executor re-checks (D10)
  conversation_id TEXT,                    -- where to post the outcome
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','approved','denied','executed','failed')),
  requested_at INTEGER NOT NULL, resolved_by TEXT, resolved_at INTEGER
);

-- "Always approve" memory, SCOPED + BOUNDED (D9) — never a blanket (project,provider,action).
CREATE TABLE IF NOT EXISTS approval_policies (
  project_id TEXT NOT NULL, provider TEXT NOT NULL, action TEXT NOT NULL,
  constraint_json TEXT NOT NULL,          -- e.g. {"repo":"owner/name"} — executor re-checks at fire time
  max_per_day INTEGER,                    -- optional rate cap; NULL = unlimited
  expires_at INTEGER,                     -- optional TTL; NULL = no expiry (discouraged for writes)
  created_by TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, provider, action, constraint_json)
);
```

The idempotency guard is the status transition: the click does
`UPDATE pending_actions SET status='approved' WHERE id=? AND status='pending'` and checks
`changes` (the `meta.changes` pattern from `archive_skill`). A double-click sees 0 changes ->
"already handled", so a write never fires twice. The executor then reads `args_json`/`args_hash`
from the row (D10) — never from the click — recomputes the hash, and refuses on mismatch.

## Files

| File | What |
|------|------|
| `src/crypto.ts` (new) | WebCrypto AES-GCM `encrypt`/`decrypt` (base64 iv-bar-ct) + `fingerprint` (sha256 prefix) + `argsHash` (sha256 of canonicalized JSON, for D10). ~40 lines. Key = `MASTER_ENCRYPTION_KEY` Worker secret. **Critical:** a FRESH random 12-byte IV per `encrypt` (`crypto.getRandomValues`), prepended to the ciphertext — never a counter/fixed nonce (GCM nonce reuse is catastrophic). |
| `src/connections.ts` (new) | The broker: `connectionState(db, projectId)`, `resolveConnection(db, env, projectId, provider)` (decrypt), `upsertConnection(...)`, `connectionsBlock(state)` (the prompt block), and the **gated propose-tool(s)** `connectionTools(db, env, projectId)`. Closes over `db`+`projectId` like `skills.ts`. |
| `src/github.ts` (new) | **REST-first:** `githubReadTools(pat)` -> ~5 `defineTool`s calling the GitHub REST API directly (stateless, at execute-time). `executeCreateIssue(pat, repo, {title, body})` -> direct REST (the post-approval write executor). An optional `connectGithubReads(pat)` (via `connectMcpServer`) is built ONLY if the MCP-lifetime spike passes; not the default. |
| `src/approvals.ts` (new) | `createPending` (writes `args_hash`), `resolvePending` (status-guarded), `checkPolicy` (constraint + expiry + rate re-check, D9), `recordPolicy`, and the action->executor dispatch table. |
| `src/slack/post.ts` (edit) | Add `blocks` support + `updateSlackMessage` (chat.update) for post-decision UX. |
| `src/bindings.ts` (edit) | Add `operatorUserIds: string[]` to `Binding` (who may approve). Demo = Shyang's Slack user id. |
| `.flue/agents/project.ts` (edit) | Initializer: query `connectionState`; if `github` connected, decrypt PAT -> `githubReadTools(pat)` + the gated propose-tool into `tools`; add the CONNECTIONS prompt block. |
| `.flue/app.ts` (edit) | New `/slack/interactivity` (verify sig -> read user.id from verified payload -> operator check -> resolve pending (status-guard) -> re-check args_hash -> execute -> chat.update). New `/__admin/connections` (out-of-band provisioning) — see below. |
| `src/connections.test.ts` (new) | Invariants: project isolation; gating (tool absent when not connected); encrypt->decrypt round-trip with fresh IV; pending status-guard fires once; non-operator rejected; args_hash mismatch refused; scoped `always` honors constraint + expiry. |

### `/__admin/connections` — the highest-risk endpoint (P1, take it seriously)

It accepts a **raw PAT** in the body. Therefore:

- **Its own dedicated token: `ADMIN_CONNECTIONS_TOKEN`.** Do NOT reuse `HEARTBEAT_TOKEN` or the
  scheduler trust boundary — provisioning credentials and poking heartbeats are different
  privilege levels, and the heartbeat token is shared with the ticker worker.
- Prefer **Cloudflare Access** (identity in front of the route) or a **local-only / operator-only
  workflow** over a bearer secret if either is available in the deploy.
- POST-only; **never log the body**; encrypt before the row write so plaintext exists only
  in-request; respond with the fingerprint, never the secret.

## Build sequence (cut into reviewable slices)

**v2a is REST-FIRST. (Reversed from an earlier draft — evidence, not optimism.)** Our own
[[content-agent-plan]] memory is explicit: "Never keep in-memory caches (web clients, *MCP
sessions*) across activations — reload from SQLite each wake." A `connectMcpServer` handle
opened in the initializer and held until the model calls a tool *is* an MCP session spanning
the turn, across possible mid-turn hibernation. Strong prior evidence it won't survive cleanly,
so the read path must NOT lead with MCP.

- **Build `src/github.ts` as direct REST** (~5 read tools: `list_issues`, `get_issue`,
  `search_code`, `search_issues`, `get_file_contents`). Stateless, called at tool-execution
  time, nothing to close. This is the v2a read path.
- **The MCP path is a ~30-min CONFIRMATION spike, not a coin flip.** Connect with a PAT, let
  the model call a read tool, check the connection is alive at `execute` (and post-hibernation).
  Only if it survives cleanly do we *consider* swapping REST->MCP for breadth. Auth + read-only
  already verified (PAT Bearer, `/readonly` + `X-MCP-Readonly`, `X-MCP-Toolsets`), so the spike
  is purely about lifetime.

> **Thesis cost (name it, don't bury it):** "use the robust MCP, don't hand-roll" drove
> provider selection. If MCP connections don't survive a DO turn, that argument is undercut
> platform-wide. For GitHub it's harmless (REST is ~5 trivial endpoints). But for the OAuth/ad
> providers later (Composio/Meta/Google Ads) you can't trivially REST around a managed tool
> layer — so "does MCP-in-DO work at all?" is a **finding that reshapes the v3 adapter story**,
> not a GitHub footnote. Resolve it in the spike and record the answer.

**v2a — reads + spine (no writes).** broker + `connections` + `crypto` + dedicated admin
provisioning route + GitHub **REST** read tools (gated on connection state) + CONNECTIONS
prompt block. **Proves:** encrypted per-project PAT -> GitHub reads appear *only when
connected*. The analog of a PostHog read-spine, but on GitHub.

**v2b — the write gate.** `github_create_issue` propose-tool + `pending_actions` (with
`args_hash`) + `/slack/interactivity` + Block Kit buttons + operator check + chat.update.
`always`/`approval_policies` is **optional in v2b** (D9) — ship `once`/`deny` first; add scoped
`always` only with constraint+expiry. **Proves:** write-approval + polished Slack UX +
operator-only + confused-deputy guard.

> **Write-path tests are HARD GATES, not optional.** Unlike the read path, a silent bug here is
> a *security hole*, not a visible failure — non-negotiable before any prod deploy, tested with
> the FakeD1 pattern from `skills`/`memory`: (a) **non-operator rejected** (D8); (b) **double-click
> fires the write exactly once** (status-guard); (c) **approved args == executed args** (D10:
> executor reads from the row + re-checks `args_hash`, never the click payload); (d) **GCM
> round-trip with a fresh IV per encrypt** (`crypto.ts`); (e) if `always` ships, **a scoped policy
> does not approve out-of-constraint args** (D9). "POC, skip tests" does NOT apply to the gate.

**v2c — deferred.** In-Slack `request_connection` + side-channel secret capture (self-service
connect). Operator out-of-band provisioning covers v2.

## Security properties

- Plaintext credential never touches D1, the model, the prompt, or Slack history — only the
  broker decrypts, in memory, at use. (Same discipline as `reply_in_channel`: the model makes
  *requests*; the trusted layer holds the secret.)
- Blast radius bounded by the **fine-grained PAT**: scope it to one repo, `Issues: write` +
  `Contents: read`, nothing else. A leak burns one repo, not an account.
- The only path to a write is the gated one: the create tool is never model-callable (the agent
  only proposes), and the executor runs only after the operator gate + `args_hash` re-check.
- Provisioning is isolated behind its **own** token (D11), not the shared heartbeat boundary.
- Prompt-injection can't wire a rogue MCP or force a write: wiring is platform-only (config,
  not an agent tool), and every write waits on an operator button.

## Verified (was open, now closed)

- **GitHub remote MCP accepts a fine-grained PAT** as `Authorization: Bearer` at
  `https://api.githubcopilot.com/mcp/` (OAuth default, PAT documented alternative). (Relevant
  only if/when MCP is swapped in for reads.)
- **Server-enforced read-only exists** (`github/github-mcp-server` `docs/remote-server.md`):
  append `/readonly` to the URL, or send `X-MCP-Readonly: true`. Plus `X-MCP-Toolsets` and
  `X-MCP-Lockdown`. Defense-in-depth for the MCP-read variant; the REST variant is read-only by
  construction (GET-only tools).

## Open items (resolve in the v2a spike — not blockers)

1. **MCP connection lifetime** — does a `connectMcpServer` connection survive initializer ->
   tool-call -> mid-turn hibernation? Determines whether the REST reads ever get swapped for MCP,
   and (bigger) whether MCP-in-DO is viable for the v3 OAuth/ad providers.
2. **Exact GitHub REST read shapes** — confirm the ~5 endpoints + minimal scopes for the
   fine-grained PAT (`Issues: read`, `Contents: read`, `Metadata: read`).
3. **Slack interactivity** — enable in the app config, set the Request URL to
   `/slack/interactivity`; confirm `verifySlackSignature` works on the raw **form-encoded** body
   (it signs the raw body regardless of content-type — the payload is a `payload=<json>` field).

## Migration path (the hedge)

`resolveConnection` is the seam. Today its body decrypts from D1. When an OAuth-heavy provider
arrives (Google Ads, Meta Ads), a new adapter behind the same function handles consent/refresh —
Composio cloud, or Nango/Composio self-host if client trust demands creds stay in our infra —
and the schema gains `connection_id`/`external_account_id` for multi-account. The agent, tools,
gating, and approval flow don't change. The sandbox egress-broker (deferred) reuses the same
`resolveConnection` at the network boundary instead of at a tool call.

---

## Update 2026-06-01 — M2 BUILT: Nango self-serve connect (the managed-OAuth backend, live-proven)

The "OAuth providers → a Nango account-ref" hedge above is now BUILT and live-proven end to end
(Slack → Nango → Notion). Merged via branch `m2-self-serve-connect`. All Nango wire code lives in
`src/nango.ts` behind the unchanged `resolveConnection` seam; zero schema change (the reserved
`connection_ref` column from migration 0005 + `ConnectionSpec.connectionRef` carried it).

**Shape (what shipped):**
- `request_connection(provider)` + `disconnect_connection(provider)` tools — both **no-secret-param**
  (the structural wall: a prompt-injected agent has no tool that can receive/store a credential).
  Gated on `db && NANGO_SECRET_KEY`. Connect returns a Nango magic link; disconnect calls Nango
  `DELETE /connection/{id}` (real revoke) then disables the local row.
- `resolveConnection` Nango branch returns a **lazy, per-turn-memoized token thunk** (`() =>
  Promise<string>`) — the DO initializer stays network-light (partyserver ~30s reset), the live
  token is fetched only inside a tool's `execute()`, once per turn. Never stored at rest; only the
  non-secret `connection_ref` lives in D1.
- `/nango/webhook` (gateway): HMAC-verified (`X-Nango-Hmac-Sha256` over RAW body, dedicated
  `NANGO_WEBHOOK_SECRET`), creation → `upsertConnection(connection_ref)`, deletion → disable row.
  Gateway posts deterministic "✅ connected" / "🔌 disconnected" to the channel (NOT an agent turn —
  a model might skip the reply).
- Two operator secrets: `NANGO_SECRET_KEY` (API) + `NANGO_WEBHOOK_SECRET` (verify inbound).
- Convention: Nango integration id == catalog provider slug (no mapping table; webhook guards on it).

**Live wire findings (docs 404 constantly — these came from probing the real API):**
1. Nango wraps `POST /connect/sessions` + `GET /connection/{id}` as `{ data: {...} }`, not flat.
   `nangoBody()` unwraps tolerantly.
2. "Already gone" is reported by error CODE, and Nango is **inconsistent across verbs**: DELETE →
   `400 {code:'unknown_connection'}`, GET → `404 {code:'not_found'}`. `deleteConnection` keys
   idempotency off the code, never the status.
3. **Dashboard-delete in the Nango UI fires NO webhook** (tailed, confirmed). So the deletion-webhook
   handler is defensive for the operator path; the real disconnect is the in-Slack tool calling the
   DELETE API. The 404-at-use net (`fetchToken` of a dead ref throws) catches a dashboard-delete.

**The write-wall — IMPORTANT, supersedes the GET-only assumption (D-gate refinement):** for a Nango
OAuth token we CANNOT gate writes by HTTP method (Notion reads use POST; `methodPolicy:'all'`). The
read-only guarantee therefore comes from **the operator registering each Nango integration with
read-only OAuth scopes**. A write-scoped integration on a `methodPolicy:'all'` provider is a silent
write path until the v2b approval gate ships. Disconnect itself is agent-callable WITHOUT approval
(least-dangerous write — worst case is reconnect).

**PRODUCTION GATE (not yet done):** the live proof ran on Nango's SHARED Notion app (carries
write scopes you can't change). Before real Testers: register your OWN Notion public OAuth app,
read-content-only capabilities, paste client id/secret into the Nango `notion` integration.

**Deferred (M3):** dynamic catalog via Nango `GET /integrations` (kills per-provider catalog edits);
optional Nango Proxy for calls (kills per-provider `api.ts` profiles, costs a hop + the methodPolicy
gate). In-thread notice placement (decided: keep channel-root; threading needs an unverified
Nango-tag-roundtrip — spike before building).
