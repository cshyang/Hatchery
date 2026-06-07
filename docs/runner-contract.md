# Runner Contract

The runner is currently a Trigger.dev task named `run-coding-task`. Hatchery dispatches the task and
stores Trigger's run id as a foreign execution id; Hatchery remains the source of truth for
`agent_runs`.

The runner reports facts through callbacks. It does not mutate Slack, Linear, merge PRs, or deploy
production.

## Initial mode

For a new Linear `Run Agent` issue transition, the runner should:

1. Clone `baseBranch`.
2. Create a deterministic run branch.
3. Run Pi with `agent-kits/coding-default`.
4. Commit, push, and open a PR.
5. Emit `pr_opened` with `branch`, `commitSha`, and `prUrl`.

Do not emit `completed` just because the PR opened. The run is reviewable, not done. Completion
should come from a real terminal signal: failure, PR merge, deploy, or an explicit future policy
decision.

## Continuation mode

When a human leaves feedback on an existing PR (Linear comment now; GitHub PR review later), Hatchery
creates a *continuation* `agent_run` and dispatches it to the runner. The runner's `start` request body
MAY now contain these additional fields (alongside today's fields):

- `mode: "continuation"` — when present, do NOT branch from `baseBranch`.
- `targetBranch: string` — clone THIS branch (the existing PR branch) and push commits back to it
  (this updates the existing PR rather than opening a new one).
- `prUrl: string` — the PR being iterated, for context.
- `feedback: string` — the human's comment; treat it as the task for this turn.
- `replyTarget: { surface: "linear" | "github", ref: string }` — opaque to the runner; echo it back in
  callbacks so Hatchery can route the eventual reply to the surface the comment came from.

Reaffirmed invariants (unchanged, but they matter more here):
- `start(runId)` is IDEMPOTENT — a re-dispatched runId must return the existing sandbox, not start a
  second job.
- Emit `pr_opened` again after pushing continuation commits to the same branch, carrying the PR URL
  and a short summary if available. Hatchery handles the visible reply on the source surface.
