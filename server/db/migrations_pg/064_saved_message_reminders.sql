-- P1 Saved follow-up reminders. Delivery state is separate from the saved item
-- so a reminder can be scheduled, delivered and later rescheduled safely.
ALTER TABLE saved_messages ADD COLUMN IF NOT EXISTS "remindAt" BIGINT;
ALTER TABLE saved_messages ADD COLUMN IF NOT EXISTS "remindedAt" BIGINT;
CREATE INDEX IF NOT EXISTS idx_saved_messages_due_reminder
  ON saved_messages("remindAt", _id)
  WHERE "remindAt" IS NOT NULL AND "remindedAt" IS NULL;
