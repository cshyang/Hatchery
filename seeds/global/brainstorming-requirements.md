---
name: brainstorming-requirements
description: Use BEFORE filing issues or assigning coding work whenever someone brings a feature idea, a vague "we should...", or any creative/build request. Requirements dialogue: explore context, one question per message, propose approaches, get explicit design approval, then hand off to writing-coding-issues.
---

# Brainstorming requirements (Slack-native)

Turn a vague idea into an approved design through dialogue, THEN into agent-sized coding issues.
Adapted from obra/superpowers `brainstorming` (MIT, (c) Jesse Vincent); terminal state changed:
the output of design work here is a CODING ISSUE (load `writing-coding-issues`), never a plan doc.

HARD GATE: do NOT create any Linear issue, call assign_coding_run, or start any implementation
until you have presented a design summary and the person explicitly approved it. This applies to
every request regardless of how simple it looks — "simple" ideas hide the most unexamined
assumptions. (A truly simple design summary is 3 sentences; present it anyway.)

## The flow

1. **Explore context FIRST, silently.** Before asking anything: check your memory, search this
   channel for prior discussion, read the relevant repo areas via your GitHub tool. Never ask a
   question the repo or your memory already answers.
2. **Scope check early.** If the ask spans multiple independent subsystems ("chat + billing +
   analytics"), say so immediately and split the conversation: agree on the pieces and their
   order, then brainstorm ONE piece. Do not spend questions refining details of an undecomposed
   blob.
3. **Ask questions ONE PER MESSAGE.** This is Slack — one focused question per message, prefer
   multiple-choice with your suspected answer marked. Focus on purpose, constraints, success
   criteria, and what is explicitly OUT of scope. Stop when you can state all four; do not
   interrogate past understanding.
4. **Propose 2-3 approaches** in one message: each with one-line trade-offs, lead with your
   recommendation and why.
5. **Present the design summary** scaled to complexity (3 sentences to ~200 words): what gets
   built, how it behaves at the boundaries, what is out of scope, how it will be verified.
   Ask for approval.
6. **Self-review before handoff:** any vague requirement or two-ways-interpretable sentence?
   Fix it now — ambiguity here becomes a rejected spec or a wrong PR later.
7. **On approval → load `writing-coding-issues`** and turn the design into one or more
   agent-sized issues per that skill's slicing rules. That skill — not a plan document, not
   immediate implementation — is the ONLY next step.

## Conduct

- One question per message, always. Two questions in one message means the second gets ignored.
- If the person says "just do it" mid-dialogue, compress: state your best-guess design in one
  message and get a yes/no before proceeding to issues.
- If the idea dies under questioning ("whose pain is this?" has no answer), say so plainly —
  a killed bad idea is a successful brainstorm.
