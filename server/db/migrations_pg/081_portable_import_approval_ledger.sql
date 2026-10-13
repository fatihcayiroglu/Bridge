-- 081: P7 C4 — durable, one-use portable import consent primitives.
-- No HTTP route or write-capable importer is enabled by this migration.
-- Approval secrets are never stored; only a domain-separated SHA-256 digest.
CREATE TABLE IF NOT EXISTS portable_import_approvals (
  token_hash TEXT PRIMARY KEY
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  target_server_id TEXT NOT NULL REFERENCES servers(_id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  review_fingerprint TEXT NOT NULL
    CHECK (review_fingerprint ~ '^[0-9a-f]{64}$'),
  target_topology_digest TEXT NOT NULL
    CHECK (target_topology_digest ~ '^[0-9a-f]{64}$'),
  source_origin TEXT NOT NULL,
  source_server_id TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL,
  source_key_fingerprint TEXT NOT NULL
    CHECK (source_key_fingerprint ~ '^[0-9a-f]{64}$'),
  structure_digest TEXT NOT NULL
    CHECK (structure_digest ~ '^[0-9a-f]{64}$'),
  permissions_digest TEXT NOT NULL
    CHECK (permissions_digest ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CONSTRAINT portable_import_approval_times_check
    CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '120 seconds'),
  CONSTRAINT portable_import_approval_consumed_check
    CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);
CREATE INDEX IF NOT EXISTS idx_portable_import_approvals_expiry
  ON portable_import_approvals (expires_at);
CREATE INDEX IF NOT EXISTS idx_portable_import_approvals_target
  ON portable_import_approvals (target_server_id, created_at DESC);
