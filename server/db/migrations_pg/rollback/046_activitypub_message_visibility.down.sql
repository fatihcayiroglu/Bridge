-- rollback/046_activitypub_message_visibility.down.sql
-- Structural rollback for migration 046.
-- Dropping the visibility column restores the pre-046 model, which cannot
-- distinguish direct/private AP notes from public timeline notes.

BEGIN;

DROP INDEX IF EXISTS idx_ap_messages_visibility_actor;
ALTER TABLE ap_messages DROP CONSTRAINT IF EXISTS ap_messages_visibility_check;
ALTER TABLE ap_messages DROP COLUMN IF EXISTS visibility;

COMMIT;
