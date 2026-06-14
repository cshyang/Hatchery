// Channel bindings — the entire "control plane" for the first slice.
//
// Shape deliberately mirrors the future `ChannelBinding` + `Project` records
// (see docs/decisions/0001) so migrating to DO-storage / a real control plane
// is "move each literal into a row", not a model redesign. Bindings are trusted
// config: the agent's allowed channel and credential reference come from HERE,
// never from prompt text or model-supplied arguments.

import type { D1Like } from '../skills/repository';
import { assignSoul } from './souls';

export type SandboxMode = 'virtual' | 'cloudflare-sandbox' | 'daytona' | 'e2b';

/** Default model when a binding doesn't pin one. Reverted to glm-5.1 on 2026-06-14: deepseek-v4-pro
 *  (default 2026-06-11) went dead-on-arrival in live traffic — every dispatch since the swap produced
 *  no reply (the gateway accepts the message and the turn dies at the model call; Flue posts nothing
 *  on a dead turn, so it reads as silence). glm-5.1 was the proven default before the mimo/deepseek
 *  detour — last-known-good. Routed via OpenRouter (the direct Z.ai provider was dropped in e5f5418). */
export const DEFAULT_MODEL = 'openrouter/z-ai/glm-5.1';

// Models whose context window we've VALIDATED — either present in pi-ai's catalog (Flue resolves
// the window from there, e.g. openrouter/xiaomi/mimo-v2.5-pro → 1048576) or registered via
// registerProvider() in app.ts.
// A model OUTSIDE this set may resolve to an unknown (0) window, which silently disables Flue's
// THRESHOLD compaction and leaves only reactive overflow-recovery (compaction after the provider
// rejects for length — late and lossy). This guard turns that silent cliff into a loud log line.
// Keep it in sync with the models you actually run; when adding an uncatalogued model (e.g. a
// specific OpenRouter id), also register its window via registerProvider so the window is KNOWN.
export const VALIDATED_MODELS: ReadonlySet<string> = new Set([
  // Current default. Was the proven default before the mimo/deepseek detour — clean completions +
  // tool calls through this exact pipeline. OpenRouter ctx ~203K (catalog-resolved).
  'openrouter/z-ai/glm-5.1',
  'openrouter/xiaomi/mimo-v2.5-pro', // catalog contextWindow 1048576
  // Probed live 2026-06-11 (direct OpenRouter calls): plain completions return clean content (no
  // reasoning chunks), tool calls produce valid tool_calls — auxiliary reasoning fields ride
  // ALONGSIDE standard deltas (unlike kimi-k2.6's content:null), which OpenAI-compat parsers
  // ignore. OpenRouter ctx 1048576. Canary-pinned per binding before becoming a default.
  // ⚠️ 2026-06-14: made default 06-11, then produced ZERO replies in live traffic (dead-on-arrival,
  // same symptom as kimi). Window is still valid; left here for reference, but do NOT default it
  // again without a fresh live turn. The 06-11 "probe" was a direct API call, not a real DO turn.
  'openrouter/deepseek/deepseek-v4-pro',
  // ⚠️ kimi-k2.6 REMOVED from the recommended path (2026-06-11): it is a REASONING model —
  // streams reasoning_details chunks with content:null first — and every live turn died before
  // its first beat (dead-on-arrival; verified by direct OpenRouter probe). Do not pin it until
  // the pi-ai/Flue stream pipeline handles reasoning deltas. Window validation alone is NOT
  // model validation: run a live turn before recommending a model here.
]);

// Warn at most once per model id per process — visibility in `wrangler tail` without per-turn spam
// (the initializer resolves the model on every dispatch). Module-level; resets on a cold start.
const warnedUnvalidatedModels = new Set<string>();

/** Resolve the model id for a binding, guarding against models with an unknown context window.
 *  Returns the chosen model — operator intent is RESPECTED, never silently swapped — but an
 *  unvalidated model is flagged loudly so a model swap can't quietly turn off compaction. */
export function resolveModel(model?: string): string {
  const chosen = model ?? DEFAULT_MODEL;
  if (!VALIDATED_MODELS.has(chosen) && !warnedUnvalidatedModels.has(chosen)) {
    warnedUnvalidatedModels.add(chosen);
    console.warn(
      `[model-guard] "${chosen}" is not in VALIDATED_MODELS — its context window may resolve to ` +
        `unknown (0), which disables threshold compaction (leaving only reactive overflow recovery). ` +
        `Add it to VALIDATED_MODELS in bindings.ts, and register its window via registerProvider in ` +
        `app.ts if pi-ai's catalog doesn't know it.`,
    );
  }
  return chosen;
}

/** WRITE-boundary guard: reject pinning a model whose window we can't vouch for, so bad config
 *  never enters D1. Strict (throws) on the way IN; the read path (resolveModel) stays lenient on
 *  the way OUT so an already-stored binding degrades-but-runs. An unpinned model (null/undefined/
 *  empty) is always fine — it resolves to DEFAULT_MODEL at read time. */
export function assertValidModel(model?: string | null): void {
  if (!model) return; // unpinned → DEFAULT_MODEL at read time
  if (!VALIDATED_MODELS.has(model)) {
    throw new Error(
      `[model-guard] refusing to pin unvalidated model "${model}": its context window may resolve ` +
        `to unknown (0), disabling threshold compaction. Add it to VALIDATED_MODELS in bindings.ts ` +
        `(and register its window via registerProvider in app.ts if pi-ai's catalog doesn't know it).`,
    );
  }
}

/** The persona slug used until a project hosts more than one agent. */
export const DEFAULT_AGENT_SLUG = 'default';

// The auto-provision allowlist (which Slack workspaces may auto-create a channel binding) is
// account-coupled config and now lives in src/config/deployment.ts (isKnownTeam), read from env so
// relocating to another workspace is a config change, not a code edit.

// Flue DO instance id for a project's agent persona, scoped per conversation:
// `project:<projectId>:agent:<slug>/<scope>`. On Flue 0.11+ an agent instance IS one
// conversation (named sessions are gone), so the scope that used to be a session name
// (`conv:<conversationId>`, `heartbeat`, `job:<jobId>`, ...) rides in the instance id.
// The scope sits after `/` because scopes contain `:` and slugs never do. DO instance
// ids are sticky — renaming one makes a NEW DO and orphans its history. Build + parse
// go through these two functions so the format never drifts across dispatch sites.
export function agentInstanceId(projectId: string, scope?: string, slug: string = DEFAULT_AGENT_SLUG): string {
  const base = `project:${projectId}:agent:${slug}`;
  return scope ? `${base}/${scope}` : base;
}

/** Parse projectId + slug + scope from an instance id. Tolerates scope-less ids and the
 *  legacy bare `project:<id>` (no `:agent:` suffix) so older callers still resolve. */
export function parseAgentInstanceId(id: string): { projectId: string; slug: string; scope: string | null } {
  const slash = id.indexOf('/');
  const base = slash === -1 ? id : id.slice(0, slash);
  const scope = slash === -1 ? null : id.slice(slash + 1) || null;
  const m = base.match(/^project:(.+):agent:([^:]+)$/);
  if (m) return { projectId: m[1], slug: m[2], scope };
  const projectId = base.startsWith('project:') ? base.slice('project:'.length) : base;
  return { projectId, slug: DEFAULT_AGENT_SLUG, scope };
}

export interface Binding {
  provider: 'slack';
  /** Provider account / workspace (Slack: team id). */
  externalAccountId: string;
  /** The space / room this project is bound to (Slack: channel id). */
  externalSpaceId: string;
  /** The transport's own id, used to detect when it's addressed/participating (Slack: bot user id).
   *  Consumed by provider-specific engagement logic (e.g. Slack @mention parsing). From auth.test. */
  transportBotId: string;
  projectId: string;
  /** Model id passed to Flue (e.g. "openrouter/xiaomi/mimo-v2.5-pro"). Optional → DEFAULT_MODEL. Per-project so a
   *  project can run a different model; the prompt itself is model-agnostic. NOTE: a non-default
   *  model also needs Flue provider routing + creds to actually run — this field is just the seam. */
  model?: string;
  /** No-op today (always 'virtual'); the seam that lets a project graduate to a real sandbox later. */
  sandboxMode: SandboxMode;
  /** Name of the env var / secret holding this transport's token. Tokens never live in code or prompts. */
  transportTokenRef: string;
  /** External tool connections (ADR 0003). Each names the Worker secret holding the provider's
   *  token (like transportTokenRef) + non-secret config (e.g. the pinned repo). The secret is set
   *  with `wrangler secret put`; a connection is "connected" once its secret is present. */
  connections?: ConnectionSpec[];
  /** Overhearing (Layer 4 v2): when true, the agent proactively evaluates every non-trivial
   *  message in this channel and replies (budgeted) when it can genuinely help, without an
   *  @mention. Default false — mention-only. The agent flips this via set_overhearing when asked.
   *  Irrelevant in DMs (always engaged). */
  overhear?: boolean;
  status: 'active' | 'disabled';
}

export interface ConnectionSpec {
  provider: string;
  /** Worker-secret name holding this provider's token (e.g. 'GITHUB_PAT_DEMO'). The operator/static
   *  backend. Optional because a future managed-OAuth row carries connectionRef instead. */
  tokenRef?: string;
  /** RESERVED for the managed-OAuth backend (Nango account ref). Unused until that backend lands —
   *  the forward-compatible hedge so swapping in Nango is a body-swap behind resolveConnection, not
   *  a schema/spec redesign. */
  connectionRef?: string;
  config?: Record<string, unknown>;
}

export const bindings: readonly Binding[] = [
  {
    provider: 'slack',
    externalAccountId: 'T0B6VB415TQ', // Slack workspace/team id (Ecodark)
    externalSpaceId: 'C0B6VFMVCUW', // the bound channel id
    transportBotId: 'U0B6UB2E5HT', // hatch_agent's bot user id (auth.test)
    projectId: 'demo',
    sandboxMode: 'virtual',
    transportTokenRef: 'SLACK_BOT_TOKEN_DEFAULT',
    // GitHub connection (ADR 0003). Shows as "not connected" until the GITHUB_PAT_ECODARK Worker
    // secret is set (`wrangler secret put GITHUB_PAT_ECODARK --name hatchery`). config.repo is the
    // default repo for the read tools when the model omits owner/name.
    // apiMode 'generic' runs the bet-on-intelligence path (Test A): the agent gets ONE
    // <provider>_call_api tool and composes REST calls itself. Drop apiMode (or set 'typed') to
    // revert GitHub to the v2a typed read tools.
    //
    // notion shows "not connected" until `wrangler secret put NOTION_TOKEN_DEMO --name hatchery`
    // is set to a READ-ONLY Notion internal-integration token (shared with the pages/dbs to test).
    // No apiMode needed — notion has no typed tools, so it defaults to the generic call_api tool.
    connections: [
      { provider: 'github', tokenRef: 'GITHUB_PAT_ECODARK', config: { repo: 'ecodarklabs/website', apiMode: 'generic' } },
      { provider: 'notion', tokenRef: 'NOTION_TOKEN_DEMO', config: {} },
    ],
    status: 'active',
  },
];

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

// ── D1 binding layer (per-channel, auto-provisioned) ─────────────────────────────────────────────
// Mirrors the connections D1+seed cascade (src/connections/repository.ts): the bindings.ts `bindings` array is
// a CODE SEED; D1 rows are the live source, merged OVER the seed by project_id. The bot token lives
// as a Worker secret referenced by transport_token_ref — never stored in this table.

export interface BindingRecord {
  projectId: string;
  provider: 'slack';
  externalAccountId: string;
  externalSpaceId: string;
  transportBotId: string;
  transportTokenRef: string;
  model?: string;
  overhear?: boolean;
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
    model: r.model,
    sandboxMode: 'virtual',
    transportTokenRef: r.transportTokenRef,
    // connections come from the D1 connections table (loadConnectionSpecs merges over this seed);
    // an auto-created channel starts with none until an operator/self-serve flow adds them.
    connections: undefined,
    overhear: r.overhear,
    status: r.status,
  };
}

/** Live binding rows. Pass a projectId to filter to one; omit for all. Metadata only — never a token. */
export async function loadBindings(db: D1Like, projectId?: string): Promise<BindingRecord[]> {
  const cols =
    'SELECT project_id, external_account_id, external_space_id, transport_bot_id, transport_token_ref, model, overhear, status FROM bindings';
  const sql = projectId ? `${cols} WHERE project_id=?` : cols;
  const stmt = projectId ? db.prepare(sql).bind(projectId) : db.prepare(sql).bind();
  const { results } = await stmt.all<{
    project_id: string; external_account_id: string; external_space_id: string;
    transport_bot_id: string; transport_token_ref: string; model: string | null; overhear: number | null; status: string;
  }>();
  return (results ?? []).map((r) => ({
    projectId: r.project_id,
    provider: 'slack', // schema enforces provider DEFAULT 'slack'; multi-provider is a future schema change
    externalAccountId: r.external_account_id,
    externalSpaceId: r.external_space_id,
    transportBotId: r.transport_bot_id,
    transportTokenRef: r.transport_token_ref,
    model: r.model ?? undefined,
    overhear: r.overhear === 1,
    status: r.status === 'disabled' ? 'disabled' : 'active',
  }));
}

/** Flip a channel's overhearing mode. The agent calls this (via set_overhearing) when a user asks
 *  it to start/stop chiming in unprompted on a channel — self-service, no redeploy. */
export async function setBindingOverhear(db: D1Like, projectId: string, on: boolean): Promise<void> {
  await db
    .prepare('UPDATE bindings SET overhear=?, updated_at=? WHERE project_id=?')
    .bind(on ? 1 : 0, Date.now(), projectId)
    .run();
}

export interface AutoCreateBindingInput {
  teamId: string;
  channelId: string;
  transportBotId: string;
  transportTokenRef: string;
  model?: string;
  createdBy?: string;
}

/** Insert a per-channel binding row on first @mention. INSERT ... ON CONFLICT(project_id) DO NOTHING —
 *  race-safe: two near-simultaneous @mentions in a new channel create exactly one row. The bot token is
 *  referenced by name, never stored. */
export async function autoCreateBinding(db: D1Like, input: AutoCreateBindingInput): Promise<void> {
  assertValidModel(input.model); // reject a bad model pin before it enters D1 (gateway passes none today)
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO bindings(project_id, provider, external_account_id, external_space_id, transport_bot_id, transport_token_ref, model, status, created_by, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO NOTHING`,
    )
    .bind(
      input.channelId, // project_id = channel id
      'slack',
      input.teamId,
      input.channelId, // external_space_id = channel id
      input.transportBotId,
      input.transportTokenRef,
      input.model ?? null,
      'active',
      input.createdBy ?? 'gateway-autocreate',
      now,
      now,
    )
    .run();
  // Give the fresh channel a soul (random pre-authored persona). Failure-isolated: identity is
  // a nicety; the binding — the agent's ability to function at all — must never ride on it.
  await assignSoul(db, input.channelId).catch((e) =>
    console.log(`[souls] assignment failed for ${input.channelId}: ${e instanceof Error ? e.message : 'error'}`),
  );
}

/** Operator/admin upsert (full update). Distinct from autoCreateBinding (which never overwrites): this
 *  one updates an existing row. Reserved for an admin path; not used by the gateway. */
export async function upsertBinding(db: D1Like, rec: BindingRecord): Promise<void> {
  assertValidModel(rec.model); // reject a bad model pin before it enters D1
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO bindings(project_id, provider, external_account_id, external_space_id, transport_bot_id, transport_token_ref, model, status, created_by, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         external_account_id=excluded.external_account_id,
         external_space_id=excluded.external_space_id,
         transport_bot_id=excluded.transport_bot_id,
         transport_token_ref=excluded.transport_token_ref,
         model=excluded.model,
         status=excluded.status,
         updated_at=excluded.updated_at`,
    )
    .bind(
      rec.projectId, 'slack', rec.externalAccountId, rec.externalSpaceId, rec.transportBotId, rec.transportTokenRef,
      rec.model ?? null, rec.status, 'admin', now, now,
    )
    .run();
  // Same soul-on-provision as autoCreateBinding; assignSoul itself no-ops for a channel that
  // already has an identity, so operator re-upserts never reroll a persona.
  await assignSoul(db, rec.projectId).catch((e) =>
    console.log(`[souls] assignment failed for ${rec.projectId}: ${e instanceof Error ? e.message : 'error'}`),
  );
}
