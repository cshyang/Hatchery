# Hatchery

A channel-scoped AI teammate on Cloudflare Workers. Slack is the front door; the agent runs in a
Durable Object (via [Flue](https://flueframework.com)); Linear state transitions can dispatch an
external coding runner; connections are brokered through Nango.

It deploys as **two Workers**:

```
hatchery          the app — Slack/Linear/Nango ingress + the agent DO (Flue)
hatchery-ticker   a plain cron Worker that pokes hatchery on a schedule
                  (Flue's entry drops scheduled(), so the clock lives outside it)
```

Bindings: D1 `hatchery-skills` (DB), KV `SLACK_EVENTS` (idempotency), DOs `Project`/`FlueRegistry`
(hatchery) and `SchedulerDO` (ticker), and a service binding `hatchery ⇄ hatchery-ticker`.

---

## Deploy to a (new) Cloudflare account

The dead-simple path is **fill one file → run one command → follow a 4-item checklist**. The
external SaaS wiring (Slack/Nango/Linear) can't be automated — those need a human in a dashboard —
so the script does the whole Cloudflare side and prints the rest as a checklist with your URL in it.

```bash
wrangler login                          # 1. auth to the TARGET account
cp .env.deploy.example .env.deploy      # 2. fill the one file (see the table below)
$EDITOR .env.deploy
./scripts/setup.sh                      # 3. resources → migrate → deploy → secrets → checklist
# 4. follow the printed checklist (Slack app, Nango/Linear webhooks), then:
./scripts/setup.sh secrets              #    re-push secrets once you have the Slack bot token
```

### Prerequisites

- Node 18+ and `npx`
- `wrangler` (bundled as a devDependency — `npm install` first)
- A Z.ai coding-plan key (the model backend)
- Accounts you intend to connect: Slack (app), and optionally Nango, Linear, your coding runner

### What `./scripts/setup.sh` does

Idempotent and phaseable — run any phase alone, or `full` (the default):

| Phase | Does |
|---|---|
| `resources` | creates D1 + KV if absent, writes their ids into `wrangler.jsonc` (comments preserved) |
| `migrate` | `wrangler d1 migrations apply hatchery-skills --remote` |
| `deploy` | `flue build --target cloudflare` → `wrangler deploy` (hatchery), then deploys the ticker |
| `secrets` | pushes the set values from `.env.deploy` to **both** workers; generates a shared `HEARTBEAT_TOKEN` if blank |

Re-running never double-creates resources or clobbers a secret you didn't change. Phases exist
because of a chicken-and-egg: you need the deployed URL to create the Slack app, but the Slack app's
bot token to finish `secrets`. So: full run → make the Slack app → fill the token → `secrets` again.

---

## Required provisions (reference)

Everything account-specific lives in `.env.deploy` (pushed as Worker secrets) — nothing is in source.
Blank optional values just leave that feature's route inert (404 / "not configured") until set.

| Secret / var | Worker | Required for | Blank ⇒ |
|---|---|---|---|
| `ZAI_API_KEY` | hatchery | core — model turns | agent can't respond |
| `HEARTBEAT_TOKEN` | **both** (must match) | heartbeat + nightly reflection | cron pokes 404 |
| `SLACK_SIGNING_SECRET` | hatchery | Slack ingress | `/slack/events` rejects |
| `SLACK_BOT_TOKEN_DEFAULT` | hatchery | bot posting | bot can't reply |
| `KNOWN_TEAM_IDS` | hatchery | auto-provision allowlist | falls back to original workspace |
| `SLACK_BOT_ID` | hatchery | @mention + autocreate | falls back to original bot id |
| `ADMIN_CONNECTIONS_TOKEN` | hatchery | `/__admin/*` (route activation) | admin routes 404 |
| `NANGO_SECRET_KEY`, `NANGO_WEBHOOK_SECRET` | hatchery | self-serve connections | `/nango/webhook` inert |
| `LINEAR_WEBHOOK_SECRET` | hatchery | Linear agent-run trigger | `/linear/webhook` 404 |
| `AGENT_RUNNER_URL`, `AGENT_RUNNER_TOKEN` | hatchery | runner dispatch + callback | dispatch fails |
| `HATCHERY_PUBLIC_URL` | hatchery | runner callback origin (optional) | uses relative path |
| `WORKBENCH_RUNNER_TOKEN`, `CODING_RUNNER_URL` | hatchery | source-change runner (optional) | feature off |

`SLACK_DEFAULT_TOKEN_REF` (default `SLACK_BOT_TOKEN_DEFAULT`) only changes if you rename the token secret.

### External services (the manual part)

- **Slack** — create an app from [`slack-app.manifest.json`](./slack-app.manifest.json), set the event
  URL to `<worker-url>/slack/events`, install, copy the bot token + bot user id into `.env.deploy`.
- **Nango** — integrations named **exactly** the catalog slugs (`github`, `linear`, `notion`),
  webhook → `<worker-url>/nango/webhook`.
- **Linear** — webhook → `<worker-url>/linear/webhook`, Issue events enabled.
- **Runner** — your external E2B/OpenCode service at `AGENT_RUNNER_URL` (owns clone/edit/test/PR).

### Per-project setup (after deploy)

A channel auto-binds on first @mention (if its team is in `KNOWN_TEAM_IDS`). To wire a Linear
→ agent-run flow: connect GitHub + Linear via Nango, have the agent `propose_agent_route`, then
activate it: `POST /__admin/agent-run-routes/<id>/activate` with the `x-hatchery-admin-token` header.

---

## Day-to-day

```bash
npm run deploy     # gated: tsc --noEmit && npm test && flue build && wrangler deploy (hatchery)
npm test           # full suite (tsx)
npm run typecheck  # tsc --noEmit
```

After adding a migration, `wrangler d1 migrations apply hatchery-skills --remote` (also run by
`./scripts/setup.sh migrate`). The migration history is tracked in the `d1_migrations` table.

## Local dev

Put a throwaway `ZAI_API_KEY` (and any secrets you want to exercise) in `.dev.vars`, then
`npx flue dev --target cloudflare`. Note: model-call failures locally are often local-egress flakiness
— verify model-dependent changes against a deployed Worker, not `flue dev`.
