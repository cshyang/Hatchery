-- Connection METADATA (ADR 0003), in the hatchery-skills D1 db.
-- Apply: npx wrangler d1 execute hatchery-skills --remote --file=migrations/0005_connections.sql
--
-- Why this table exists: a connection's metadata ({provider, token_ref, config}) is NON-SECRET, so
-- it has no business living in bindings.ts where adding one means a code edit + full redeploy (and
-- the token_ref / secret-name must be kept in sync by hand — the exact bug we hit live). Moving it
-- to D1 lets an OPERATOR add a connection with one guarded admin call, no redeploy. The SECRET still
-- lives ONLY as a Worker secret (CF KMS, write-only) referenced by token_ref — it NEVER touches this
-- table, so there is still no ciphertext column and no master key (the v2a model, unchanged).
--
-- Source-of-truth model: bindings.ts `connections` is a CODE SEED (keeps the demo working with no
-- D1 rows); D1 rows are the LIVE source — they add/override by provider, and status='disabled'
-- removes a seeded one. See loadConnectionSpecs in src/connections.ts.
--
-- HARD LINE (unchanged): the AGENT (model) can never write here — prompt-injection wiring infra is
-- the wall. Only the OPERATOR writes, via the /__admin/connections route guarded by its OWN token
-- (ADR D11), out-of-band from the agent.

CREATE TABLE IF NOT EXISTS connections (
  project_id     TEXT    NOT NULL,
  provider       TEXT    NOT NULL,                 -- 'github' | 'notion' | … (from the catalog)
  token_ref      TEXT,                             -- Worker-secret NAME (the operator/static backend); NULL for a managed-OAuth row
  connection_ref TEXT,                             -- RESERVED for the managed-OAuth backend (Nango account ref); NULL today
  config_json    TEXT,                             -- non-secret config, e.g. {"repo":"owner/name","apiMode":"generic"}
  status         TEXT    NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','disabled')),
  created_by     TEXT,                             -- operator id/note (audit; never a secret)
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  -- One account per (project, provider) today — matches v2a. The managed-OAuth MULTI-ACCOUNT future
  -- (one provider, many connected accounts) is a deliberate later migration to a connection_id PK +
  -- external_account_id; reserved by connection_ref above, not built now.
  PRIMARY KEY (project_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_connections_project ON connections(project_id);
