-- Conversation transcript + the nightly-reflection watermark, in the hatchery-skills D1 db.
-- Apply: npx wrangler d1 execute hatchery-skills --remote --file=migrations/0002_messages.sql
--
-- Why a transcript table at all: Flue exposes NO way to enumerate or read session history
-- from our code (FlueSessions has get/create/delete by name only; the transcript lives behind
-- the internal SessionStore in DO SQL). So reflection can't read Flue sessions — it reads THIS.
-- app.ts logs inbound messages; the reply tool logs the agent's own posts. It's the same
-- author-aware chokepoint Honcho would use later.
--
-- reflection_state.last_message_id is the watermark: the nightly REM sweep consolidates
-- messages with id > watermark, then advances it (server-side, consume-on-take). id (not ts)
-- because the autoincrement is monotonic + unique — exact "what's new since last night".

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      TEXT    NOT NULL,
  conversation_id TEXT    NOT NULL,
  sender_id       TEXT    NOT NULL, -- 'slack:<team>:<user>' for people, 'agent' for the bot
  role            TEXT    NOT NULL CHECK(role IN ('user', 'agent')),
  text            TEXT    NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id, id);

CREATE TABLE IF NOT EXISTS reflection_state (
  project_id        TEXT    PRIMARY KEY,
  last_message_id   INTEGER NOT NULL DEFAULT 0,
  last_reflected_at INTEGER
);
