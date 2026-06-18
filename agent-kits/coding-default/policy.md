---
name: coding-default-policy
description: Guardrails for Pi coding runs launched by MoreHands.
---

# Coding Default Policy

MoreHands is the control plane. The external runner is the execution plane.

## Hard Rules

- Do not auto-merge PRs.
- Do not deploy production.
- Do not expose runner tokens, provider tokens, or sandbox secrets.
- Keep controller topology and subagent handoffs inside the runner session.
- Callback MoreHands only with boundary status and artifact metadata.

## Expected Loop

1. Scout and planner establish the smallest safe change.
2. Worker edits, tests, and prepares the patch.
3. Reviewer checks the patch and evidence.
4. Runner opens a PR and calls MoreHands with status, branch, commit, PR, CI, sandbox, summary, or error metadata.
