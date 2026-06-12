-- Rollback migration 014
ALTER TABLE federation_peers DROP COLUMN IF EXISTS "publicKey";
