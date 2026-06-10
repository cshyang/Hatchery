-- Slack file authorization ledger.
--
-- The model sees only safe file metadata from the current Slack turn. This table
-- records which file ids were actually attached to a project conversation so
-- workspace_load_slack_file can reject arbitrary Slack file ids before calling
-- Slack files.info with the bot token.

CREATE TABLE IF NOT EXISTS slack_conversation_files (
  project_id      TEXT    NOT NULL,
  conversation_id TEXT    NOT NULL,
  file_id         TEXT    NOT NULL,
  name            TEXT,
  mimetype        TEXT,
  size            INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY(project_id, conversation_id, file_id)
);

CREATE INDEX IF NOT EXISTS idx_slack_conversation_files_project_file
ON slack_conversation_files(project_id, file_id);
