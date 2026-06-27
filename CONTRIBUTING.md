# Contributing

MoreHands is early-stage maintainer infrastructure. The best contributions are
small, testable improvements that make it easier for another maintainer to run,
inspect, or trust the system.

## Good first contributions

- Improve setup docs and failure messages.
- Add tests around provider, Slack, Linear, or runner edge cases.
- Turn implicit deployment assumptions into explicit doctor checks.
- Tighten redaction, audit logging, or permission boundaries.
- Add examples for self-hosting a minimal Slack + GitHub deployment.

## Development loop

```bash
npm run typecheck
npm test
npm run build
```

Use `npm run deploy` only when you intend to run the full gate and deploy to a
configured Cloudflare environment.

## Design constraints

- Keep model judgment between deterministic layers.
- Prefer visible audit rows over hidden side effects.
- Do not pass provider tokens, Slack credentials, or Worker secrets into
  sandbox/container/code-mode execution.
- Keep new integrations behind explicit connection state and least-privilege
  scopes.
- Add an ADR under `docs/decisions/` when a change creates a durable
  architecture decision.

## Pull requests

Open a focused PR with:

- What changed.
- Why it matters for maintainers.
- How you verified it.
- Any remaining risk or follow-up work.

For security-sensitive changes, prefer a small repro or failing test first.
