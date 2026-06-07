# Deployment

Hatchery deploys as a small control plane plus a separate coding runner.

```text
hatchery          Cloudflare Worker + Flue Durable Objects
hatchery-ticker   Cloudflare cron Worker that pokes Hatchery
run-coding-task   Trigger.dev task that runs Pi + Agent Kits
```

Hatchery owns routes, run receipts, events, callback auth, and notifications. Trigger.dev hosts the
long-running coding task. The runner reports facts back to Hatchery; it does not own Linear, Slack,
merge, or production deploy authority.

## Prerequisites

- Node `>=22.18`. Flue `0.9.1` rejects older Node versions.
- `npm install`
- Cloudflare account + Wrangler auth.
- Trigger.dev project and secret key.
- Z.ai key for Pi.
- Slack, Nango, Linear, and GitHub access for the workspace you are wiring.

## Cloudflare Setup

The dead-simple path is fill one file, run one command, then wire the external dashboards.

```bash
wrangler login
cp .env.deploy.example .env.deploy
$EDITOR .env.deploy
./scripts/setup.sh
```

`./scripts/setup.sh` is phaseable:

| Phase | Does |
|---|---|
| `resources` | creates D1 + KV if absent, writes ids into `wrangler.jsonc` |
| `migrate` | applies D1 migrations to `hatchery-skills` |
| `deploy` | builds Flue, deploys `hatchery`, then deploys `hatchery-ticker` |
| `secrets` | pushes set values from `.env.deploy` to both Workers |

After you create/install the Slack app, add the Slack bot token to `.env.deploy` and rerun:

```bash
./scripts/setup.sh secrets
```

## Worker Config

Everything account-specific lives in `.env.deploy` and is pushed as Worker secrets or vars.

| Secret / var | Worker | Required for |
|---|---|---|
| `ZAI_API_KEY` | hatchery | model turns inside the Cloudflare agent |
| `HEARTBEAT_TOKEN` | both Cloudflare workers | ticker pokes and reflection |
| `SLACK_SIGNING_SECRET` | hatchery | `/slack/events` verification |
| `SLACK_BOT_TOKEN_DEFAULT` | hatchery | Slack replies |
| `KNOWN_TEAM_IDS` | hatchery | Slack auto-provision allowlist |
| `SLACK_BOT_ID` | hatchery | mention detection and auto-create |
| `ADMIN_CONNECTIONS_TOKEN` | hatchery | guarded admin routes |
| `NANGO_SECRET_KEY` | hatchery | connection sessions and token fetch |
| `NANGO_WEBHOOK_SECRET` | hatchery | `/nango/webhook` verification |
| `LINEAR_WEBHOOK_SECRET` | hatchery | `/linear/webhook` verification |
| `TRIGGER_SECRET_KEY` | hatchery | dispatch to Trigger.dev `run-coding-task` |
| `TRIGGER_API_URL` | hatchery | optional; defaults to `https://api.trigger.dev` |
| `AGENT_RUNNER_TOKEN` | hatchery | runner callback auth |
| `HATCHERY_PUBLIC_URL` | hatchery | public callback origin for Trigger.dev |
| `RUNNER_GITHUB_PAT_TEMP` | hatchery | temporary dogfood GitHub token sent to the runner |
| `WORKBENCH_RUNNER_TOKEN`, `CODING_RUNNER_URL` | hatchery | optional source-change workbench runner |

`RUNNER_GITHUB_PAT_TEMP` is a stopgap. Production should replace it with a GitHub App installation
token minted per repo/run.

## Trigger.dev Runner

The Trigger runner is configured by [trigger.config.ts](../trigger.config.ts). It packages:

- `git`
- `@earendil-works/pi-coding-agent`
- `agent-kits/coding-default`

Deploy it separately from Wrangler:

```bash
npm run trigger:deploy
```

Set Trigger.dev environment variables for the task:

| Secret / var | Required for |
|---|---|
| `ZAI_API_KEY` | Pi model calls inside the Trigger task |
| `KIT_ROOT` | optional override when packaged kit lookup differs |

The GitHub token and Hatchery callback token are sent in the dispatch payload by Hatchery. They do
not need to be standing Trigger.dev secrets.

## Workspace Provider

Current M0 runner code uses a fresh local workspace inside the Trigger.dev task container. That is
acceptable only for dogfood against repos you control.

Use E2B, Vercel Sandbox, or another isolated workspace provider before running arbitrary third-party
repos. Trigger.dev is the task host; it is not the durable source of truth and should not be treated
as the safety boundary for untrusted repo execution.

```text
Git branch       code truth
Hatchery D1      run-state truth
Trigger.dev      long-running task host
Workspace        clone/edit/test filesystem
```

## External Dashboard Wiring

- Slack app event URL: `<worker-url>/slack/events`
- Nango webhook URL: `<worker-url>/nango/webhook`
- Linear webhook URL: `<worker-url>/linear/webhook`

Nango integration ids should use the catalog slugs unless overridden in connection config:

```text
github
github-pat
linear
notion
```

Linear should enable Issue events for `Run Agent` transitions. Comment events are needed for
continuation runs.

## Project Setup

After deploy:

1. Mention the bot in a Slack channel so the project/channel binding is created.
2. Ask the bot for setup status.
3. Connect GitHub and Linear through Nango from Slack.
4. Create a pending Linear route with `propose_agent_route`.
5. Activate it through the guarded admin route:

```bash
curl -X POST \
  -H "x-hatchery-admin-token: $ADMIN_CONNECTIONS_TOKEN" \
  "$HATCHERY_PUBLIC_URL/__admin/agent-run-routes/<route-id>/activate"
```

Then move a Linear issue into the configured `Run Agent` state. The expected loop is:

```text
Linear state transition
  -> Hatchery agent_run + event receipt
  -> Trigger.dev run-coding-task
  -> Pi edits repo and opens/updates PR
  -> Hatchery callback
  -> Linear comment from Hatchery
```

The runner should report `pr_opened` when the PR is ready for review. Completion should come from a
real terminal signal such as PR merge, deploy, failure, or an explicit future policy decision.
