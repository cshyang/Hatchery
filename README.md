# Hatchery

A channel-scoped AI teammate on Cloudflare Workers. Slack is the front door; the agent runs in a
Durable Object (via [Flue](https://flueframework.com)); Linear state transitions can dispatch an
external Trigger.dev-hosted Pi runner; connections are brokered through Nango.

It deploys as **two Cloudflare Workers plus one Trigger.dev runner**:

```
hatchery          the app — Slack/Linear/Nango ingress + the agent DO (Flue)
hatchery-ticker   a plain cron Worker that pokes hatchery on a schedule
                  (Flue's entry drops scheduled(), so the clock lives outside it)
run-coding-task   a Trigger.dev task that runs Pi + Agent Kits and calls Hatchery back
```

Bindings: D1 `hatchery-skills` (DB), KV `SLACK_EVENTS` (idempotency), DOs `Project`/`FlueRegistry`
(hatchery) and `SchedulerDO` (ticker), and a service binding `hatchery ⇄ hatchery-ticker`.

---

## Deployment

Deployment is no longer README-sized. Use [docs/deployment.md](docs/deployment.md) for:

- Cloudflare Worker + ticker setup.
- Trigger.dev runner deployment.
- Required secrets and dashboard wiring.
- Nango, Slack, Linear, and project route activation.

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
