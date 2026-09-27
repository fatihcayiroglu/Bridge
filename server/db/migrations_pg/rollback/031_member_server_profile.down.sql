-- Rollback migration 031: remove per-server member profile storage.
ALTER TABLE members DROP COLUMN IF EXISTS "serverProfile";
