-- Hatchery workbench M0: durable work items, execution attempts, and artifact metadata refs.
-- Apply: npx wrangler d1 execute hatchery-skills --remote --file=migrations/0010_workbench.sql
--
-- This is the internal execution ledger. Linear/Slack/manual events become work_items; runners
-- create work_runs; file ingestion will later attach trusted artifact_refs. The model can update
-- progress through tools, but source metadata and artifact evidence stay backend-owned.

CREATE TABLE IF NOT EXISTS work_items (
  id              TEXT    PRIMARY KEY,
  project_id      TEXT    NOT NULL,
  parent_id       TEXT REFERENCES work_items(id) ON DELETE SET NULL,
  source_type     TEXT    NOT NULL DEFAULT 'internal'
    CHECK(source_type IN ('internal','manual','slack','linear','github')),
  source_id       TEXT,
  dedupe_key      TEXT,
  title           TEXT    NOT NULL,
  body            TEXT,
  status          TEXT    NOT NULL DEFAULT 'requested'
    CHECK(status IN ('requested','queued','claimed','running','waiting_approval','blocked','completed','failed','cancelled')),
  priority        INTEGER NOT NULL DEFAULT 0,
  claimed_by      TEXT,
  session_id      TEXT,
  status_note     TEXT,
  updated_by_type TEXT    NOT NULL DEFAULT 'system'
    CHECK(updated_by_type IN ('gateway','model','system','user')),
  updated_by_id   TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE(project_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_work_items_project_status_updated
ON work_items(project_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_work_items_project_parent
ON work_items(project_id, parent_id);

CREATE INDEX IF NOT EXISTS idx_work_items_project_source
ON work_items(project_id, source_type, source_id);

CREATE TABLE IF NOT EXISTS work_runs (
  id                  TEXT    PRIMARY KEY,
  work_item_id        TEXT    NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  runner              TEXT    NOT NULL CHECK(runner IN ('flue','e2b','trigger')),
  attempt             INTEGER NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','running','completed','failed','cancelled')),
  dispatch_status     TEXT    NOT NULL DEFAULT 'pending'
    CHECK(dispatch_status IN ('not_requested','pending','dispatched','failed')),
  external_run_id     TEXT,
  summary             TEXT,
  error               TEXT,
  dispatch_attempts   INTEGER NOT NULL DEFAULT 0,
  dispatched_at       INTEGER,
  last_dispatch_error TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE(work_item_id, attempt)
);

CREATE INDEX IF NOT EXISTS idx_work_runs_work_item_attempt
ON work_runs(work_item_id, attempt);

CREATE TABLE IF NOT EXISTS artifact_refs (
  id              TEXT    PRIMARY KEY,
  project_id      TEXT    NOT NULL,
  work_item_id    TEXT REFERENCES work_items(id) ON DELETE SET NULL,
  source_provider TEXT    NOT NULL,
  source_id       TEXT,
  filename        TEXT    NOT NULL,
  mime_type       TEXT,
  size_bytes      INTEGER,
  storage_ref     TEXT,
  sha256          TEXT,
  status          TEXT    NOT NULL DEFAULT 'registered'
    CHECK(status IN ('registered','failed')),
  summary         TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artifact_refs_project_work_item
ON artifact_refs(project_id, work_item_id);

CREATE INDEX IF NOT EXISTS idx_artifact_refs_project_source
ON artifact_refs(project_id, source_provider, source_id);

CREATE INDEX IF NOT EXISTS idx_artifact_refs_project_sha
ON artifact_refs(project_id, sha256);
