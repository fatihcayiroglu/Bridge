-- 050_channel_settings_contract.down.sql
ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_slowmode_check;
ALTER TABLE channels DROP COLUMN IF EXISTS "forumTags";
ALTER TABLE channels DROP COLUMN IF EXISTS slowmode;
