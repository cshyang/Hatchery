# 0003 — Tool Connections (broker + GitHub adapter + human-approved writes)

Status: Proposed (design) · Date: 2026-05-30 · Builds on [0001](0001-runtime-and-tenancy.md), [0002](0002-skill-self-improvement.md)

## Context

The agent has identity, skills, memory, and self-scheduling — but no hands. It can't
reach GitHub, analytics, or any external service. Tool-connectivity is the capability that
turns Hatchery from "Slack assistant that remembers" into "agent that does work," and it's
use-case-independent: every real job needs it.

This ADR specifies the **connection layer**: how a project's external credentials are
stored, resolved, and exposed to the agent as tools — with a human in the loop for
consequential actions. First adapter: **GitHub** (reads via its official remote MCP; one
gated write, `create_issue`).

Scope note — this is **GitHub-the-API-connection** (issues, search, read code, comment),
NOT GitHub-the-coding-agent (clone, edit, test, push). The latter is the deferred
`sandboxMode` axis, not the connection axis. Don't let "GitHub" smuggle the sandbox in.

## The crux (the real Flue MCP API, and why writes still go through our own tool)

Flue exposes MCP as an **imperative function**, NOT a declarative config field (verified in
the installed `@flue/runtime/dist/mcp-*.d.mts`):

```ts
// the ACTUAL installed signature (mcp-CjdkFmEb.d.mts) — note what's NOT here:
connectMcpServer(name: string, {
  url: string | URL,               // remote endpoint (GitHub: https://api.githubcopilot.com/mcp/)
  transport?: 'streamable-http' | 'sse',   // defaults to streamable HTTP
  headers?: HeadersInit,           // → Authorization: Bearer <PAT>
  requestInit?, fetch?, clientName?, clientVersion?,
}): Promise<{ name: string; tools: ToolDefinition[]; close(): Promise<void> }>
```

There is **no `allowedTools` option and no declarative `mcpServers` config field** — both of
which an earlier draft of this ADR assumed. The real shape is imperative: you call
`connectMcpServer` yourself, it returns **plain `ToolDefinition[]`** (the same type
`defineTool` produces), and **you own `close()`**. Three consequences shape the design:

1. **Tool filtering is OURS to do** — there's no allow-list param, so the read/write membrane
   is `conn.tools.filter(t => READ_TOOLS.has(t.name))` after connecting. We control exactly
   which MCP tools reach the model.
2. **The returned tools are ordinary `ToolDefinition`s, so wrapping their `execute` IS
   possible** — but we don't need to for the gate, because of #3.
3. **Approval resolves in a *separate request*** — the operator clicks a Slack button minutes
   later, after the turn (and its MCP connection) has closed. A write executor can't rely on
   the live MCP connection. So the executor is a **stateless, direct-REST** call from the
   button-click handler, and the write simply isn't in the filtered MCP tool set at all.

> Therefore: **reads delegate to the GitHub MCP** (breadth, zero maintenance), filtered to a
> read allow-set; **the write is a Hatchery `defineTool`** that *proposes* the action, executed
> via direct GitHub REST in the button-click handler. The MCP gives breadth; the broker gives
> control; our filter is the membrane.

```
                    ┌──────────────── BROKER (src/connections.ts) ───────────────┐
   agent turn ────► │  resolveConnection(projectId, provider) → decrypt PAT      │
                    │  connectionState(projectId) → which providers are connected │
                    └──────┬───────────────────────────────────────────┬─────────┘
                           │ gating (initializer builds tools[])        │
              READS ───────▼───────────                    WRITES ──────▼────────────
        conn = connectMcpServer('github',     github_create_issue  (our defineTool)
          {url, headers:{Bearer PAT}})           → records pending_action
        tools.push(...conn.tools.filter(        → posts Block Kit [once][always][deny]
          t => READ_TOOLS.has(t.name)))          → returns "awaiting approval"
        model calls list_issues (no gate)             │
                                          operator clicks ▼ (Slack interactivity)
                                          /slack/interactivity (app.ts)
                                            → verify sig + OPERATOR check (user.id visible here)
                                            → execute via direct GitHub REST (stateless)
                                            → chat.update the message with the outcome
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
| D3 | **Reads via GitHub remote MCP** (`connectMcpServer` in the initializer, PAT Bearer header, returned tools filtered to a read allow-set) | Robust, GitHub-maintained, zero hand-rolling — the "use the robust MCP" thesis. **Gated on the v2a spike** (see Open #1): connect-per-turn latency + `close()` lifetime are unverified; documented fallback is direct-REST read tools. |
| D4 | **The write is NOT exposed via MCP; it's our own propose-tool + direct-REST executor** | Approval resolves in a *separate request* (the button click) where the turn's MCP connection is gone — so the executor must be stateless direct REST regardless. Filter the MCP's write tools out of `conn.tools` (keep only `READ_TOOLS`), and scope the PAT so the *only* write path is the gated one. |
| D5 | **Credential values envelope-encrypted (AES-GCM) in D1; metadata-only columns otherwise** | One secret-zero (`MASTER_ENCRYPTION_KEY`, a Worker secret). No new vendor, no per-call bill. D1 stores ciphertext + fingerprint + status, never plaintext. **Honest scope (advisor):** the key lives in the same Worker env as the decrypt code and `DB`, so this defends against a *credential-store-only* leak (misscoped read replica, backup export where Worker secrets don't travel) — NOT against Worker/CF-account compromise (which yields the key too). It's a narrow, real win, not "strong encryption at rest." Upgrade to a KMS/Secrets-Store-backed key if the threat model hardens. |
| D6 | **check_fn gating = the initializer builds the tool array from connection state** | Hatchery already does this for skills/memory (conditional `tools.push`). A tool is visible ⟺ its credential is `connected`. Cleaner than a per-tool callback and fits the existing pattern. |
| D7 | **Approval scope tiers: once / always / deny** (Block Kit buttons) | Stolen from Hermes ("Approved once by Shyang"). `once` = approve this action; `always` = + write an `approval_policies` row so future same-action calls skip the gate; `deny` = mark denied. Makes HITL bearable. |
| D8 | **Operator-only approval, enforced at `app.ts` `/slack/interactivity`** | Multi-tenant: the person in-channel may be a *client*. Letting them approve a write = privilege escalation. The interactivity POST (not a dispatch) carries `user.id`, so the check belongs at the gateway. **Order matters (advisor):** verify the Slack signature FIRST, then read `user.id` ONLY from the verified payload — never from the button `value` (attacker-controllable). Known limitation: operator ids hardcoded in `bindings.ts` means a personnel change is a deploy; acceptable for v2/demo, revisit before real multi-tenant. |
| D10 | **Approved artifact = executed artifact (confused-deputy guard)** | The Slack approval message renders the EXACT args (repo, title, body) from the `pending_actions` row, and the executor reads args ONLY from that stored row by `id` — never from the click payload. What the operator sees is what runs; a later step can't mutate the args between render and execute. |
| D9 | **v2 provisioning is out-of-band** (token-guarded admin route) | You are the operator; you set the PAT once. The in-Slack self-service connect flow + side-channel secret capture is deferred (v2c) — don't build onboarding before the broker resolves a credential. |

## Schema (`migrations/0005_connections.sql`)

```sql
-- One credential per (project, provider). Values are ciphertext; never plaintext in D1.
CREATE TABLE IF NOT EXISTS connections (
  project_id TEXT NOT NULL,
  provider TEXT NOT NULL,                 -- 'github'
  secret_ciphertext TEXT,                 -- base64(iv || AES-GCM ct); NULL until connected
  fingerprint TEXT,                       -- sha256(plaintext) prefix, for display only
  config_json TEXT,                       -- non-secret config, e.g. {"repo":"owner/name"}
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','connected','revoked')),
  created_by TEXT, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, provider)
);

-- A proposed write, parked until a human decides. The id rides in the Block Kit button value.
CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY,                     -- random; in the button value
  project_id TEXT NOT NULL, provider TEXT NOT NULL,
  action TEXT NOT NULL,                    -- 'create_issue'
  args_json TEXT NOT NULL,
  conversation_id TEXT,                    -- where to post the outcome
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','approved','denied','executed','failed')),
  requested_at INTEGER NOT NULL, resolved_by TEXT, resolved_at INTEGER
);

-- "Always approve" memory. Presence of a row = auto-approve that (project, provider, action).
CREATE TABLE IF NOT EXISTS approval_policies (
  project_id TEXT NOT NULL, provider TEXT NOT NULL, action TEXT NOT NULL,
  created_by TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, provider, action)
);
```

`pending_actions` status transitions are the idempotency guard: the click does
`UPDATE … SET status='approved' WHERE id=? AND status='pending'` and checks `changes` (the
same `meta.changes` pattern as `archive_skill`). A double-click sees 0 changes → "already
handled", so a write never fires twice.

## Files

| File | What |
|------|------|
| `src/crypto.ts` (new) | WebCrypto AES-GCM `encrypt`/`decrypt` (base64 iv‖ct) + `fingerprint` (sha256 prefix). ~35 lines. Key = `MASTER_ENCRYPTION_KEY` Worker secret. **Critical:** a FRESH random 12-byte IV per `encrypt` (`crypto.getRandomValues`), prepended to the ciphertext — never a counter/fixed nonce (GCM nonce reuse is catastrophic). The one line to get right. |
| `src/connections.ts` (new) | The broker: `connectionState(db, projectId)`, `resolveConnection(db, env, projectId, provider)` (decrypt), `upsertConnection(...)`, `connectionsBlock(state)` (the prompt block), and the **gated write tool(s)** `connectionTools(db, env, projectId)`. Closes over `db`+`projectId` like `skills.ts`. |
| `src/github.ts` (new) | **REST-first** (see build sequence): `githubReadTools(pat)` → ~5 `defineTool`s calling the GitHub REST API directly (stateless, at execute-time). `executeCreateIssue(pat, repo, {title, body})` → direct REST (the post-approval write executor). The `connectMcpServer`-based `connectGithubReads(pat)` is built ONLY if the MCP-lifetime spike passes; not the default. |
| `src/approvals.ts` (new) | `createPending`, `resolvePending` (status-guarded), `checkPolicy`, `recordPolicy`, and the action→executor dispatch table. |
| `src/slack/post.ts` (edit) | Add `blocks` support + `updateSlackMessage` (chat.update) for post-decision UX. |
| `src/bindings.ts` (edit) | Add `operatorUserIds: string[]` to `Binding` (who may approve). Demo = Shyang's Slack user id. |
| `.flue/agents/project.ts` (edit) | Initializer: query `connectionState`; if `github` connected, decrypt PAT → `connectGithubReads(pat)` and push its filtered tools + the gated write tool into `tools`; add the CONNECTIONS prompt block. (Hold the `close` handle — see Open #6.) |
| `.flue/app.ts` (edit) | New `/slack/interactivity` (verify sig → operator check → resolve pending → execute → chat.update). New `/__admin/connections` (out-of-band provisioning). **This route takes a raw PAT in the body — it's the highest-value attack surface in v2a:** POST-only; guarded by the same write-only shared-secret discipline as `HEARTBEAT_TOKEN` (`x-hatchery-token`, inert unless set + matches); NEVER log the body; encrypt before the row write so the plaintext exists only in-request. |
| `src/connections.test.ts` (new) | Invariants: project isolation; gating (tool absent when not connected); encrypt→decrypt round-trip; pending status-guard fires once; non-operator rejected; "always" policy auto-approves next call. |

## Build sequence (cut into reviewable slices)

**v2a is REST-FIRST. (Reversed from the first draft — evidence, not optimism.)** Our own
[[content-agent-plan]] memory is explicit: "Never keep in-memory caches (web clients, *MCP
sessions*) across activations — reload from SQLite each wake." A `connectMcpServer` handle
opened in the initializer and held until the model calls a tool *is* an MCP session spanning
the turn, across possible mid-turn hibernation. So we have strong prior evidence it won't
survive cleanly — MCP-in-DO is structurally suspect, and the read design must NOT lead with
it. Therefore:

- **Build `src/github.ts` as direct REST** (~5 read tools: `list_issues`, `get_issue`,
  `search_code`, `search_issues`, `get_file_contents`). Stateless, called at tool-execution
  time (not init), nothing to close. This is the v2a read path.
- **The MCP path is a ~30-min CONFIRMATION spike, not a coin flip.** Connect with a PAT, let
  the model call a read tool, check the connection is alive at `execute` (and post-hibernation).
  Only if it survives cleanly do we *consider* swapping REST->MCP for breadth. Expectation: it
  won't, and REST stays. Auth + read-only already verified (PAT Bearer, `/readonly` +
  `X-MCP-Readonly`, `X-MCP-Toolsets`), so the spike is purely about lifetime.

> **Thesis cost (name it, don't bury it):** "use the robust MCP, don't hand-roll" drove
> provider selection. If MCP connections don't survive a DO turn, that argument is undercut
> platform-wide. For GitHub it's harmless (REST is ~5 trivial endpoints). But for the OAuth/ad
> providers later (Composio/Meta/Google Ads) you can't trivially REST around a managed tool
> layer — so "does MCP-in-DO work at all?" is a **finding that reshapes the v3 adapter story**,
> not a GitHub footnote. Resolve it in the spike and record the answer.

**v2a — reads + spine (no writes).** broker + `connections` + `crypto` + admin
provisioning route + GitHub **REST** read tools (gated on connection state) + CONNECTIONS
prompt block. **Proves:** encrypted per-project PAT → GitHub reads appear *only when
connected*. The analog of a PostHog read-spine, but on GitHub. (MCP-reads swap is a possible
follow-up if the step-0 spike says the connection survives a DO turn.)

**v2b — the write gate.** `github_create_issue` proposal tool + `pending_actions` +
`approval_policies` + `/slack/interactivity` + Block Kit buttons + operator check +
chat.update. **Proves:** write-approval + polished Slack UX + operator-only + scope tiers.

> **Write-path tests are HARD GATES, not optional (advisor #2).** Unlike the read path, a
> silent bug here is a *security hole*, not a visible failure — so these are non-negotiable
> before any prod deploy, tested with the FakeD1 pattern already used in `skills`/`memory`:
> (a) **non-operator is rejected** (D8); (b) **double-click fires the write exactly once**
> (status-guard `meta.changes`); (c) **approved args == executed args** (D10 confused-deputy:
> executor reads args only from the stored row, never the click payload); (d) **GCM round-trip
> with a fresh IV per encrypt** (`crypto.ts`). "POC, skip tests" does NOT apply to the gate.

**v2c — deferred.** In-Slack `request_connection` + side-channel secret capture (self-service
connect). Operator out-of-band provisioning covers v2; build this when a non-operator needs
to connect their own account.

## Security properties

- Plaintext credential never touches D1, the model, the prompt, or Slack history — only the
  broker decrypts, in memory, at use. (Same discipline as `reply_in_channel`: the model makes
  *requests*; the trusted layer holds the secret.)
- Blast radius bounded by the **fine-grained PAT**: scope it to one repo, `Issues: write` +
  `Contents: read`, nothing else. A leak burns one repo, not an account.
- The only path to a write is the gated one: the GitHub create tool is never in the model's
  tool set (it's filtered out of the MCP tools, and our `github_create_issue` only *proposes*).
  The PAT carries write scope, but the only code that exercises it is the post-approval
  executor.
- Prompt-injection can't wire a rogue MCP or force a write: wiring is platform-only (config,
  not an agent tool), and every write waits on an operator button.

## Verified (was open, now closed)

- **GitHub remote MCP accepts a fine-grained PAT** as `Authorization: Bearer` at
  `https://api.githubcopilot.com/mcp/` (OAuth is the default, PAT is the documented alternative).
  → GitHub is genuinely the paste-key provider this ADR is built on. ✓
- **Server-enforced read-only exists** (`github/github-mcp-server` `docs/remote-server.md`):
  append `/readonly` to the URL, OR send `X-MCP-Readonly: true` (= `GITHUB_READ_ONLY`). → D4's
  belt-and-suspenders is real, not aspirational. ✓ **Use BOTH** the `/readonly` URL and the
  header — defense in depth, then our own `READ_TOOLS` filter on top.
- **Toolset selection** server-side via `X-MCP-Toolsets: "issues,repos"` (= `GITHUB_TOOLSETS`),
  plus `X-MCP-Lockdown` for extra restriction. So three nested guards: `X-MCP-Toolsets` (which
  families) → `/readonly`+`X-MCP-Readonly` (no writes) → our `READ_TOOLS` set (exact names). ✓

## Open items (resolve in the v2a spike — not blockers)

1. **MCP connection lifetime** (the v2a step-0 spike above) — the single load-bearing unknown.
   Does the `connectMcpServer` connection survive initializer → tool-call → mid-turn
   hibernation? Determines MCP-reads vs REST-reads fallback.
2. **Exact GitHub MCP read tool names** for the `READ_TOOLS` filter set (connect + enumerate
   `conn.tools`; likely `list_issues`, `get_issue`, `search_code`, `search_issues`,
   `get_file_contents`, …). Our filter, on top of the server's `/readonly`.
3. **Slack interactivity** — enable in the app config, set the Request URL to
   `/slack/interactivity`; confirm `verifySlackSignature` works on the raw **form-encoded**
   body (it signs the raw body regardless of content-type — the payload is a `payload=<json>`
   form field).
4. **Connect-per-turn latency** — if MCP reads win the spike, the connect+list happens every
   turn; `.catch` it (a GitHub-MCP hiccup must not break the agent, same as the skills query)
   and watch added latency on interactive replies.

## Forward-looking guards (write down so future-you doesn't inherit a footgun)

- **"Always" + spend-affecting actions = a loaded gun.** An `approval_policies` row means
  "auto-approve forever." Harmless for `create_issue`; dangerous the day this machinery points
  at Google Ads / Meta Ads budget changes. Before extending `always` to any spend- or
  money-affecting action: scope it (per-amount cap? expiry? re-confirm?), don't let a blanket
  `always: change_budget` row exist.

## Migration path (the hedge)

`resolveConnection` is the seam. Today its body decrypts from D1. When an OAuth-heavy
provider arrives (Google Ads, Meta Ads), a new adapter behind the same function handles
consent/refresh — Composio cloud, or Nango/Composio self-host if client trust demands creds
stay in our infra. The agent, tools, gating, and approval flow don't change. The sandbox
egress-broker (deferred) reuses the same `resolveConnection` at the network boundary instead
of at a tool call.
```
