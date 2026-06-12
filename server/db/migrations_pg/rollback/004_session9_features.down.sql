-- Rollback migration 004: dm_messages readAt kaldır
BEGIN;
DROP INDEX IF EXISTS idx_dm_messages_dmid_readat;
ALTER TABLE dm_messages DROP COLUMN IF EXISTS "readAt";
COMMIT;
