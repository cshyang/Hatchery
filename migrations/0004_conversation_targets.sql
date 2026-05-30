-- Provider-neutral reply targets, in the hatchery-skills D1 db.
-- Apply: npx wrangler d1 execute hatchery-skills --remote --file=migrations/0004_conversation_targets.sql
--
-- Inbound gateways write the exact provider/account/space/thread target before dispatching a turn.
-- The agent only receives Hatchery's stable conversation_id and later calls reply_to_conversation;
-- the tool resolves this table and posts through the provider adapter. This keeps Slack channel ids,
-- Telegram chat ids, and future transport details out of the model-controlled arguments.

CREATE TABLE IF NOT EXISTS conversation_targets (
  project_id               TEXT    NOT NULL,
  agent_slug               TEXT    NOT NULL,
  conversation_id          TEXT    NOT NULL,
  provider                 TEXT    NOT NULL,
  external_account_id      TEXT    NOT NULL,
  external_space_id        TEXT    NOT NULL,
  external_conversation_id TEXT    NOT NULL,
  transport_token_ref      TEXT    NOT NULL,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  PRIMARY KEY (project_id, agent_slug, conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_targets_provider
  ON conversation_targets(provider, external_account_id, external_space_id);
