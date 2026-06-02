-- Add the generic coding-runner option to work_runs.runner.
-- SQLite cannot alter a CHECK constraint in place, so rebuild the table and preserve rows.

PRAGMA foreign_keys=off;

DROP TABLE IF EXISTS work_runs_new;

CREATE TABLE IF NOT EXISTS work_runs_new (
  id                  TEXT    PRIMARY KEY,
  work_item_id        TEXT    NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  runner              TEXT    NOT NULL CHECK(runner IN ('flue','e2b','trigger','coding_webhook')),
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

INSERT INTO work_runs_new(
  id, work_item_id, runner, attempt, status, dispatch_status, external_run_id, summary, error,
  dispatch_attempts, dispatched_at, last_dispatch_error, created_at, updated_at
)
SELECT
  id, work_item_id, runner, attempt, status, dispatch_status, external_run_id, summary, error,
  dispatch_attempts, dispatched_at, last_dispatch_error, created_at, updated_at
FROM work_runs;

DROP TABLE work_runs;
ALTER TABLE work_runs_new RENAME TO work_runs;

CREATE INDEX IF NOT EXISTS idx_work_runs_work_item_attempt
ON work_runs(work_item_id, attempt);

PRAGMA foreign_keys=on;
