-- Channel persona: the Slack display identity (name + emoji icon) the agent posts under.
-- Written by the agent via the set_persona tool at hatch/rewrite time; read by every fresh
-- chat.postMessage (chat.update inherits the identity it was posted with). Requires the
-- Slack app to hold the chat:write.customize scope — without it the post layer falls back
-- to the app's default display name.
CREATE TABLE IF NOT EXISTS personas (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon_emoji TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
