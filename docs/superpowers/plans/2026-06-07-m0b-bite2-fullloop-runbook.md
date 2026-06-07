# M0b Bite 2 — Full-Loop Kill-Test Runbook (deploy Hatchery, keep runner local)

**Goal:** prove the full M0b DoD live: a human moves a Linear issue into **"Run Agent"** → deployed Hatchery dispatches → the **local `trigger dev`** runner clones `ecodarklabs/website`, runs pi/GLM, opens a PR → Hatchery records the run `completed` → a **"🤖 PR opened: <url>"** comment lands on the Linear issue.

**Why this shape:** Bite 1 proved the runner end-to-end, but it runs the task on *your Mac* (pi + git + the kit live there). Deploying the runner to Trigger's cloud needs pi + the kit + the model key *inside the container* — that's the deferred E2B/M0d work. So we deploy **only the control plane** (the CF Worker) and keep the runner on local `trigger dev`, pointing the deployed Worker at the **dev** Trigger environment (the `tr_dev_` key) where `trigger dev` listens. Control plane in the cloud, hands on the laptop.

```
 Linear issue → "Run Agent"        deployed Hatchery (CF Worker, prod)        your Mac
        │  Issue webhook                 │                                         │
        │ ──────────────────────────────▶│ dispatch (REST, tr_dev_ key)            │
        │                                 │ ──────── dev env ──────────────────────▶│ trigger dev
        │                                 │                                  run-coding-task:
        │                                 │                                  clone→pi→PR (pi/git/kit local)
        │                                 │ ◀──── callbacks (to HATCHERY_PUBLIC_URL) ─┤
        │  🤖 "PR opened: <url>"          │  agent_runs → completed                  │
        │ ◀───────────────────────────────│  B4 posts comment (Nango Linear token)   │
```

**Pass = you observe all three:** (1) `trigger dev` terminal shows the task run, (2) a PR appears on `ecodarklabs/website`, (3) a "🤖 PR opened: <url>" comment appears on the Linear issue. (3) is the real finish line — it only fires after the full dispatch→PR→callback→D1→reply chain.

---

## Step 0 — DB migrations on the prod D1 (don't skip)

The deployed Worker's D1 needs the agent-run schema **including `0015_agent_run_trigger_id.sql`** (new on this branch — A1). If the agent-run tables aren't already in prod, you need `0012`–`0015`.

Apply them with your usual mechanism (e.g. `npx wrangler d1 migrations apply <your-db> --remote`). If `trigger_run_id` is missing in prod, every dispatch INSERT/UPDATE will error.

## Step 1 — Deploy the M0b code

From the `codex/agent-run-outbox-fixes` branch (or after merging it to main):
```
npm run deploy   # = predeploy (typecheck + test + build) then wrangler deploy
```
This ships A2 (outbox→Trigger), B4 (Linear reply), and the new `Env` fields.

## Step 2 — Set the Worker secrets

Each via `npx wrangler secret put <NAME>` (prod environment):

| Secret | Value | Notes |
|---|---|---|
| `TRIGGER_SECRET_KEY` | the **`tr_dev_…`** key (same one in `.dev.vars`) | ⚠️ deliberately the **dev** key → routes to the dev env where your local `trigger dev` runs. (Switch to `tr_prod_` only once the runner is deployed to Trigger cloud.) |
| `RUNNER_GITHUB_PAT_TEMP` | the GitHub PAT (has access to `ecodarklabs/website`) | rides the dispatch payload → runner uses it to clone/push/PR |
| `AGENT_RUNNER_TOKEN` | any strong shared secret | Hatchery puts it in the callback + validates the inbound callback against it. Use the value already in `.dev.vars`, or a fresh one. |
| `HATCHERY_PUBLIC_URL` | your deployed Worker origin, e.g. `https://hatchery.<sub>.workers.dev` | the local runner calls back here — must be the public URL |
| `LINEAR_WEBHOOK_SECRET` | a signing secret | must match the secret you set on the Linear webhook (Step 3) |
| `LINEAR_AGENT_PROJECTS` | the JSON below | the route config (env path — no DB needed) |
| `LINEAR_BOT_ACTOR_ID` | Hatchery's Linear actor id | *optional for this manual test* — prevents self-trigger loops if Hatchery ever moves issue states. Not needed for a one-shot human-triggered run. |

`ZAI_API_KEY` is already a Worker secret (your Slack agent uses it). The **runner's** pi reads `ZAI_API_KEY` from your local `.env` (Bite 1 proved this), not the Worker — nothing to do there.

**`LINEAR_AGENT_PROJECTS` value** (replace `<TEAM_KEY>` with your Linear team's key, e.g. the prefix in issue ids like `ECO-123` → `ECO`; and `<your-hatchery-project-id>`):
```json
{
  "<TEAM_KEY>": {
    "projectId": "<your-hatchery-project-id>",
    "targetRepo": "https://github.com/ecodarklabs/website",
    "baseBranch": "main",
    "kit": "coding-default",
    "runtime": "pi",
    "sandboxProvider": "e2b",
    "runStateName": "Run Agent"
  }
}
```
> Note on `sandboxProvider`: set it to `"e2b"` (the value the route layer accepts). The M0 runner **ignores it and always clones locally** — it's aspirational until the E2B milestone. Don't read it as "this runs in E2B."

## Step 3 — Configure the Linear webhook

Linear → Workspace Settings → API → Webhooks → create:
- **URL:** `https://<your-worker>/linear/webhook`
- **Signing secret:** the same value as `LINEAR_WEBHOOK_SECRET` (Step 2)
- **Events:** **Issues** (required). (Comments optional — that's the continuation path, not needed here.)
- **Team:** the team whose key is `<TEAM_KEY>`.

## Step 4 — Confirm Linear can post comments

B4 posts the reply with the project's Linear token via Nango. The token needs the **`comments:create`** (or broad `write`) scope. In Nango, check the live Linear connection's *granted* scopes; if it's read-only, update the integration's scopes and **re-authorize** the connection once (changing dashboard scope does NOT upgrade an already-minted token). If this is missing, the run still succeeds and opens the PR — but the comment **silently no-ops** (B4 is best-effort), so you'd see the PR but no Linear reply.

## Step 5 — Keep the runner local

In a terminal on your Mac, with the current code:
```
npm run trigger:dev
```
Leave it running — it's the executor. It already has pi, git, the kit, and `ZAI_API_KEY` via `.env`.

## Step 6 — Fire it: move an issue into "Run Agent"

1. In the `<TEAM_KEY>` team, ensure a workflow state literally named **`Run Agent`** exists (create one if needed — any column).
2. Open (or make) an issue in that team with a real, small task in the title/description (e.g. *"Add a 'Local dev' section to the README"*).
3. **As yourself (a human), drag/transition the issue INTO the `Run Agent` state from a different state.** That transition is the trigger.

The exact predicate that fires the run: `action: update`, `type: Issue`, current state name == `Run Agent`, the state actually *changed*, and the previous state != `Run Agent`, and the actor is a human (not Hatchery's bot).

## Step 7 — Watch the loop

- **`trigger dev` terminal:** the `run-coding-task` run appears and executes (clone → pi → push).
- **GitHub `ecodarklabs/website`:** a `hatchery/<issue>-<short>` branch + PR appears.
- **Linear issue:** a **🤖 PR opened: <url>** comment lands. ← the finish line.

## Step 8 — Verify + clean up

- Check the PR diff is sane and in-scope (like Bite 1: it should be just the requested change).
- Close the PR + delete the `hatchery/*` branch (ask me — I can do it via the API, or do it in GitHub).
- Optionally move the issue out of `Run Agent`.

---

## Gotchas (the silent skips — if "nothing happened," check these in order)

1. **HMAC / webhook secret mismatch** → webhook returns 404, dropped silently. `LINEAR_WEBHOOK_SECRET` must match Linear's webhook signing secret exactly.
2. **Team key mismatch** → `skipped: no Linear agent project config`. The `<TEAM_KEY>` in `LINEAR_AGENT_PROJECTS` must equal `data.team.key` (or team id) Linear sends.
3. **Not a state transition INTO "Run Agent" from a different state, by a human** → `skipped: not a Run Agent transition`. Re-saving while already in the state, or a bot moving it, won't fire.
4. **Stale delivery (>60s)** → 400. (Rare; only if delivery is delayed/retried.)
5. **The 5 dispatch env vars** — if any of `TRIGGER_SECRET_KEY`, `RUNNER_GITHUB_PAT_TEMP`, `AGENT_RUNNER_TOKEN`, `HATCHERY_PUBLIC_URL`, (+ the Trigger API base) is unset, the run is created `queued` but dispatch is **skipped** (the ticker reconciler retries once they're set — so a missing var = "run sits queued, no Trigger run appears").
6. **An active run already exists for the issue** → `deduped`. Let the prior run reach a terminal state (or it was a leftover) before re-firing; moving the issue back into `Run Agent` is the re-run gesture.
7. **`trigger dev` not running** → the dispatch reaches the dev environment but nothing executes it; the run stalls. Keep it up.
8. **Comment scope missing** (Step 4) → PR opens, no Linear comment. Not a loop failure, just the reply leg.

---

## After it passes

- This proves M0b's DoD end-to-end through the real control plane. The runner still runs on your Mac.
- The next real milestone is making the runner **deployable** (pi + kit + key in the container, i.e. the E2B/M0d direction) so the loop doesn't depend on a local `trigger dev`.
- Rotate `RUNNER_GITHUB_PAT_TEMP` (it was shared in chat) once you're done; M0c replaces it with short-lived GitHub App tokens anyway.
- Decide the branch's fate (merge `codex/agent-run-outbox-fixes` → main, or keep iterating).
