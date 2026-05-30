-- Agent-authored skills (the "what"), in the hatchery-skills D1 db.
-- Apply: npx wrangler d1 execute hatchery-skills --remote --file=migrations/0003_skills.sql
--
-- This table had no migration before (src/skills.ts read/wrote it, but nothing created it).
-- Per ADR 0002 there are zero PERSISTED skills, so this creates it fresh with the lifecycle
-- shape from the start. If an old-shape `skills` table somehow exists in a target db, drop it
-- first (it holds nothing) — CREATE IF NOT EXISTS would otherwise no-op and skip the new columns.
--
-- Lifecycle (ADR 0002):
--   state='active'   → in the catalog, loadable, runnable on a schedule
--   state='archived' → hidden from the catalog, NOT loadable, REFUSED by scheduled fire
--                      (archived = retired from automation, not just hidden). Reversible via
--                      restore_skill; re-saving the same name also reactivates it.
-- created_by/updated_by hold the author ('agent' for autonomous writes) for attribution.
-- Keyed by (project_id, name): name is the agent's id for a skill, and reminders + the
-- ON CONFLICT upsert in save_skill both bind to it.

CREATE TABLE IF NOT EXISTS skills (
  project_id  TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL,
  body_md     TEXT    NOT NULL,
  state       TEXT    NOT NULL DEFAULT 'active' CHECK(state IN ('active', 'archived')),
  created_by  TEXT,
  updated_by  TEXT,
  created_at  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  archived_at INTEGER,
  PRIMARY KEY (project_id, name)
);

CREATE INDEX IF NOT EXISTS idx_skills_lookup ON skills(project_id, state);
