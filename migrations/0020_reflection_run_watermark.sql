-- Rung one of the reflection ladder: nightly REM also digests the project's run record
-- (agent_runs_m1 terminal rows), not just conversations. This watermark makes each terminal
-- run reflect exactly once — the runs counterpart of last_message_id.
ALTER TABLE reflection_state ADD COLUMN last_run_completed_at INTEGER NOT NULL DEFAULT 0;
