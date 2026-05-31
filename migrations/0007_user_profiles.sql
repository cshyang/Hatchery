-- Slack user-name cache (the agent knows people by name, not just opaque id), in hatchery-skills D1.
-- Apply: npx wrangler d1 execute hatchery-skills --remote --file=migrations/0007_user_profiles.sql
--
-- A Slack message event carries only the sender's USER ID, never their name (names change, so Slack
-- resolves them on demand via users.info, which needs the `users:read` scope). The agent's
-- resolve_user tool looks an id up and caches the result here so each person is fetched at most once
-- per TTL. This holds only NON-secret directory metadata (names) — never a token.
--
-- NOT per-project: a workspace user is the same person in every channel, so the cache is keyed by
-- (provider, account, user), shared across all of that workspace's channels. (Memory stays
-- per-channel; this is just a name lookup, not tenant data.)

CREATE TABLE IF NOT EXISTS user_profiles (
  provider            TEXT    NOT NULL DEFAULT 'slack',
  external_account_id TEXT    NOT NULL,            -- Slack team id ('' for a bare-id lookup)
  external_user_id    TEXT    NOT NULL,            -- Slack user id (U…/W…)
  display_name        TEXT,
  real_name           TEXT,
  cached_at           INTEGER NOT NULL,            -- ms; re-resolved after the TTL in src/users.ts
  PRIMARY KEY (provider, external_account_id, external_user_id)
);
