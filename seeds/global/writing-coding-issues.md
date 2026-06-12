---
name: writing-coding-issues
description: How to write a coding issue or assignment contract sized for the autonomous coding agent: one-agent-session slices (NOT small human-sized cards), AC lines as testable assertions, a named verification command. Use after brainstorming, or directly for any well-understood ask.
---

# Writing coding issues (agent-sized)

You are slicing work for an AUTONOMOUS CODING AGENT, not a human team. The agent ships full
verticals (DB + API + UI + tests) in one session; there are no skill-stack boundaries and no
human coordination cost. Traditional kanban-sized cards are WRONG here — they are sliced for
human attention spans, and filing five of them where one coherent issue would do multiplies
pipeline overhead five-fold.

## Sizing (the one decision that matters)

Ask: **"Can one AI agent plan, implement, verify, and ship this as ONE PR in one session?"**

- Typical right-sized issue: a whole coherent feature across all layers including tests.
  Spanning DB + API + UI is FINE when one user-visible outcome confirms the whole change
  end-to-end.
- Too small: planning overhead dominates. Merge it with a coupled sibling into one bigger
  issue instead of filing confetti.
- Too big: only when the work genuinely cannot fit one session — independent outcomes with no
  shared acceptance boundary, or slice 2 cannot be designed until slice 1 ships and is observed
  (migration bake time, telemetry-gated rollout). Then split it YOURSELF into sequential issues
  with one outcome each, and file only the first; file the next after its predecessor merges.
  The agent runs one issue per session — it does not decompose umbrellas for you.

## The contract shape

Title: one imperative sentence ("Add per-channel rate limiting to the reply tool").

Body, in order:
1. **Context** — why this matters and where it lives (2-4 sentences; name files/areas if known).
2. **Outcome** — the one user-visible result that confirms the whole change.
3. **Acceptance criteria** — one TESTABLE assertion per line. "AC: posting twice within 1s
   returns a throttle notice" — not "should handle rate limiting properly".
4. **Verification** — the exact command(s): `npm test`, `bun test src/x.test.ts`.
5. **Non-goals** — what is explicitly out of scope (this is what keeps the slice bounded).

The agent works alone — there is no reviewer gate between your contract and the PR. The
verification command is the only gate, so every AC must be checkable by it: an ambiguous
contract does not get clarified mid-run, it gets interpreted, and you review the
interpretation as a PR. Spend the precision here, not in the code review after.

## Filing and assigning

- Tracked work: create the Linear issue (your Linear tool), then `assign_coding_run` with its
  identifier and the SAME body as description.
- Ad-hoc work: skip Linear entirely — `assign_coding_run` with the contract as description.
- Never assign work whose design was not either approved in conversation
  (brainstorming) or stated unambiguously by the requester.
