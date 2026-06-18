# Agent Kits Pi Runner Contract

MoreHands owns the control-plane receipt. The external runner owns execution.

## Dispatch

For new coding routes, MoreHands dispatches:

```json
{
  "kit": "coding-default",
  "runtime": "pi",
  "sandboxProvider": "e2b"
}
```

The rest of the runner payload keeps the existing shape: `runId`, project id, Linear issue snapshot,
target repo, base branch, and callback metadata.

## Runner Responsibilities

The runner must:

1. Resolve `agent-kits/<kit>` from this repo or a synchronized copy.
2. Load the markdown agents, skills, and policy into Pi.
3. Run the coding loop in session memory: scout/planner, worker, reviewer/verifier, PR.
4. Clone, edit, test, commit, and open the PR.
5. Call back MoreHands with the existing agent-run callback payload.

## MoreHands Responsibilities

MoreHands records routes, runs, events, notifications, and callback metadata. It does not load Pi,
persist controller topology, run subagents inside the Durable Object, auto-merge PRs, or deploy
production.

Historical `agent_runs.runtime` values are not rewritten. Existing active routes with `opencode`
are treated as legacy setup that should be replaced with a Pi route before new runs are considered
ready.
