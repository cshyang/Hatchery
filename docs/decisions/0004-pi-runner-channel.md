# ADR 0004 — Pi runner channel: CLI default, RPC behind a flag

**Date**: 2026-06-09
**Status**: accepted
**Related**: `docs/decisions/0001-runtime-and-tenancy.md`, `docs/runner-contract.md`, `trigger/run-coding-task.ts`, `trigger/pi-rpc-client.ts`

## Context

The runner drives the `pi` coding agent. Three ways to do that:

- **CLI** — spawn `pi -p --mode json`, one-shot, parse the JSON event stream. Shipped; PRs open in prod.
- **RPC** — spawn `pi --mode rpc`, a long-lived JSONL session over stdin/stdout (`trigger/pi-rpc-client.ts`, hand-rolled so pi is never *imported* — importing it pulls pi's ESM graph into esbuild, the `require(ESM)` crash `trigger.config.ts` already engineers around).
- **SDK** — `import` pi's `AgentSession` in-process.

## Decision

**Default to the CLI. RPC is opt-in behind `MOREHANDS_PI_RUNTIME=rpc`. The SDK is rejected for now.**

- **CLI default** — prod-proven, simplest lifecycle (spawn → it exits → read outcome), minimal coupling (~6 flags). Its one wart — the exit code lies, `pi` exits 0 even when the model call errored — is fixed: the outcome comes from `parsePiStream` / `outcomeFromEvents` (a terminal `agent_end` whose final-turn `stopReason` isn't `"error"`), not the exit code.
- **RPC flagged, not promoted** — it adds live progress streaming, mid-run steer/abort, and a natural home for conversational continuation, but it's a long-lived process you must babysit (child-death detection, pi's SIGTERM-trap, cleanup within `maxDuration`) and is only locally-proven. Adopt it *only* on a forward bet on interactive agents — **not** on tracing/outcomes/robustness, which are parity or CLI-favored (both modes emit the same `AgentEvent` stream).
- **SDK rejected** — reopens the bundling wall and forfeits subprocess crash/OOM isolation, for in-loop capability (client-side tools) we don't need yet.

## Promotion path (do not big-bang)

1. Set `MOREHANDS_PI_RUNTIME=rpc` on a Trigger deploy and run real tasks.
2. Confirm in the **container**, not just locally: lifecycle within `maxDuration`, OOM-mid-stream → clean `failed` (not a hang or zombie pi). Failure logs tag `runtime=rpc` to tell the paths apart.
3. Promote to default only once it's clean — then **delete the CLI path**. Don't carry both indefinitely.

## Consequences

- Two paths exist transiently (`runAgentViaCli` / `runAgentViaRpc` behind `runAgent`); a unified `{ outcome, exitCode, stderr }` keeps the commit/PR flow identical regardless of runtime.
- The RPC bet is justified by interactive features (live progress, steering/HITL, continuation). If those don't materialize, keep the CLI and delete the RPC path rather than maintaining a channel nothing uses.
- `ask-user` is deliberately excluded from the runner in both modes — it blocks on human input and would hang a non-interactive run.
