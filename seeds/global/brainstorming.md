---
name: brainstorming
description: Use BEFORE any creative or build work — a feature idea, a vague "we should...", a doc to write, a process to change, a decision to make. Requirements dialogue: explore context, one question per message, propose approaches, get explicit approval, then route to the right executor.
---

# Brainstorming (Slack-native)

Turn a vague idea into an approved design through dialogue, then route it to the right executor.
Adapted from obra/superpowers `brainstorming` (MIT, (c) Jesse Vincent), reshaped for chat.

HARD GATE: do NOT execute — no issue filed, no run assigned, no document written, no config
changed — until you have presented a design/decision summary and the person explicitly approved
it. This applies to every request regardless of how simple it looks — "simple" ideas hide the
most unexamined assumptions. (A truly simple summary is 3 sentences; present it anyway.)

## The flow

1. **Explore context FIRST, silently.** Before asking anything: check your memory, search this
   channel for prior discussion, read the relevant sources with your tools (repo, Linear, docs).
   Never ask a question your tools or memory already answer.
2. **Scope check early.** If the ask spans multiple independent pieces ("chat + billing +
   analytics"), say so immediately: agree on the pieces and their order, then brainstorm ONE.
   Don't spend questions refining details of an undecomposed blob.
3. **Ask questions ONE PER MESSAGE.** This is Slack — one focused question per message, prefer
   multiple-choice with your suspected answer marked. Focus on purpose, constraints, success
   criteria, and what is explicitly OUT of scope. Stop when you can state all four; do not
   interrogate past understanding.
4. **Propose 2-3 approaches** in one message: one-line trade-offs each, lead with your
   recommendation and why.
5. **Present the summary** scaled to complexity (3 sentences to ~200 words): what gets built or
   decided, how it behaves at the boundaries, what is out of scope, how success is verified.
   Ask for approval.
6. **Self-review before handoff:** any vague requirement or two-ways-interpretable sentence?
   Fix it now — ambiguity here becomes wasted execution later.
7. **On approval → route to the executor that fits:**
   - Code that ends in a commit/PR → load `writing-coding-issues`, then file/assign.
   - A document, message, or analysis → produce it directly, in this thread.
   - A process/team decision → state it plainly and `save_memory` the decision + rationale.
   - A capability you don't have → `file-capability-request`.
   The summary is the contract either way; execution never starts from a vaguer version of it.

## Conduct

- One question per message, always. Two questions in one message means the second gets ignored.
- If the person says "just do it" mid-dialogue, compress: state your best-guess summary in one
  message and get a yes/no before executing.
- If the idea dies under questioning ("whose pain is this?" has no answer), say so plainly —
  a killed bad idea is a successful brainstorm.
