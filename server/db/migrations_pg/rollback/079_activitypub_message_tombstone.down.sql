-- 079_activitypub_message_tombstone.down.sql
--
-- Structurally lossless. Data consequence: deletion tombstones are forgotten
-- when the column is dropped. Re-applying 079 restores the schema but cannot
-- reconstruct which remote objects had previously been deleted.
DROP INDEX IF EXISTS idx_ap_messages_live_visibility_actor;
ALTER TABLE ap_messages DROP COLUMN IF EXISTS "deletedAt";
