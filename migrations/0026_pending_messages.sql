-- Burst-absorb parking lot (docs/planning/burst-absorb.md). A message arriving while its
-- conversation's turn is mid-flight parks here instead of dispatching a redundant turn.
-- The in-flight turn's reply drain claims rows as 'absorbed'; the reconcile sweep claims
-- orphans as 'dispatched'. Claimed rows are audit history, never re-delivered.

CREATE TABLE pending_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  text TEXT NOT NULL,
  slack_ts TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | absorbed | dispatched
  created_at INTEGER NOT NULL,
  claimed_at INTEGER
);

CREATE INDEX idx_pending_messages_conv ON pending_messages(project_id, conversation_id, status);
CREATE INDEX idx_pending_messages_sweep ON pending_messages(status, created_at);
