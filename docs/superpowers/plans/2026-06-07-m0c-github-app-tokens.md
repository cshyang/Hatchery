# M0c — GitHub App installation tokens (retire RUNNER_GITHUB_PAT_TEMP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The runner gets its GitHub credential from the project's *connection* (resolved at dispatch like the Linear reply path already is) instead of a single global env PAT — so the credential becomes a short-lived, repo-scoped GitHub **App installation token**, and `RUNNER_GITHUB_PAT_TEMP` dies.

**Architecture:** Hatchery already has a connection broker (`resolveConnection` → Nango `fetchToken`). The Linear reply path uses it; the GitHub dispatch path doesn't (it hardcodes `c.env.RUNNER_GITHUB_PAT_TEMP`). M0c points the dispatch at the broker. **Hatchery writes zero crypto** — Nango holds the App private key and mints/refreshes the installation token; we never JWT-sign anything. The resolver is already auth-mode-agnostic (`connectionProviderConfigKey` returns `config.nangoIntegrationKey ?? provider`), so the dispatch never learns whether the project connected via oauth, pat, or app — it just gets a token string.

**Two facts from reading `dispatch.ts:80–210` that shape the change:**
1. **`githubToken` is never persisted.** The stored `run.dispatchPayload` holds only run metadata; `buildRunnerDispatch` injects `githubToken` + `callback` from `deps` at *send time* (line 114; the comment at 80–84 spells out why — "a stored copy could go stale"). So the token is resolved fresh on *every* dispatch attempt — initial, retry-after-requeue, and continuation all get a new token for free. This means the TTL exposure is only *within a single run's execution*, never across requeues.
2. **One chokepoint.** Both the webhook (immediate) and the reconciler funnel through `claimAndDispatchRun → dispatchClaimedRun → buildRunnerDispatch(run, deps)` (dispatch.ts:174). Resolve the token *once*, in `dispatchClaimedRun` (already async, runs only after the atomic claim wins → no wasted Nango calls on lost CAS races). `buildRunnerDispatch` stays a sync, pure-mapping, sync-testable function.

**Tech Stack:** Cloudflare Worker + Flue + D1; Nango (`auth_mode: GITHUB_APP`); Trigger.dev runner; valibot contract.

---

## Status — SHIPPED ON OAUTH (2026-06-08)

Phase 1 code is **merged (`main` `f773a5b`) and deployed** (Worker `3bf7bbc8`). **Verified in prod:** EDK-1 (project `C0B7B03441X`) ran through the new path → resolved its **OAuth** GitHub connection (`c9074ec0`, push-verified) → PR #14 → completed → "In Review" + "🤖 PR opened" comment, opened as `cshyang`. The runner no longer uses the global `RUNNER_GITHUB_PAT_TEMP`; it resolves the project's connection (PAT remains the fallback). Extra hardening shipped: a broken/dead connectionRef falls back to the PAT instead of failing the dispatch.

**Deviation from plan:** shipped on the existing **OAuth** connection, not the GitHub **App**. The App path (Task 1.4) was abandoned after repeated setup friction — private-app install scope → made public → org install → the Nango connect flow never recorded a connection even after adding the Callback (`https://api.nango.dev/oauth/callback`) + Setup URLs. The `github-app` Nango integration EXISTS; it just has **no recorded connection** yet.

**Still open:**
- **App connect (resume Task 1.4):** get the `github-app` connection to actually record in Nango, then upsert it over the OAuth row for `C0B7B03441X` (`config {nangoIntegrationKey:'github-app'}`). Swaps in with **no redeploy** → bot identity + 1h scoped tokens.
- **Task 1.5 (retire the PAT):** after the App lands (or once comfortable on OAuth). **Rotate `RUNNER_GITHUB_PAT_TEMP` regardless** (shared in chat).
- **Phase 2 (self-serve `request_connection` app mode):** unbuilt.

## Verification findings (load-bearing facts — already confirmed, do not re-litigate)

| Question | Answer | Source |
|---|---|---|
| Does Nango broker GitHub **App** (not just OAuth)? | Yes — `auth_mode: GITHUB_APP`, distinct from `OAUTH2`. "Specifically designed to obtain installation access tokens, acting as the app/bot scoped to specific installations." | Nango `providers.yaml` |
| What does Nango configure on the integration? | `app_id`, `private_key`, `installation_id` (the App's identity — Nango holds the key). | `providers.yaml` |
| **Task 0 — runtime token field?** | `AppCredentials = { type: 'APP', access_token: string, expires_at?: Date, raw, jwtToken? }`. Token is under **`credentials.access_token`** — same field `fetchToken` reads. **`fetchToken` is reused unchanged.** | NangoHQ `runner-sdk/models.d.ts` |
| Who mints/refreshes the 1h token? | Nango ("automatic token refresh"). Hatchery does no signing. | Nango docs |
| Nango's own guidance for clone/push/PR bots? | Use GitHub Apps (installation tokens) over OAuth — bots act independently, persist across user changes, fine-grained perms. | Nango blog |

## ⚠️ Token-TTL risk (must be documented in code, not hand-waved)

Installation tokens live **~1 hour**. The token is minted at **dispatch** (before the Trigger queue), and `git push` / PR-open is the **last** thing the runner does. So the token is *oldest exactly when it's used to write*.

- **Scope of exposure is one run's execution, not the run's whole lifetime.** Because the token is a send-time injection (not persisted — see Architecture fact 1), a run that's requeued and re-dispatched gets a *fresh* token each attempt. So the clock that matters is "token mint → push within this single Trigger execution," not "run created → push."
- **Worst case token-age at push** ≈ Trigger queue wait (post-dispatch) + `maxDuration` (2700s = 45min) ≈ **~48min**. Under 60, but only a ~12min margin.
- **Failure mode:** a long single execution or a queue spike → `401`/`403` on `git push` or the PR API call, late in the run, after pi already did the work.
- **Assumption this plan ships on:** 1h TTL > 45min single-execution, today. **This breaks the moment `maxDuration` rises or the post-dispatch queue backs up.**
- **Deferred mitigation (do NOT build now — YAGNI):** the runner already holds `callback.url` + `callback.token`. On a 401 at push, it can call back to Hatchery for a freshly-minted token (Hatchery re-resolves the connection → new 1h token). Add a `POST /__internal/agent-runs/:id/github-token` endpoint then. Note it in the code comment; don't implement.

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `src/connections/resolve-token.ts` | **New.** DRY the "specs → resolveConnection → await thunk" dance into one helper. | Create |
| `src/connections/resolve-token.test.ts` | Unit tests for the helper. | Create |
| `src/agent-runs/dispatch.ts` | Add `resolveGithubToken` to `RunnerDispatchDeps`; resolve the token (PAT fallback) in `dispatchClaimedRun` post-claim; fix the config guard so a resolver counts as configured. `buildRunnerDispatch` stays sync. | Modify (`RunnerDispatchDeps` ~48-55, `dispatchClaimedRun` ~167-191, `claimAndDispatchRun` guard ~204) |
| `src/agent-runs/dispatch.test.ts` | Cover resolver-used / fallback-to-PAT / neither → requeued; guard counts resolver as configured. | Modify |
| `.flue/app.ts` | Add the same `resolveGithubToken` closure to both `RunnerDispatchDeps` constructions; refactor the Linear reply path onto the `resolveProviderToken` helper. | Modify (~206-214 webhook deps, ~255-258 reply, ~290-297 reconcile deps) |
| `src/connections/integrations.ts` | Add `app: 'github-app'` to GitHub's Nango integration keys + `'app'` to AUTH_MODES. | Modify (~5-14) |
| `src/connections/catalog.ts` | Allow `'app'` auth mode for github. | Modify (~8-12) |
| `src/connections/tools.ts` | `request_connection` accepts `authMode: 'app'` for github. | Modify (~111-153) |

`fetchToken` (`src/providers/nango.ts`) and the `connections` D1 schema (`migrations/0005_connections.sql`) are **unchanged** — the App token rides the existing `(project_id, 'github')` row with `config.nangoIntegrationKey = 'github-app'`.

---

# PHASE 1 — Dispatch resolves the GitHub connection (this is what kills the PAT)

> Phase 1 does **not** need the self-serve connect tool. The one-off install (Task 1.4) mints the `installation_id` via a single manual Connect session / Nango UI and records it through the existing upsert path. The PAT dies at the end of Phase 1.

### Task 1.1: The shared token-resolve helper

**Files:**
- Create: `src/connections/resolve-token.ts`
- Test: `src/connections/resolve-token.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, test, expect } from 'vitest';
import { resolveProviderToken } from './resolve-token';

describe('resolveProviderToken', () => {
  const binding = { connections: [] } as any;

  test('returns a literal (Worker-secret) token', async () => {
    const deps = {
      db: {} as any,
      binding,
      env: { LINEAR_TOKEN: 'lit-123' },
      loadConnectionSpecs: async () => [{ provider: 'linear', tokenRef: 'LINEAR_TOKEN' }],
    };
    expect(await resolveProviderToken(deps, 'linear')).toBe('lit-123');
  });

  test('awaits a Nango thunk token', async () => {
    const deps = {
      db: {} as any,
      binding,
      env: { NANGO_SECRET_KEY: 'sk' },
      loadConnectionSpecs: async () => [{ provider: 'github', connectionRef: 'conn_1', config: { nangoIntegrationKey: 'github-app' } }],
      fetchToken: async () => 'ghs_installation_token',
    };
    expect(await resolveProviderToken(deps, 'github')).toBe('ghs_installation_token');
  });

  test('returns null when no connection for the provider', async () => {
    const deps = { db: {} as any, binding, env: {}, loadConnectionSpecs: async () => [] };
    expect(await resolveProviderToken(deps, 'github')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it, watch it fail**

Run: `npx vitest run src/connections/resolve-token.test.ts`
Expected: FAIL — `resolveProviderToken is not a function`.

- [ ] **Step 3: Implement the helper**

```ts
import { loadConnectionSpecs, resolveConnection } from './repository';
import { fetchToken as defaultFetchToken } from '../providers/nango';

export interface ResolveProviderTokenDeps {
  db: unknown;
  binding: unknown;
  env: Record<string, unknown>;
  // seams for tests; default to the real impls
  loadConnectionSpecs?: typeof loadConnectionSpecs;
  fetchToken?: typeof defaultFetchToken;
}

/**
 * specs → resolveConnection → (literal secret | await Nango thunk) → token | null.
 * Auth-mode-agnostic: oauth, pat, and github-app all return a token string here.
 */
export async function resolveProviderToken(deps: ResolveProviderTokenDeps, provider: string): Promise<string | null> {
  const load = deps.loadConnectionSpecs ?? loadConnectionSpecs;
  const specs = await load(deps.db as any, deps.binding as any);
  const resolved = resolveConnection(specs, deps.env, provider, { fetchToken: deps.fetchToken });
  if (!resolved) return null;
  return typeof resolved.secret === 'string' ? resolved.secret : await resolved.secret();
}
```

- [ ] **Step 4: Run it, watch it pass**

Run: `npx vitest run src/connections/resolve-token.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/connections/resolve-token.ts src/connections/resolve-token.test.ts
git commit -m "feat: shared resolveProviderToken helper (DRY the broker resolve dance)"
```

### Task 1.2: Resolve the per-run GitHub token at the dispatch chokepoint

**Design (grounded in dispatch.ts:167–210):** `buildRunnerDispatch` stays a sync pure-mapping function and is **not** touched. The async resolution wraps it inside `dispatchClaimedRun` (post-claim), and the resolved token is passed via `{...deps, githubToken}`. A new tiny exported helper makes the precedence testable without mocking the Trigger HTTP call.

**Files:**
- Modify: `src/agent-runs/dispatch.ts` (`RunnerDispatchDeps` ~48-55; new `resolveDispatchGithubToken`; `dispatchClaimedRun` ~167-191; `claimAndDispatchRun` guard ~204)
- Test: `src/agent-runs/dispatch.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { resolveDispatchGithubToken } from './dispatch';

const run = makeRun(); // has run.projectId

test('resolver token wins over the PAT fallback', async () => {
  const t = await resolveDispatchGithubToken(run, { githubToken: 'pat', resolveGithubToken: async () => 'ghs_app' } as any);
  expect(t).toBe('ghs_app');
});

test('falls back to the env PAT when the resolver yields null', async () => {
  const t = await resolveDispatchGithubToken(run, { githubToken: 'pat', resolveGithubToken: async () => null } as any);
  expect(t).toBe('pat');
});

test('null when neither a connection token nor a PAT is available', async () => {
  const t = await resolveDispatchGithubToken(run, { resolveGithubToken: async () => null } as any);
  expect(t).toBeNull();
});

test('claimAndDispatchRun treats a resolver as "configured" (does not skip when PAT is absent)', async () => {
  const res = await claimAndDispatchRun(fakeDb, 'run_1', {
    triggerApiUrl: 'x', triggerSecretKey: 'x', runnerToken: 'x', hatcheryPublicUrl: 'x',
    githubToken: undefined, resolveGithubToken: async () => 'ghs_app',
  } as any);
  expect(res.reason).not.toMatch(/not fully configured/);
});
```

- [ ] **Step 2: Run → FAIL**

Run: `npx vitest run src/agent-runs/dispatch.test.ts`
Expected: FAIL — `resolveDispatchGithubToken` undefined; guard test skips on missing `githubToken`.

- [ ] **Step 3: Implement**

In `RunnerDispatchDeps` (~48-55) keep `githubToken?: string` as the **fallback** and add:

```ts
  /** Per-run, freshly-minted GitHub token (App installation token via the connection broker). Preferred over githubToken. */
  resolveGithubToken?: (run: AgentRun) => Promise<string | null>;
```

Add the exported helper (near `buildRunnerDispatch`):

```ts
/** Pick the GitHub token for a dispatch: the per-run connection token, else the transition PAT. */
export async function resolveDispatchGithubToken(run: AgentRun, deps: RunnerDispatchDeps): Promise<string | null> {
  return (await deps.resolveGithubToken?.(run)) ?? deps.githubToken ?? null;
}
```

In `dispatchClaimedRun` (~173), resolve before building and override the token (run stays queued/self-heals if none — mirrors the existing "not configured" behaviour rather than hard-failing a project that simply hasn't connected GitHub yet):

```ts
  const githubToken = await resolveDispatchGithubToken(run, deps);
  if (!githubToken) {
    // No connection token and no PAT — leave queued; self-heals when the project connects a GitHub App.
    await updateAgentRun(db, { id: run.id, status: 'queued', lastDispatchError: `no github credential for project ${run.projectId}` }, clock);
    return { dispatched: false, status: 'queued', reason: 'no github credential' };
  }
  try {
    const { triggerRunId } = await triggerCodingTask(deps, buildRunnerDispatch(run, { ...deps, githubToken }));
    // …unchanged…
```

Fix the config guard in `claimAndDispatchRun` (~204) so a resolver counts as configured:

```ts
  if (!deps.triggerApiUrl || !deps.triggerSecretKey || !deps.runnerToken || !(deps.githubToken || deps.resolveGithubToken) || !deps.hatcheryPublicUrl) {
    return { dispatched: false, status: 'skipped', reason: 'trigger dispatch not fully configured' };
  }
```

> `buildRunnerDispatch` is unchanged — it still reads `deps.githubToken`; we pass the resolved token in via `{ ...deps, githubToken }`. Its existing sync tests stay green.

- [ ] **Step 4: Run → PASS + typecheck**

Run: `npx vitest run src/agent-runs/dispatch.test.ts` → PASS, then `npx tsc --noEmit` → clean (no signature change to `buildRunnerDispatch`, so no call-site churn).

- [ ] **Step 5: Commit**

```bash
git add src/agent-runs/dispatch.ts src/agent-runs/dispatch.test.ts
git commit -m "feat: resolve per-run GitHub token at dispatch chokepoint (App-token ready, PAT fallback)"
```

### Task 1.3: Wire the same resolver into both deps constructions + DRY the Linear path

**Confirmed wiring (no placeholder):** the project→binding function is **`bindingByProject(projectId, db)`** (`src/project/bindings.ts:169`) — seed-then-D1, already used at `app.ts:253` (reply) and `app.ts:132` (scheduled jobs). Both `RunnerDispatchDeps` constructions (`linearDeps` ~206, reconcile ~290) get the **same** per-run resolver closure; resolution itself happens once at the chokepoint (Task 1.2), so `reconcileAgentRuns` needs **no internal change** — it already threads `deps` to `dispatchClaimedRun`.

**Files:**
- Modify: `.flue/app.ts` (~206-214 webhook deps, ~255-258 Linear reply, ~290-297 reconcile deps)

- [ ] **Step 1: Add a shared resolver factory** (DRY — both deps use it). Define once where `c.env` is in scope (e.g. a small module-level helper or inline const in each handler):

```ts
// Per-run GitHub token: look up the run's binding, then resolve its 'github' connection (App token).
const githubTokenResolver = async (run: AgentRun): Promise<string | null> => {
  const binding = await bindingByProject(run.projectId, c.env.DB);
  if (!binding) return null;
  return resolveProviderToken({ db: c.env.DB, binding, env: c.env as Record<string, unknown> }, 'github');
};
```

- [ ] **Step 2: Webhook dispatch deps (~206-214).** Add the resolver; keep the PAT as fallback:

```ts
  const linearDeps = {
    ...,
    githubToken: c.env.RUNNER_GITHUB_PAT_TEMP, // fallback during transition
    resolveGithubToken: githubTokenResolver,
    runnerToken: c.env.AGENT_RUNNER_TOKEN,
    ...
  };
```

- [ ] **Step 3: Reconcile deps (~290-297).** Same two lines — and nothing else, because the token resolves per-run at the chokepoint:

```ts
  const summary = await reconcileAgentRuns(db, {
    ...,
    githubToken: c.env.RUNNER_GITHUB_PAT_TEMP, // fallback
    resolveGithubToken: githubTokenResolver,
    ...
  });
```

- [ ] **Step 4: Refactor the Linear reply path (~255-258) onto the helper (DRY).** It already has `binding` in scope:

```ts
  // was: loadConnectionSpecs + resolveConnection + await-thunk inline
  const token = await resolveProviderToken({ db: c.env.DB, binding, env: c.env as Record<string, unknown> }, 'linear');
  if (!token) return;
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test`
Expected: green. Reply path behaviour unchanged (same broker/token); dispatch now prefers the connection, PAT as fallback.

- [ ] **Step 6: Commit**

```bash
git add .flue/app.ts
git commit -m "feat: dispatch resolves GitHub connection per-run (bindingByProject); DRY reply path"
```

### Task 1.4: One-off install runbook (mint the installation_id) — NOT code, do once

> **⚠️ DEPLOY GATE (verified against prod 2026-06-07):** the code change makes the dispatch prefer a
> project's `github` connection over `RUNNER_GITHUB_PAT_TEMP`. Three prod projects ALREADY have an active
> `github` connection, so on deploy they ALL switch off the PAT simultaneously:
> - `C0B7B03441X` (EDK) → Nango **OAuth** connection `c9074ec0` (`authMode: oauth`) — push to `ecodarklabs/website` **verified true**, but commits would be the OAuth *user*, not a bot.
> - `20168` → Nango connection `fdf34b8a` — push unverified.
> - `demo` → worker-secret PAT `GITHUB_PAT_ECODARK` (repo `ecodarklabs/website`) — push unverified.
>
> So for option (A) the App connection must be recorded for `C0B7B03441X` **before** deploy (step 4
> upserts over the existing OAuth row on `(project_id,'github')`). Do **not** deploy the code until then.

1. **Register a GitHub App** (under the `ecodarklabs` org → Settings → Developer settings → GitHub Apps → New): permissions **Repository → Contents: Read & write** + **Pull requests: Read & write**; **uncheck Webhook → Active** (none needed). Create it, note the **App ID**, then **Generate a private key** (downloads a `.pem`).
2. **Create a Nango integration** (Nango dashboard → Integrations → New): provider **GitHub App**, `auth_mode: GITHUB_APP`; paste the **App ID** + **private key**. Set the integration **Unique Key = `github-app`** (matches Task 2.1's default + step 4's `nangoIntegrationKey`).
3. **Install the App** on `ecodarklabs` with access to **`website`** (GitHub → the App's public page → Install, select the repo). Then create a Nango **connection** for it bound to the EDK project — Nango dashboard "Add connection" (or a manual `startConnectSession` with `integrationId: 'github-app'`, `endUserId: 'C0B7B03441X'`). This yields a **Nango connection id**.
4. **Record the connection over the OAuth row** (this is mine — give me the connection id):
   `upsertConnection(DB, { projectId: 'C0B7B03441X', provider: 'github', connectionRef: '<nango connection id>', config: { nangoIntegrationKey: 'github-app' }, status: 'active' })` — same PK `(C0B7B03441X,'github')`, so it replaces the OAuth `c9074ec0` row. Via the operator route `/__admin/connections` or a direct `wrangler d1 execute` upsert.
5. **Then** deploy (merge branch → `npm run deploy`) and **smoke test:** move EDK-1 → "Run Agent". Confirm the PR author is **`<app-name>[bot]`**, not your user — that proves the App installation token is in use.

### Task 1.5: Retire the PAT

- [ ] After Task 1.4 smoke passes: the `resolveGithubToken` fallback to `RUNNER_GITHUB_PAT_TEMP` is now dead weight for any project with a `github` connection. Leave the fallback in code for one release (rollback safety), then:
  - [ ] Remove `RUNNER_GITHUB_PAT_TEMP` from the Worker secrets (`wrangler secret delete RUNNER_GITHUB_PAT_TEMP`) and from `.dev.vars`.
  - [ ] Drop the `githubToken` fallback field once no project relies on it; `buildRunnerDispatch`'s guard then enforces "must have a connection."
- [ ] **Rotate** the leaked PAT regardless (it was shared in chat).

---

# PHASE 2 — Self-serve GitHub App connect (for tenant #2; does NOT gate Phase 1)

### Task 2.1: Add the `app` auth mode to the integration map

**Files:** Modify `src/connections/integrations.ts` (~5-14)

- [ ] **Step 1: Failing test**

```ts
test('github app integration key', () => {
  expect(nangoIntegrationKey('github', 'app')).toBe('github-app');
});
test('github app is an allowed auth mode', () => {
  expect(AUTH_MODES.github).toContain('app');
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — extend `DEFAULT_KEYS.github` to `{ oauth: 'github', pat: 'github-pat', app: 'github-app' }` and add `'app'` to `AUTH_MODES.github`. Add `'app'` to the `ConnectionAuthMode` union if it's a closed type.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat: register github-app as a connectable auth mode`.

### Task 2.2: `request_connection` accepts `authMode: 'app'`

**Files:** Modify `src/connections/catalog.ts` (~8-12), `src/connections/tools.ts` (~111-153)

- [ ] **Step 1: Failing test** — calling `requestConnectionTool` with `{ provider: 'github', authMode: 'app' }` returns a Connect link locked to integration `github-app`, and the copy says "install the Hatchery GitHub App."
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — allow `'app'` in the github catalog entry's auth modes; in the tool's `authMode` validation accept `'app'`; route it through the same `nangoIntegrationKey(p, mode, ...)` path (no new branch — `startConnectSession` already takes the integration id). Add the install-flavoured copy in `connectionRequestCopy`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat: request_connection supports github app install`.

> No new Nango call shape: `startConnectSession` already posts `allowed_integrations: ['github-app']` + tags. The Connect link drives GitHub's App-install UI (repo selection) instead of OAuth consent. The success-webhook (`app.ts` ~455-461) already upserts the connection — `config.nangoIntegrationKey = 'github-app'` falls out of the existing tag plumbing.

---

## Self-review

- **Spec coverage:** (a) connect-tool change → Phase 2 (2.1, 2.2). (b) dispatch resolves GitHub like Linear → Phase 1 (1.2, 1.3). Verify Nango path → done (findings table). Task 0 credential field → answered (`access_token`, `fetchToken` unchanged).
- **Type consistency:** `resolveProviderToken` signature identical across helper/Linear/GitHub uses; `resolveGithubToken: (run) => Promise<string|null>` consistent in `RunnerDispatchDeps`, the shared `githubTokenResolver`, and `resolveDispatchGithubToken`; integration key `'github-app'` matches between Task 1.4 install and Task 2.1 default.
- **Placeholder scan:** none. The one prior unknown (`bindingForProject`) is resolved to `bindingByProject(projectId, db)` — verified to exist (`src/project/bindings.ts:169`) and already in use.
- **Wiring verified against source (dispatch.ts:80–210):** token is a send-time injection (not persisted) → fresh per attempt; single chokepoint (`dispatchClaimedRun`) → resolve once, `buildRunnerDispatch` untouched; the config guard at `claimAndDispatchRun:204` is the one latent trap that would silently skip all dispatches once the PAT is gone — Task 1.2 fixes it.
- **Risk owned:** token-TTL section states the assumption, the failure mode, and the deferred (not built) mitigation; exposure scoped to one execution (not the run's lifetime).
- **PAT retirement is real in Phase 1** (Task 1.5), not deferred to Phase 2.

## Execution handoff

Plan saved. Two options:
1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks.
2. **Inline** — execute here with checkpoints.

This is a *sketch for review first* — but the wiring is now confirmed against source, so Phase 1 is unblocked: ~3 small commits + a one-off App install. Read it, then pick an execution mode.
