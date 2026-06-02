-- Linear-driven coding-agent leases. Hatchery owns intake, idempotency, dispatch metadata,
-- and runner callbacks; the external runner owns clone/edit/test/commit/PR behavior.

CREATE TABLE IF NOT EXISTS agent_runs (
  id                 TEXT    PRIMARY KEY,
  project_id         TEXT    NOT NULL,
  source_type        TEXT    NOT NULL CHECK(source_type IN ('linear','slack','manual','github','internal')),
  source_id          TEXT,
  idempotency_key    TEXT    NOT NULL,
  linear_issue_id    TEXT,
  linear_identifier  TEXT,
  linear_url         TEXT,
  target_repo        TEXT    NOT NULL,
  base_branch        TEXT    NOT NULL DEFAULT 'main',
  kit                TEXT    NOT NULL DEFAULT 'coding-default',
  runtime            TEXT    NOT NULL DEFAULT 'claude_code',
  sandbox_provider   TEXT    NOT NULL DEFAULT 'e2b',
  sandbox_id         TEXT,
  status             TEXT    NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','dispatching','running','waiting_approval','completed','failed','cancelled')),
  branch             TEXT,
  commit_sha         TEXT,
  pr_url             TEXT,
  ci_url             TEXT,
  summary            TEXT,
  error              TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE(project_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_project_status_updated
ON agent_runs(project_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_runs_linear_issue
ON agent_runs(project_id, linear_issue_id);

CREATE INDEX IF NOT EXISTS idx_agent_runs_source
ON agent_runs(project_id, source_type, source_id);
