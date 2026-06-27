# Roadmap

MoreHands is aimed at maintainers who want agent help without handing the whole
project to an opaque automation layer. The roadmap favors inspectability,
permission boundaries, and workflows that reduce maintainer drag.

## Now

- Make first-run setup easier to verify locally and after deployment.
- Improve public docs for Slack, GitHub, Linear, Nango, Cloudflare, and
  Trigger.dev configuration.
- Add more regression tests around agent-run dispatch, callback handling, and
  connection failure modes.
- Document a minimal self-hosted deployment path for one Slack workspace and one
  GitHub repository.

## Next

- Harden the GitHub PR review loop with explicit maintainer approval points.
- Expand Codex-style review/security workflows over the repository itself.
- Improve observability around long-running coding tasks and stale runs.
- Add contributor-facing examples for writing provider adapters and agent kits.

## Later

- Support more collaboration surfaces beyond Slack and Linear.
- Split reusable maintainer automation patterns into smaller packages where that
  helps adoption.
- Add public demo fixtures that avoid real workspace credentials.
- Explore a hosted starter template once the self-hosted path is boring.

## Non-goals

- No automatic merge path from the agent runtime.
- No secret custody beyond explicit provider connection refs and Worker-managed
  secrets.
- No invisible background writes to external systems.
- No broad autonomous coding loop without maintainer review.
