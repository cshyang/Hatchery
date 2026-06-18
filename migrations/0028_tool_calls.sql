-- Tool-call audit log, in the hatchery-skills D1 db.
-- Apply: npx wrangler d1 execute hatchery-skills --remote --file=migrations/0028_tool_calls.sql
--
-- One row per outbound provider call (generic <provider>_call_api + typed GitHub reads): the call's
-- SHAPE — provider, method, query-stripped path, outcome, duration — NEVER the payload. Bodies carry
-- user content and query strings carry search terms; keeping both out is what makes this table safe
-- to retain indefinitely and cheap to query.
--
-- Why it exists (in priority order):
--   1. Debugging — "did that call actually fire, and did it succeed?" The model's own narration is
--      the one witness you can't trust.
--   2. Forensics — a prompt injection that survives the method fence shows up here as an anomalous
--      pattern; 'blocked' rows are attempted-write probes caught by methodPolicy.
--   3. Policy input — future per-endpoint path rules get written FROM observed traffic in this
--      table, not guessed from provider docs.
--
-- Writes are fire-and-forget from the tool execute path (src/connections/audit.ts): a dead D1 must
-- never fail an agent turn, so insert errors are swallowed.

CREATE TABLE IF NOT EXISTS tool_calls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT    NOT NULL,
  provider    TEXT    NOT NULL,                 -- 'github' | 'notion' | 'tavily' | … (catalog or dynamic)
  method      TEXT    NOT NULL,                 -- HTTP verb as attempted (blocked rows keep the refused verb)
  path        TEXT    NOT NULL,                 -- API path, query string stripped before write
  status      TEXT    NOT NULL
    CHECK(status IN ('success','http_error','fetch_error','blocked')),
  duration_ms INTEGER NOT NULL,                 -- 0 for blocked (refused before any fetch)
  created_at  INTEGER NOT NULL                  -- epoch ms
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_project_created ON tool_calls(project_id, created_at);
