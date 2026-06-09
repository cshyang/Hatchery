-- Coordinator Dynamic Workers Code Mode audit ledger.
--
-- The project agent can run lightweight JS/Python in Cloudflare Dynamic Workers, but only when
-- every execution is recorded. This table stores bounded metadata/previews only, never Worker
-- secrets, provider tokens, or full external credentials.

CREATE TABLE IF NOT EXISTS coordinator_code_executions (
  id               TEXT    PRIMARY KEY,
  project_id       TEXT    NOT NULL,
  conversation_id  TEXT,
  language         TEXT    NOT NULL CHECK(language IN ('javascript','python')),
  purpose          TEXT    NOT NULL,
  code_hash        TEXT    NOT NULL,
  code_preview     TEXT    NOT NULL,
  network_mode     TEXT    NOT NULL CHECK(network_mode IN ('open_public','off')),
  status           TEXT    NOT NULL CHECK(status IN ('running','completed','failed')),
  error            TEXT,
  result_preview   TEXT,
  code_bytes       INTEGER NOT NULL,
  input_bytes      INTEGER NOT NULL,
  output_bytes     INTEGER,
  cpu_ms           INTEGER NOT NULL,
  subrequests      INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  completed_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_coordinator_code_executions_project_created
ON coordinator_code_executions(project_id, created_at DESC);

