# Multi-channel agent + self-serve connect (design)

Date: 2026-05-31 · Status: Design (approved, pre-plan) · Builds on [ADR 0003](../../decisions/0003-tool-connections.md)

## Goal

Let the operator drop the MoreHands agent into **any channel of the existing Slack
workspace** and have it work immediately as its own isolated project, then let whoever
is in that channel (operator or a non-technical teammate, "Tester") **connect tools
through the conversation** — without a redeploy, without the credential ever entering
the Slack channel, and without per-channel pre-configuration.

Success: in a brand-new channel, `@bot` → it replies (blank but alive, with shared
baseline skills) → `@bot connect notion` → a button → off-channel consent → `✅
connected` → the agent now has Notion tools scoped to **that channel only**.

## Scope decisions (settled during brainstorm)

- **Same workspace, any channel** — NOT a distributable multi-workspace app. One bot
  token, reused across all channels of the known team (Slack allows this natively). The
  "Add to Slack" OAuth-install iceberg (per-workspace token storage, install callback) is
  **explicitly cut**; it returns only if a separate workspace ever needs the agent.
- **Channel = project.** Each channel auto-becomes its own `project_id` (= the channel id)
  on first @mention, with its own connections + memory. The "two channels share one
  project" case (e.g. marketing + sales → one brain) is **deferred** — not built until a
  real need pulls it. (It stays possible later via a channel→project override; the data
  model already allows it because everything keys on `project_id`.)
- **Skills are globally shared; memory + connections are per-channel.** A new channel
  inherits a shared baseline of skills (live, not copied) but starts with empty memory and
  no connections. This is the safe cascade: shared know-how, private facts and tokens.
- **Nango is platform infra** the operator sets up once (one secret + per-provider OAuth
  app registrations); every channel/user uses it, scoped per channel.
- **The hard line holds:** the agent REQUESTS a connection (a tool that returns a link);
  a human/verified-flow PROVISIONS it (off-channel consent or secure form). No tool that
  accepts a raw secret exists. A credential never touches the Slack channel, the
  `messages` D1 table, REM, or the model.

## Mental model

```
   Slack channel  ──auto──▶  project_id = channel id   (born on first @mention)
        ├── connections ── per channel   (D1 connections table, ADR 0003)
        ├── memory ──────── per channel   (isolated by project_id, existing)
        └── skills ──────── GLOBAL ('__global__') ∪ channel  (channel overrides by name)
```

```
   LIFECYCLE
   1. bot invited to #tester-stuff
   2. first @mention → binding row auto-created (project_id = channel id), alive & blank
   3. inherits global skills (base personality, how-to-use-connections), empty memory
   4. "@bot connect notion" → off-channel capture (Nango / secure form) → connected
   5. agent now has hands, scoped to THIS channel only
```

What already exists (wire it, don't build it): per-channel connections (ADR 0003 D1
table), per-channel memory (isolated by `project_id`), the operator admin route pattern,
the `connection_ref` / `token_ref` seam in the `connections` row.

What is genuinely new: (1) auto-create a binding on first @mention; (2) global-skills
merge; (3) the `request_connection` tool + Nango backend + off-channel callback/form.

---

## Component 1 — Auto-binding on first @mention

**Problem:** `bindings.ts` is one frozen literal (one team, one channel, one bot token);
`bindingBySlack(team, channel)` finds no match for any other channel, so the bot ignores
it.

**Mechanism** (mirrors the connections D1 + code-seed cascade already shipped):

```
   @mention in #new-channel
     → bindingBySlack(team, channel)?
         found (seed OR D1 row)        → dispatch as normal
         NOT found, but team is OURS   → auto-create a binding row in D1:
             project_id      = channel id
             externalSpaceId = channel id
             bot token ref   = the SAME workspace token (one install, all channels)
             status          = active
           → then dispatch. Bot replies, blank but alive.
```

Source of truth: `bindings.ts` seed (keeps the demo working) ∪ D1 `bindings` rows
(auto-created, the live source). `bindingBySlack` / `bindingByProject` check seed first,
then D1.

**Guardrails:**
1. **Team allowlist** — auto-create ONLY for the known team id(s). A stray @mention from
   any other workspace is ignored, never provisioned. This is the wall that keeps "any
   channel" from silently becoming "any workspace."
2. **@mention-gated** — a channel becomes a project only when the bot is explicitly
   addressed. Being added to a channel but never used provisions nothing.
3. **Race-safe** — `INSERT … ON CONFLICT(project_id) DO NOTHING` (the idempotent upsert
   from connections) so two fast @mentions create exactly one row.

**Trust-source note:** this is the first binding created by an *inbound event* rather than
operator-typed config. It is still not the *agent* creating it — it's the gateway, on a
verified Slack signature, gated to an allowlisted team. Acceptable for same-workspace.

**Files:** `migrations/0006_bindings.sql` (new table mirroring connections);
`src/bindings.ts` (`bindingBySlack`/`byProject` become D1-aware seed∪D1; add
`upsertBinding` + `autoCreateBinding`); `.flue/app.ts` (`/slack/events`: on no-binding +
known-team, auto-create then dispatch).

---

## Component 2 — Global skills (shared baseline)

**Goal:** a new channel already knows the house rules (how to use connections, base
personality) without re-teaching each channel.

**Mechanism** (no schema change — skills are already keyed `(project_id, name)`):

```
   reserved project:  "__global__"     (double-underscore can't collide with a
                                         Slack channel id like "C0B6VFM…")
   loadSkillCatalog(channel)  →  WHERE project_id IN ('__global__', <channel>)
                                 channel's own skill WINS on name collision
```

```
   CASCADE
   __global__   shared baseline, all channels inherit   skills only
      ▼ merged, channel overrides by name
   <channel>    own skills + memory + connections
   skills: GLOBAL ∪ channel    memory: channel only    connections: channel only
```

**Boundaries:**
1. **Skills only** cross the global line. Memory and connections never do — that is what
   keeps Tester's facts and tokens private.
2. **Global is live, not copied** — update a `__global__` skill once, every channel sees
   it next turn (leverage over isolation, per the brainstorm choice).
3. **Who writes `__global__`: operator only.** A channel agent can save/archive ITS OWN
   skills (`project_id` = its channel) but can NEVER write `__global__` — otherwise
   Tester's agent could rewrite the baseline every channel runs. `save_skill` stays scoped
   to the calling channel; `__global__` is written only by seed / an admin path.

**Seed, don't build an editor (YAGNI):** seed `__global__` skills via a one-time
script/migration (base `personality` + a `using-connections` how-to). Defer an
admin-edit route for `__global__` until the baseline needs frequent change.

**Files:** `src/skills.ts` (`loadSkillCatalog` / `loadActiveSkillBody` query both
`__global__` and the channel; channel wins on name; save/archive/restore stay
channel-scoped). No migration.

---

## Component 3 — Self-serve connect flow (Nango) + the wall

**UX:**

```
   IN CHANNEL                          OFF CHANNEL (the wall)
   you: @bot connect notion
     → agent calls request_connection(provider)   ← tool returns a LINK, no secret param
     → bot posts "Connect Notion → [Connect Notion]"   ← only a URL crosses into Slack
         └── you click ──▶ Nango hosted consent (their UI), click Allow
                           Nango captures + holds + refreshes token
                           callback → /nango/callback → write connection row
                             {project_id=channel, provider, connection_ref, status=active}
   bot: "✅ Notion connected."  ◀──── (no secret ever touched Slack / D1 / model)
```

**Structural wall (safe by construction, not by discipline):** `request_connection` —
the only connect tool the model can call — takes a provider name (+ optional scope) and
returns a connect URL. **It has no parameter that accepts a secret.** A prompt-injected
agent literally has no tool that can receive or store a raw token. The credential's only
path in is the off-channel consent.

**Two backends, one button (the reserved seam):**
- **OAuth providers** (Notion, Google Ads, Linear…): Nango Connect session → hosted
  consent → `connection_ref` stored. "Nango runs it."
- **API-key-only providers** (no OAuth): same button opens a **one-time secure web form**
  (our route, NOT Slack) → paste key there → `token_ref` secret stored. Still off-channel.

Both write the **same** `connections` row shape from ADR 0003 (`connection_ref` for
Nango, `token_ref` for keys — both columns exist; `resolveConnection` already branches on
which is present). Zero schema change.

**Nango as platform infra (the two secret KINDS):**

```
   PLATFORM-CAPABILITY (operator sets up ONCE, global):
     NANGO_SECRET_KEY      one platform secret (like the LLM / web-search key)
     OAuth app per provider operator registers Notion/Google apps in Nango once
   TENANT-DATA (per channel, the output of each connect):
     connection_ref         scoped per channel; Nango files the token under
                            end_user_id = channel id
```

**Isolation wiring (load-bearing):** `request_connection` for channel `C123` opens the
Nango Connect session with `end_user_id = C123`; `resolveConnection` later fetches
`C123`'s token specifically. The channel id is the isolation boundary end-to-end —
Tester's Notion token and the operator's are never crossed, and there is no shared org
token the agent filters.

**Operator-on-critical-path (honest consequence):** before Tester can connect a provider,
the operator must have registered that provider's OAuth app in Nango once. "Tester can
connect anything" = "anything the operator has pre-registered." A new provider type = one
operator step first; after that, unlimited per-channel self-serve.

**Hard line for this flow:**
```
   AGENT   requests a connection (returns a link)        ✅ model can do
   HUMAN   clicks consent / pastes key off-channel       ✅ verified human
   AGENT   receives / stores / wires a raw credential    ❌ no tool exists
```

**Files:** `src/connections.ts` (`request_connection` tool returning a URL;
`resolveConnection` gains the `connection_ref` → Nango-fetch branch);
`src/nango.ts` (new — `startConnectSession(projectId, provider)` → URL,
`fetchToken(connection_ref)` → live token; ALL Nango code here, behind the broker);
`.flue/app.ts` (`/nango/callback` consent return → write connection row;
`/connect/:token` one-time secure form for API-key providers); env `NANGO_SECRET_KEY`
(one platform secret).

---

## Build order / milestones

**Milestone 1 — Multi-channel agent (Components 1 + 2).** Self-contained, NO vendor
dependency. Bot works in any channel as its own project, inherits global skills, memory
isolated. Connections still operator-provisioned (the existing `/__admin/connections`
route). This alone is a real, testable multi-channel agent — ship and validate it first.

**Milestone 2 — Self-serve connect (Component 3).** Needs a Nango account + per-provider
OAuth app registration. Adds `request_connection`, the Nango backend, the callback, and
the secure form. Layers on top of Milestone 1 without changing it.

Rationale: Milestone 1 proves "useful to a Tester in his own channel" with zero external
dependency and zero new attack surface; Milestone 2 adds the self-serve UX once the
multi-channel foundation is real.

## Security properties

- Credential never touches the Slack channel, `messages` D1, REM, or the model — the only
  connect tool has no secret parameter; capture is off-channel (Nango consent / secure
  form). (Same discipline as `reply_to_conversation`: the model makes requests; the
  trusted layer holds secrets.)
- Per-channel isolation = the `project_id` (channel id) end to end: connections, memory,
  and the Nango `end_user_id` are all scoped to the channel. No shared token filtered by
  the model.
- Auto-binding is gated to an allowlisted team id and to verified Slack signatures —
  "any channel" can never become "any workspace."
- `__global__` skills are operator/seed-written only; a channel agent can write only its
  own channel's skills. The agent edits its own data, never shared infra.
- Nango platform key is a single platform-capability secret, never per-tenant; the
  per-tenant artifact is a non-secret `connection_ref`.

## Open items (resolve during planning, not blockers)

1. **Nango API specifics** — exact Connect-session call shape, `end_user_id` field name,
   token-fetch endpoint, and refresh semantics (verify against current Nango docs at plan
   time; treat training knowledge as stale).
2. **Secure-form route** — the one-time-token mechanism for API-key providers (TTL,
   single-use, where the form posts). Only needed when the first OAuth-less provider lands;
   can be deferred within Milestone 2.
3. **Binding table columns** — confirm the minimal set (project_id, team_id, channel_id,
   transport_token_ref, status, timestamps) mirrors what `bindingBySlack` actually reads.
4. **`__global__` seed contents** — which baseline skills ship (base personality +
   using-connections at minimum).
```
