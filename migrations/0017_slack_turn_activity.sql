CREATE TABLE IF NOT EXISTS slack_turn_activity (
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  slack_channel_id TEXT NOT NULL,
  slack_thread_ts TEXT NOT NULL,
  ack_message_ts TEXT NOT NULL,
  transport_token_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'failed')),
  activities_json TEXT NOT NULL,
  last_posted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY(project_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_slack_turn_activity_project_updated
ON slack_turn_activity(project_id, updated_at DESC);
