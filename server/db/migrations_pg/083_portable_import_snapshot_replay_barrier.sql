-- 083: P7 C4 durable per-destination source snapshot replay barrier.
-- Never mistake one-use approval-token CAS for one-use source snapshot.
-- Unique constraint is the atomic cross-worker arbiter on the SAME PG client
-- as the approval claim, mapped metadata writes and redacted audit.
CREATE TABLE IF NOT EXISTS portable_import_snapshot_consumptions (
  target_server_id TEXT NOT NULL REFERENCES servers(_id) ON DELETE CASCADE,
  source_origin TEXT NOT NULL
    CHECK (length(source_origin) BETWEEN 9 AND 512),
  source_server_id TEXT NOT NULL
    CHECK (length(source_server_id) BETWEEN 1 AND 256),
  source_snapshot_id TEXT NOT NULL
    CHECK (source_snapshot_id ~ '^[A-Za-z0-9_-]{16,128}$'),
  source_key_fingerprint TEXT NOT NULL
    CHECK (source_key_fingerprint ~ '^[0-9a-f]{64}$'),
  structure_digest TEXT NOT NULL
    CHECK (structure_digest ~ '^[0-9a-f]{64}$'),
  permissions_digest TEXT NOT NULL
    CHECK (permissions_digest ~ '^[0-9a-f]{64}$'),
  committed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (target_server_id, source_origin, source_server_id, source_snapshot_id)
);
CREATE INDEX IF NOT EXISTS idx_portable_snapshot_consumptions_committed_at
  ON portable_import_snapshot_consumptions (committed_at);
