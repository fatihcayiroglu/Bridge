-- rollback/019_sprint122_channel_bitrate.down.sql
-- Sprint 122: ses kanalı bitrate sütununu geri al.

BEGIN;

ALTER TABLE channels DROP COLUMN IF EXISTS bitrate;

COMMIT;
