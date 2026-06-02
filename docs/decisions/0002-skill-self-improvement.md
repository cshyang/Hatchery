# ADR 0002 — Skill Self-Improvement: Lifecycle, Tiers, and REM Curation

**Date**: 2026-05-30
**Status**: accepted
**Supersedes**: nothing
**Related**: `docs/decisions/0001-runtime-and-tenancy.md`, `src/skills/repository.ts`, `src/knowledge/reflection.ts`, `src/knowledge/memory.ts`, `src/agent/prompt.ts`, `src/agent/self.ts`
**Study basis**: a mature open-source agent framework studied as prior art — its background skill-curator, its self-knowledge + skill-authoring bundled skills, and its skill-authoring standards.

## Context

The agent already has the two halves of a skill system: the **what** (`save_skill` / `load_skill` /
`delete_skill` over a D1 `skills` table) and the **when** (`set_reminder` → SchedulerDO, which points
at a skill *by name*). What's missing is the **lifecycle** — the agent deciding to create, refine, and
retire skills — i.e. self-improvement.

We studied a mature agent framework's approach as prior art and decided how much to port given
Hatchery's constraints (Cloudflare Durable Objects + Flue, multi-tenant, data-not-code, ephemeral DO
filesystem, semi-trusted per ADR 0001).

Three facts frame everything below:

- **Zero *persisted* skills in the deployed D1; starter skills exist in the repo.**
  `seeds/seed.mjs` seeds editable project starters such as `writing-skills` and `humanize`; the
  shared `seeds/seed-global.mjs` path seeds platform-owned global skills such as `hatchery`. So
  there's no live library to curate *yet*, but starter content exists — building a heavy curator now
  is still solving a problem we don't have.
- **The `skills` table has no migration.** `src/skills/repository.ts` reads/writes it, but nothing in
  `migrations/` creates it (only memories, messages, and the ticker's `jobs` exist). We owe the
  table regardless — which makes adding lifecycle columns nearly free.
- **REM already exists.** The nightly reflection sweep (ADR-adjacent, see `src/knowledge/reflection.ts`)
  dispatches a consolidation turn into the project's own Durable Object — which already carries the
  full skill toolset. Curation is therefore *instruction*, not new infrastructure.

## The unifying frame

**Skills and memory are the same thing — agent-authored durable knowledge — at different granularity.**
Memory holds *facts*; skills hold *procedures*. They share one two-tier lifecycle, and skill
self-improvement is simply the **second movement of the REM pass we already shipped**:

```
            MEMORY (facts)        SKILLS (procedures)
  LIVE      save_memory           save_skill (+ creation guidance)   ← opportunistic, this turn
  NIGHT     consolidate           mine transcript + curate library   ← REM
  REMOVE    forget                archive (reversible)
```

## Decisions

### 1. Three layers, and a *protected kernel*

```
  KERNEL (code/constants)   the loop · save_memory · the REM mechanism · tool-use rules
                            → NOT agent-editable. Can't go missing, can't be poisoned.
  GLOBAL SKILLS (read-only) platform-authored, shared across projects. self-KNOWLEDGE lives here.
  PROJECT SKILLS (agent RW) what each project's agent grows. self-IMPROVEMENT lives here.
```

The prior-art framework confirms this split: its engine (loop, `save_memory`, curator *mechanism*) is
code; its *self-knowledge* and *meta-authoring* live as **bundled read-only skills**, not kernel.
**Why protected, not "skills all the way down":** letting a
semi-trusted agent rewrite the mechanism that decides what it remembers is a stability-and-poisoning
risk for zero current benefit. Any kernel bit that later earns live-tuning graduates via the
**personality-style override seam** (hardcoded fallback + optional skill override) — the one place
kernel and skill already blend today.

### 2. Global tier via a reserved sentinel, NOT a `scope` column  — DEFERRED (design recorded, zero v1 code)

*This whole decision is future design. It ships no code in v1 (see Build order). It's recorded so that
when the first global skill earns its place, we don't relitigate sentinel-vs-`scope`.*

A global skill is a row with `project_id = '__global__'` (a reserved id we'd forbid as a real binding).
**Why not a `scope` column:** that forces `project_id` to be NULL for global rows, and SQLite treats
NULLs as distinct in a composite key — which silently breaks the `ON CONFLICT(project_id, name)`
upsert `save_skill` relies on. The sentinel keeps one clean rule and the PK keeps working untouched.

- **Precedence:** catalog = project ∪ global; on a name collision, **project shadows global**
  (`('__global__','publish')` and `('acme','publish')` are distinct rows; the project row wins).
- **Reminder binding is late, to the effective NAME — not a row/version.** Reminders store only a
  skill name (`src/reminders.ts`), and fire-time resolves that name to the *currently effective*
  skill (project override wins over global). So a reminder that once ran a global skill will later run
  a project skill of the same name once one exists. This is intended — it's the same late-binding that
  makes skill *edits* apply to future runs — but it is now explicit, not incidental.
- **Isolation is free:** `save_skill` / `archive_skill` close over a real `projectId`, so an agent
  *structurally cannot* write or archive a global skill.
- **Read path stays single-tier** (`WHERE project_id = ?`) until the first global skill exists; the
  two-tier read (`IN (?, '__global__')` + precedence ORDER BY) is a ~2-line additive change made the
  day it's needed — not built blind against zero rows.

### 3. Creation fires in BOTH places (mirror memory)

- **Live:** `save_skill`, with umbrella-building guidance baked into the prompt (mint when reusable;
  write *class-level / broad*, one screenful; extend rather than duplicate). Prevent sprawl at the
  source — cheaper than curing it.
- **Nightly:** REM mines the transcript for a *repeated/emergent* procedure and crystallizes it.
  This is the trigger the live agent structurally can't fire — it has no cross-session behavioral
  memory, but the transcript *is* that behavioral record.

### 4. Removal = soft-archive, never hard-delete — and archived skills DO NOT run

`delete_skill` becomes a reversible `archive_skill` (`state='archived'`) + `restore_skill`. Matches
the prior-art posture: never delete; the maximum destructive action is archive (recoverable).

**Archived means retired from automation, not just hidden from the catalog.** A skill is archived
*because* it's stale or wrong — so continuing to fire it on a schedule is stale automation wearing a
nicer label, not conservatism. (Earlier drafts of this ADR said archived skills should "keep firing"
so reminders never no-op; that was backwards. A stale *fact* is inert; a stale *skill* runs on a
schedule with tools — that's the higher-stakes case, which is the argument for *refusing* it, not
running it.) Concretely:

- **Catalog** hides archived skills (`WHERE state='active'`), as before.
- **`load_skill`** reads active only (`loadActiveSkillBody`) — an archived skill isn't manually
  runnable either.
- **Scheduled fire refuses an archived (or missing) skill with a precise diagnostic** rather than
  silently running stale or silently no-op'ing. The fire path needs its own read that *knows the
  difference* between active / archived / absent (`loadRunnableSkillBody` returning a status, not just
  a body) — not a single `loadSkillBody` that reads any state. The reminder is left intact so the
  agent can `restore_skill` or `cancel_reminder`; auto-pausing referencing reminders is the graduation
  step (Decision 4a) when orphaning actually bites.

**4a. Proactive reminder guarding is deferred** (we have zero reminders pointing at skills today).
Fire-time refuse + diagnostic is the always-correct backstop with zero new coupling. When orphaning
becomes real, graduate to auto-pausing referencing reminders at archive time (wire the TICKER binding
into the archive path, filter jobs by `payload.skill`). Blocking archive while referenced was
considered and rejected — it couples archive to the scheduler and makes a safe op a two-step chore.

### 5. The curator folds into REM — but the REM procedure is REWRITTEN, not appended

The prior art's umbrella-building review prompt is the prize and **ports verbatim** ("a collection of
hundreds of narrow skills, each capturing one session's bug, is a FAILURE of the library"). The
*mechanism* doesn't port: the REM turn already runs inside the project DO with the skill toolset, so
consolidation is instruction, not a forked review agent or a timestamp state machine.

**But "instruction, not infrastructure" understates the prompt work.** The current `REFLECT_PROCEDURE`
(`src/reflection.ts`) explicitly says *only* update memory and *do NOT take any other action* — it
actively forbids skill work. So this is a deliberate **rewrite into a two-part consolidation prompt**,
not another paragraph bolted on:

```
  REM turn (one prompt, two movements):
   1. FACTS     — consolidate durable facts into memory   (save/update/forget_memory)   [today's behavior]
   2. PROCEDURES — mine the transcript for an emergent repeated procedure → save_skill;
                   umbrella-consolidate overlapping skills → fold into the broader, archive absorbed
   …and STILL "do NOT post to the channel" — silence is preserved across both movements.
```

### 5b. Reminder binding semantics are explicit (see Decision 2)

Reminders late-bind to the *currently effective* skill name at fire time, not to a row or version.
This is what makes skill edits apply to future runs — and it means project-shadows-global applies to
reminders too. Stated once here so it isn't rediscovered as a surprise.

### 6. No usage-*score* curation — but keep lifecycle/audit events

The prior art built per-skill `use_count` / `view_count` and then its *own* curator prompt says to
ignore them ("judge on CONTENT, not use_count; use=0 is absence of evidence"). We skip *usage-score-based
curation* — no counters drive archive/merge decisions. **But we keep lifecycle/audit logs**, because
the kill-experiment needs evidence: did `save_skill` fire, did REM create a skill, did `load_skill`
happen, did a scheduled fire hit an archived/missing skill? That's auditability, not curator scoring.
A few `console.log`s on the lifecycle paths (create / archive / restore / fire-refused) are enough —
no telemetry table.

### 7. Global REM proposes; a human blesses

When a cross-project reflector eventually runs, it reads **all** projects' transcripts from the shared
D1 (it's our infra reading our DB — a SaaS provider running analytics, not tenant-reads-tenant),
detects procedures that recur across projects, and **surfaces candidates** for the global tier — it
**never auto-writes global**. "Common" ≠ "correct": a common-but-flawed procedure auto-promoted to
global would *run, on a schedule, with tools, in every project*. Auto-population also destroys the
only property the global tier exists for — that it's *trusted*. Reads are silent and use their **own
cursor** (a reserved `reflection_state` row), never advancing a project's watermark.

## Build order

**Build now — project-only, lifecycle-only (the migration we owe + prompt rewrite):**
1. `migrations/0003_skills.sql` — create `skills`: `state` CHECK(active|archived),
   `created_by`/`updated_by`, `created_at`/`updated_at`/`archived_at`; PK `(project_id, name)`;
   index `(project_id, state)`.
2. `src/skills.ts` — split the read API:
   - `loadActiveSkillBody` → used by `load_skill` (active only).
   - `loadRunnableSkillBody` → used by scheduled fire; returns a *status* (active body | archived |
     absent) so `.flue/app.ts` can refuse with a precise diagnostic instead of running stale or
     silently no-op'ing.
   - `loadSkillCatalog` filters `state='active'`; `delete_skill` → `archive_skill` + `restore_skill`;
     `save_skill` stamps provenance; lifecycle `console.log`s for audit (Decision 6).
3. `.flue/app.ts` — `/__internal/scheduled` uses `loadRunnableSkillBody`; on archived/absent, log a
   clear diagnostic and skip the turn (don't run, don't silently no-op).
4. `src/prompt.ts` — creation guidance with umbrella wisdom in the SKILLS block.
5. `src/reflection.ts` — **rewrite** `REFLECT_PROCEDURE` into the two-movement prompt (facts, then
   procedures: mine emergent / umbrella-consolidate / archive absorbed), preserving "do NOT post".
6. `src/skills.test.ts` (NEW — skills.ts is currently untested): catalog hides archived / `load_skill`
   refuses archived / scheduled fire refuses archived+absent with status / restore un-hides /
   provenance stamped / project isolation / no hard-delete in the toolset.
7. `seeds/seed.mjs` / `seeds/seed-global.mjs` — extend the INSERT to set `state='active'` +
   provenance columns so seeded rows match the new schema.

`.flue/agents/project.ts` needs **no change** — it spreads `skillTools(...)`, so new tools flow through.

**Built now:** the `__global__` sentinel and two-tier read path exist, with platform-authored global
seeds. Global REM, `pinned`, and promotion workflows remain deferred.

## Seeds: what exists, and the drift watch-item

`seeds/seed.mjs` authors **project-level, overwritable, opt-in** starter skills, applied by a manual
`wrangler d1 execute` (not auto-installed): `writing-skills` (meta-authoring) and `humanize`
(writing quality). `seeds/seed-global.mjs` authors the shared platform baseline, including
`hatchery` (self-knowledge), `using-connections`, and `personality`. The earlier "zero skills"
framing was wrong — there is starter *content*; there are just zero *persisted* rows in the live D1.

This is consistent with the decisions above, with one caveat to watch:

- **Project starters stay editable.** They seed into a project's own catalog and the agent can
  edit/archive them. Opt-in project starters are fine; they don't touch the protected kernel.
- **Self-knowledge moved to protected global `hatchery`.** The stale project-level `hatchery-self`
  duplicate was removed because two descriptions of the same runtime surface drift. The global skill
  explains the architecture; the `self_status` tool reports the live capability manifest.

## Verification (the kill-experiment)

Same shape as the memory proof: deploy, run 2–3 realistic sessions with the live guidance and watch
whether `save_skill` *ever* fires. Then fire a REM sweep over a transcript containing a repeated
procedure → confirm it crystallizes one broad skill and stays silent. If live creation never fires
even with guidance, that's hard evidence creation belongs mostly in REM — and we'll have built both
paths anyway. The deeper open question the experiment answers: **do projects even produce
*generalizable* skills?** If agents only ever mint hyper-specific ones ("post X to #Y"), the
cross-project up-flow is moot and earns no code.

## Consequences

**Positive**
- Self-improvement is the second movement of an existing pass, not a new subsystem.
- The table we owed is created correctly the first time, lifecycle included.
- v1 ships nothing speculative: every column has a code path that reads it, every tool maps to a rule.
  The global tier is admitted by the bare `(project_id, name)` PK at zero cost and built only on demand.

**Negative / accepted costs**
- REM doing two jobs (facts + skills) makes the nightly turn's prompt longer; acceptable while batches
  are small, revisit if the consolidation prompt crowds the context window.

## Signals that earn back a deferred piece

- The library sprawls (or N+ skills accumulate) → build the heavier curator beyond the REM prompt pass.
- A skill proves generalizable across 2+ projects → wire the global REM worker + two-tier read path.
- Hatchery's tool/behavior surface outgrows the always-on prompt → graduate self-knowledge into a
  loadable global skill (progressive disclosure).
- A real need to live-tune a kernel behavior without deploy → expose that one bit via the
  personality-style override seam (do NOT open the kernel wholesale).
