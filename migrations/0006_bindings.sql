-- Per-channel binding METADATA (Milestone 1), in the hatchery-skills D1 db.
-- Apply: npx wrangler d1 execute hatchery-skills --remote --file=migrations/0006_bindings.sql
--
-- Why: src/bindings.ts was ONE hardcoded literal row (one team, one channel), so the bot
-- ignored every other channel. This table lets the gateway auto-create a binding the first
-- time the bot is @mentioned in a new channel of the KNOWN team — no redeploy, one project
-- per channel. Mirrors the connections D1+seed cascade (migration 0005): the bindings.ts
-- seed is a CODE fallback (keeps the demo working with an empty table); D1 rows are the live
-- source, merged OVER the seed by project_id.
--
-- The bot token is NOT stored here — only its REF (transport_token_ref), a Worker-secret
-- name, exactly like the connections table stores token_ref. The secret stays in CF KMS.
--
-- HARD LINE: rows are written by the GATEWAY on a verified Slack signature for an allowlisted
-- team, or by an operator. The agent (model) never writes here.

CREATE TABLE IF NOT EXISTS bindings (
  project_id          TEXT    NOT NULL,            -- = the Slack channel id (the isolation key)
  provider            TEXT    NOT NULL DEFAULT 'slack',
  external_account_id TEXT    NOT NULL,            -- Slack team id
  external_space_id   TEXT    NOT NULL,            -- Slack channel id (= project_id today)
  transport_bot_id    TEXT    NOT NULL,            -- bot user id, for @mention parsing
  transport_token_ref TEXT    NOT NULL,            -- Worker-secret NAME for the bot token (never the token)
  default_profile     TEXT    NOT NULL DEFAULT 'project-assistant',
  model               TEXT,                        -- optional model pin; NULL → DEFAULT_MODEL
  status              TEXT    NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  created_by          TEXT,                        -- 'gateway-autocreate' | 'admin' | operator note
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (project_id)
);

CREATE INDEX IF NOT EXISTS idx_bindings_slack ON bindings(external_account_id, external_space_id, status);
