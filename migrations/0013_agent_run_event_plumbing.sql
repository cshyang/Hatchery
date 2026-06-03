-- M1 run receipt plumbing. Hatchery owns the current run receipt, boundary event ledger,
-- outbound notification idempotency, and admin-approved trigger routes.

PRAGMA foreign_keys=off;

CREATE TABLE IF NOT EXISTS agent_runs_m1 (
  id                 TEXT    PRIMARY KEY,
  project_id         TEXT    NOT NULL,
  route_id           TEXT,
  source_type        TEXT    NOT NULL CHECK(source_type IN ('linear','slack','manual','github','internal')),
  source_id          TEXT,
  idempotency_key    TEXT    NOT NULL,
  linear_issue_id    TEXT,
  linear_identifier  TEXT,
  linear_url         TEXT,
  slack_team_id      TEXT,
  slack_channel_id   TEXT,
  slack_thread_ts    TEXT,
  github_owner       TEXT,
  github_repo        TEXT,
  target_repo        TEXT    NOT NULL,
  base_branch        TEXT    NOT NULL DEFAULT 'main',
  kit                TEXT    NOT NULL DEFAULT 'coding-default',
  runtime            TEXT    NOT NULL DEFAULT 'opencode',
  sandbox_provider   TEXT    NOT NULL DEFAULT 'e2b',
  sandbox_id         TEXT,
  status             TEXT    NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','dispatching','running','waiting_human','waiting_approval','completed','failed','cancelled')),
  branch             TEXT,
  commit_sha         TEXT,
  pr_url             TEXT,
  ci_url             TEXT,
  summary            TEXT,
  error              TEXT,
  status_note        TEXT,
  last_event_id      TEXT,
  last_heartbeat_at  INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  completed_at       INTEGER,
  UNIQUE(project_id, idempotency_key)
);

INSERT INTO agent_runs_m1(
  id, project_id, source_type, source_id, idempotency_key, linear_issue_id, linear_identifier,
  linear_url, target_repo, base_branch, kit, runtime, sandbox_provider, sandbox_id, status,
  branch, commit_sha, pr_url, ci_url, summary, error, created_at, updated_at
)
SELECT
  id, project_id, source_type, source_id, idempotency_key, linear_issue_id, linear_identifier,
  linear_url, target_repo, base_branch, kit,
  CASE WHEN runtime='claude_code' THEN 'opencode' ELSE runtime END,
  sandbox_provider, sandbox_id, status, branch, commit_sha, pr_url, ci_url, summary, error,
  created_at, updated_at
FROM agent_runs;

DROP TABLE agent_runs;
ALTER TABLE agent_runs_m1 RENAME TO agent_runs;

PRAGMA foreign_keys=on;

CREATE INDEX IF NOT EXISTS idx_agent_runs_project_status_updated
ON agent_runs(project_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_runs_linear_issue
ON agent_runs(project_id, linear_issue_id);

CREATE INDEX IF NOT EXISTS idx_agent_runs_source
ON agent_runs(project_id, source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_agent_runs_pr
ON agent_runs(project_id, pr_url);

CREATE INDEX IF NOT EXISTS idx_agent_runs_branch
ON agent_runs(project_id, branch);

CREATE INDEX IF NOT EXISTS idx_agent_runs_commit
ON agent_runs(project_id, commit_sha);

CREATE TABLE IF NOT EXISTS agent_run_events (
  id                    TEXT    PRIMARY KEY,
  project_id            TEXT    NOT NULL,
  run_id                TEXT,
  provider              TEXT    NOT NULL CHECK(provider IN ('linear','github','slack','runner','nango','unknown','hatchery')),
  event_type            TEXT    NOT NULL,
  provider_delivery_id  TEXT,
  provider_entity_id    TEXT,
  dedupe_key            TEXT    NOT NULL UNIQUE,
  actor_type            TEXT    NOT NULL DEFAULT 'unknown'
    CHECK(actor_type IN ('human','hatchery','provider_bot','controller','runner','unknown')),
  handling              TEXT    NOT NULL DEFAULT 'record_only'
    CHECK(handling IN ('record_only','notify','wake_controller')),
  handling_reason       TEXT,
  payload_json          TEXT    NOT NULL DEFAULT '{}',
  occurred_at           INTEGER,
  received_at           INTEGER NOT NULL,
  processed_at          INTEGER,
  created_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_run_events_project_created
ON agent_run_events(project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_run_events_run_created
ON agent_run_events(run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_run_events_delivery
ON agent_run_events(provider, provider_delivery_id);

CREATE TABLE IF NOT EXISTS agent_run_notifications (
  id                    TEXT    PRIMARY KEY,
  project_id            TEXT    NOT NULL,
  run_id                TEXT    NOT NULL,
  channel               TEXT    NOT NULL CHECK(channel IN ('slack','linear')),
  notification_type     TEXT    NOT NULL,
  dedupe_key            TEXT    NOT NULL UNIQUE,
  target_ref            TEXT,
  status                TEXT    NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed')),
  provider_message_id   TEXT,
  error                 TEXT,
  created_at            INTEGER NOT NULL,
  sent_at               INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agent_run_notifications_run_created
ON agent_run_notifications(run_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_run_routes (
  id                  TEXT    PRIMARY KEY,
  project_id          TEXT    NOT NULL,
  provider            TEXT    NOT NULL CHECK(provider IN ('linear','github','slack')),
  external_key        TEXT    NOT NULL,
  trigger_type        TEXT    NOT NULL CHECK(trigger_type IN ('state','label','command')),
  trigger_value       TEXT    NOT NULL,
  github_owner        TEXT    NOT NULL,
  github_repo         TEXT    NOT NULL,
  base_branch         TEXT    NOT NULL DEFAULT 'main',
  kit                 TEXT    NOT NULL DEFAULT 'coding-default',
  runtime             TEXT    NOT NULL DEFAULT 'opencode',
  sandbox_provider    TEXT    NOT NULL DEFAULT 'e2b',
  priority            INTEGER NOT NULL DEFAULT 0,
  status              TEXT    NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','disabled')),
  created_by_type     TEXT    NOT NULL DEFAULT 'model' CHECK(created_by_type IN ('model','admin','system')),
  created_by          TEXT,
  reason              TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  activated_by        TEXT,
  activated_at        INTEGER,
  disabled_by         TEXT,
  disabled_at         INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_run_routes_one_active_trigger
ON agent_run_routes(provider, external_key, trigger_type, trigger_value)
WHERE status='active';

CREATE INDEX IF NOT EXISTS idx_agent_run_routes_project_status
ON agent_run_routes(project_id, status, provider);
