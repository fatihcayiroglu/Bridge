-- rollback/024_unified_inbox.down.sql
-- Birleşik gelen kutusu (mention/reply) şemasını geri al.

BEGIN;

DROP INDEX IF EXISTS idx_gdm_members_unread_cursor;
ALTER TABLE group_dm_members DROP COLUMN IF EXISTS "readAt";

DROP INDEX IF EXISTS idx_notifications_inbox_channel;
DROP INDEX IF EXISTS idx_notifications_inbox_unread;
DROP INDEX IF EXISTS idx_notifications_inbox_message;

ALTER TABLE notifications DROP COLUMN IF EXISTS "actorId";
ALTER TABLE notifications DROP COLUMN IF EXISTS "messageId";
ALTER TABLE notifications DROP COLUMN IF EXISTS "channelId";
ALTER TABLE notifications DROP COLUMN IF EXISTS "serverId";

COMMIT;
