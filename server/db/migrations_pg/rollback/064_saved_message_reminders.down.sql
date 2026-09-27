DROP INDEX IF EXISTS idx_saved_messages_due_reminder;
ALTER TABLE saved_messages DROP COLUMN IF EXISTS "remindedAt";
ALTER TABLE saved_messages DROP COLUMN IF EXISTS "remindAt";
