// Channel bindings — the entire "control plane" for the first slice.
//
// Shape deliberately mirrors the future `ChannelBinding` + `Project` records
// (see docs/decisions/0001) so migrating to DO-storage / a real control plane
// is "move each literal into a row", not a model redesign. Bindings are trusted
// config: the agent's allowed channel and credential reference come from HERE,
// never from prompt text or model-supplied arguments.

import type { D1Like } from './skills';

export type SandboxMode = 'virtual' | 'cloudflare-sandbox' | 'daytona' | 'e2b';

/** Default model when a binding doesn't pin one. */
export const DEFAULT_MODEL = 'zai/glm-5.1';

// Models whose context window we've VALIDATED — either present in pi-ai's catalog (Flue resolves
// the window from there, e.g. zai/glm-5.1 → 202800) or registered via registerProvider() in app.ts.
// A model OUTSIDE this set may resolve to an unknown (0) window, which silently disables Flue's
// THRESHOLD compaction and leaves only reactive overflow-recovery (compaction after the provider
// rejects for length — late and lossy). This guard turns that silent cliff into a loud log line.
// Keep it in sync with the models you actually run; when adding an uncatalogued model (e.g. a
// specific OpenRouter id), also register its window via registerProvider so the window is KNOWN.
export const VALIDATED_MODELS: ReadonlySet<string> = new Set([
  'zai/glm-5.1', // catalog contextWindow 202800
  'zai/glm-4.6', // catalog contextWindow 200000
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

// Teams whose channels may be AUTO-PROVISIONED by the gateway on first @mention. This is the wall
// that keeps "any channel" from becoming "any workspace": a stray @mention from an unlisted team is
// never auto-bound. Same-workspace scope (Milestone 1) — multi-workspace OAuth install is deferred.
export const KNOWN_TEAM_IDS: readonly string[] = ['T0B6VB415TQ']; // Ecodark

export function isKnownTeam(teamId: string): boolean {
  return !!teamId && KNOWN_TEAM_IDS.includes(teamId);
}

// Flue DO instance id for a project's agent persona: `project:<projectId>:agent:<slug>`.
// The slug is 'default' today — baked in now because DO instance ids are sticky (renaming
// one makes a NEW DO and orphans its sessions). A channel is the shared room; each persona
// is its own instance inside it. Build + parse go through these two functions so the format
// never drifts across the heartbeat / scheduled / event dispatch sites.
export function agentInstanceId(projectId: string, slug: string = DEFAULT_AGENT_SLUG): string {
  return `project:${projectId}:agent:${slug}`;
}

/** Parse projectId + slug from an instance id. Tolerates the legacy bare `project:<id>`
 *  (no `:agent:` suffix) so any DO created before this change still resolves. */
export function parseAgentInstanceId(id: string): { projectId: string; slug: string } {
  const m = id.match(/^project:(.+):agent:([^:]+)$/);
  if (m) return { projectId: m[1], slug: m[2] };
  const projectId = id.startsWith('project:') ? id.slice('project:'.length) : id;
  return { projectId, slug: DEFAULT_AGENT_SLUG };
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
  /** Model id passed to Flue (e.g. "zai/glm-5.1"). Optional → DEFAULT_MODEL. Per-project so a
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
    model: 'zai/glm-5.1',
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
    status: r.status,
  };
}

/** Live binding rows. Pass a projectId to filter to one; omit for all. Metadata only — never a token. */
export async function loadBindings(db: D1Like, projectId?: string): Promise<BindingRecord[]> {
  const cols =
    'SELECT project_id, external_account_id, external_space_id, transport_bot_id, transport_token_ref, model, status FROM bindings';
  const sql = projectId ? `${cols} WHERE project_id=?` : cols;
  const stmt = projectId ? db.prepare(sql).bind(projectId) : db.prepare(sql).bind();
  const { results } = await stmt.all<{
    project_id: string; external_account_id: string; external_space_id: string;
    transport_bot_id: string; transport_token_ref: string; model: string | null; status: string;
  }>();
  return (results ?? []).map((r) => ({
    projectId: r.project_id,
    provider: 'slack', // schema enforces provider DEFAULT 'slack'; multi-provider is a future schema change
    externalAccountId: r.external_account_id,
    externalSpaceId: r.external_space_id,
    transportBotId: r.transport_bot_id,
    transportTokenRef: r.transport_token_ref,
    model: r.model ?? undefined,
    status: r.status === 'disabled' ? 'disabled' : 'active',
  }));
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
}
