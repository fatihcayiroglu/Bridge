-- 035_scheduled_dispatch_durability.sql
-- Multi-node-safe scheduled-message dispatch with crash recovery and idempotency.

ALTER TABLE scheduled_msgs ADD COLUMN IF NOT EXISTS "claimOwner" TEXT;
ALTER TABLE scheduled_msgs ADD COLUMN IF NOT EXISTS "claimUntil" BIGINT;
ALTER TABLE scheduled_msgs ADD COLUMN IF NOT EXISTS "dispatchAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduled_msgs ADD COLUMN IF NOT EXISTS "lastError" TEXT;
ALTER TABLE scheduled_msgs ADD COLUMN IF NOT EXISTS "failedAt" BIGINT;
ALTER TABLE scheduled_msgs ADD COLUMN IF NOT EXISTS "failureReason" TEXT;

CREATE INDEX IF NOT EXISTS idx_sched_dispatch_due
  ON scheduled_msgs(sent, "sendAt", "claimUntil")
  WHERE sent = FALSE AND "failedAt" IS NULL;

-- A crashed worker may persist the message before it can finalize the schedule.
-- The retry must observe/reuse that message rather than create a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_scheduled_id
  ON messages("scheduledId") WHERE "scheduledId" IS NOT NULL;
