# Runner Contract

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
- Emit a `completed` callback carrying a `summary` of what changed, so Hatchery can post the reply.
