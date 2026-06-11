---
name: writing-coding-issues
description: How to write a coding issue or assignment contract sized for the autonomous coding harness: one-agent-session slices (NOT small human-sized cards), AC lines as testable assertions, a named verification command. Use after brainstorming-requirements, or directly for any well-understood ask.
---

# Writing coding issues (agent-sized)

You are slicing work for an AUTONOMOUS CODING AGENT, not a human team. The agent ships full
verticals (DB + API + UI + tests) in one session; there are no skill-stack boundaries and no
human coordination cost. Traditional kanban-sized cards are WRONG here — they are sliced for
human attention spans, and filing five of them where one coherent issue would do multiplies
pipeline overhead five-fold.

## Sizing (the one decision that matters)

Ask: **"Can one AI agent plan, implement, verify, and ship this as ONE PR in one session?"**

- Typical right-sized issue: a whole coherent feature, ~2000-5000 lines of additions across all
  layers including tests. Spanning DB + API + UI is FINE when one user-visible outcome confirms
  the whole change end-to-end.
- Too small (under ~500 lines): planning overhead dominates. Merge it with a coupled sibling
  into one bigger issue instead of filing confetti.
- Too big: only when the work genuinely cannot fit one session — independent outcomes with no
  shared acceptance boundary, or slice 2 cannot be designed until slice 1 ships and is observed
  (migration bake time, telemetry-gated rollout). Then file it as ONE umbrella issue and say so
  in the body — the harness decomposes it itself with its own reviewer gate. Do NOT pre-split
  into child issues by hand.

## The contract shape

Title: one imperative sentence ("Add per-channel rate limiting to the reply tool").

Body, in order:
1. **Context** — why this matters and where it lives (2-4 sentences; name files/areas if known).
2. **Outcome** — the one user-visible result that confirms the whole change.
3. **Acceptance criteria** — one TESTABLE assertion per line. "AC: posting twice within 1s
   returns a throttle notice" — not "should handle rate limiting properly".
4. **Verification** — the exact command(s): `npm test`, `bun test src/x.test.ts`.
5. **Non-goals** — what is explicitly out of scope (this is what keeps the slice bounded).

A tight contract with unambiguous goal + ACs + verification takes the harness's express lane
(minutes); anything ambiguous routes through full planning (slower, still fine). Write for the
express lane when the work deserves it.

## Filing and assigning

- Tracked work: create the Linear issue (your Linear tool), then `assign_coding_run` with its
  identifier and the SAME body as description.
- Ad-hoc work: skip Linear entirely — `assign_coding_run` with the contract as description.
- Never assign work whose design was not either approved in conversation
  (brainstorming-requirements) or stated unambiguously by the requester.
