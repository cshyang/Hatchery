-- M2: harden agent_runs into a transactional outbox.
--
-- The webhook records a `queued` run; an atomic claim (queued -> dispatching) starts it; a ticker
-- reconciler retries queued/stale runs and times out dead ones. For recovery to work the row must be
-- SELF-CONTAINED — the original Linear issue snapshot lives only in the webhook's memory, so we persist
-- the runner payload here. Without dispatch_payload a reconciler could not re-dispatch a run it didn't
-- originate.

ALTER TABLE agent_runs ADD COLUMN dispatch_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN last_dispatch_error TEXT;
ALTER TABLE agent_runs ADD COLUMN dispatched_at INTEGER;
ALTER TABLE agent_runs ADD COLUMN dispatch_payload TEXT;

-- The reconciler sweeps by status across ALL projects (status-first), so the existing
-- (project_id, status, updated_at) index doesn't serve it. Add a project-agnostic one.
CREATE INDEX IF NOT EXISTS idx_agent_runs_status_updated
ON agent_runs(status, updated_at);
