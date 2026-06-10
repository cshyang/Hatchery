-- Coordinator Workspace audit ledger.
--
-- The project agent can drive a real per-project sandbox container (shell, filesystem) through
-- workspace tools, but only when every operation is recorded. This table stores bounded
-- metadata/previews only — never Worker secrets, provider tokens, or full file contents.
--
-- `op` already admits the slice-2/3 operations (load_slack_file, send_file) so widening the
-- CHECK later does not force a SQLite table rebuild.

CREATE TABLE IF NOT EXISTS coordinator_workspace_ops (
  id               TEXT    PRIMARY KEY,
  project_id       TEXT    NOT NULL,
  conversation_id  TEXT,
  op               TEXT    NOT NULL CHECK(op IN ('exec','write_file','read_file','load_slack_file','send_file')),
  detail_preview   TEXT    NOT NULL,
  status           TEXT    NOT NULL CHECK(status IN ('running','completed','failed')),
  error            TEXT,
  result_preview   TEXT,
  exit_code        INTEGER,
  bytes_in         INTEGER NOT NULL,
  bytes_out        INTEGER,
  created_at       INTEGER NOT NULL,
  completed_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_coordinator_workspace_ops_project_created
ON coordinator_workspace_ops(project_id, created_at DESC);
