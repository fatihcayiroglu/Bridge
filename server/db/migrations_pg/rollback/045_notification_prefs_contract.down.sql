-- rollback/045_notification_prefs_contract.down.sql
-- Restore the pre-045 structural contract.
-- WARNING: dropping muteUntil discards mute-expiry values written after 045.
-- This is the conventional schema rollback; production rollback planning must
-- export/retain those values if semantic preservation is required.

BEGIN;

DROP INDEX IF EXISTS idx_notification_prefs_user_channel_unique;
ALTER TABLE notification_prefs DROP CONSTRAINT IF EXISTS notification_prefs_level_check;
ALTER TABLE notification_prefs DROP COLUMN IF EXISTS "muteUntil";

COMMIT;
