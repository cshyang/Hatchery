-- Agent memory (project + user scoped facts), in the hatchery-skills D1 db.
-- Apply: npx wrangler d1 execute hatchery-skills --remote --file=migrations/0001_memories.sql
--
-- Scopes, all project-isolated:
--   scope='project', subject=''                       → shared, injected every turn
--   scope='user',    subject='slack:<team>:<user>'    → per-person (Slack ids are
--                                                        workspace-scoped, so fully qualify)
--   scope='agent',   subject='<agentSlug>'            → RESERVED (multi-persona future):
--                                                        what one persona knows about its role.
--                                                        Allowed by the CHECK now so adding it
--                                                        later isn't a SQLite table rebuild;
--                                                        nothing writes it yet.
-- created_by/updated_by hold the author's qualified subject (or 'agent' for autonomous
-- writes) so poisoned/off entries are attributable and cleanable.

CREATE TABLE IF NOT EXISTS memories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT    NOT NULL,
  scope       TEXT    NOT NULL CHECK(scope IN ('project', 'user', 'agent')),
  subject     TEXT    NOT NULL,
  fact        TEXT    NOT NULL,
  created_by  TEXT,
  updated_by  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_lookup ON memories(project_id, scope, subject);
