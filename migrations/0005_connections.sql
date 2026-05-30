-- Tool connections (ADR 0003). Per-project external credentials + the human-approval
-- machinery for consequential writes. Mirrors the memories/skills tables in shape
-- (project-scoped, provenance + timestamps). Secret VALUES are ciphertext (src/crypto.ts);
-- plaintext never lands in D1.

-- v2a: one credential per (project, provider). external_account_id is RESERVED for the v3
-- multi-account OAuth future (one provider, many connected accounts) — NULL in v2a.
CREATE TABLE IF NOT EXISTS connections (
  project_id TEXT NOT NULL,
  provider TEXT NOT NULL,                 -- 'github'
  external_account_id TEXT,               -- reserved for v3 multi-account; NULL in v2a
  secret_ciphertext TEXT,                 -- base64(iv || AES-GCM ct); NULL until connected
  fingerprint TEXT,                       -- 'sha256:<prefix>' of plaintext, for display only
  config_json TEXT,                       -- non-secret config, e.g. {"repo":"owner/name"}
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','connected','revoked')),
  created_by TEXT,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, provider)
);

-- A proposed write, parked until a human decides. Only the `id` rides in the Slack button
-- value; args are read back from here at execute time (ADR D10 confused-deputy guard).
CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY,                     -- random; the only thing in the button value
  project_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  action TEXT NOT NULL,                    -- 'create_issue'
  args_json TEXT NOT NULL,                 -- canonical args; rendered in the approval message
  args_hash TEXT NOT NULL,                 -- sha256(canonical args); executor re-checks (D10)
  conversation_id TEXT,                    -- where to post the outcome
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','approved','denied','executed','failed')),
  requested_at INTEGER NOT NULL,
  resolved_by TEXT,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pending_lookup ON pending_actions(project_id, status);

-- "Always approve" memory, SCOPED + BOUNDED (ADR D9) — never a blanket (project,provider,action).
-- constraint_json pins the allowed shape (e.g. {"repo":"owner/name"}); executor re-checks at fire time.
CREATE TABLE IF NOT EXISTS approval_policies (
  project_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  action TEXT NOT NULL,
  constraint_json TEXT NOT NULL,          -- pinned args shape; '{}' is NOT allowed to mean "any"
  max_per_day INTEGER,                    -- optional rate cap; NULL = unlimited
  expires_at INTEGER,                     -- optional TTL; NULL = no expiry (discouraged for writes)
  created_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, provider, action, constraint_json)
);
