-- Agent self-scheduled reminders, moved in-house from the ticker worker's SchedulerDO
-- (Flue 0.11 hosts its own cron via the cloudflare.ts scheduled handler; the external
-- ticker is retired). Same shape as SchedulerDO's jobs table, now project-scoped in D1
-- so the minutely due-scan reads one central table. Timing precedence and semantics are
-- unchanged: cron (KL wall-clock) > runAt > inMs > everyMs; one-shots delete after fire.
CREATE TABLE reminders (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'heartbeat',
  cron TEXT,
  every_ms INTEGER,
  next_run INTEGER NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX idx_reminders_due ON reminders (enabled, next_run);
