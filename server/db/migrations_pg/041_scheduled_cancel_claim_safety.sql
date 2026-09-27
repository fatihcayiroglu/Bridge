-- 041_scheduled_cancel_claim_safety.sql
-- Make cancel-vs-dispatch state explicit and race-safe.

ALTER TABLE scheduled_msgs ADD COLUMN IF NOT EXISTS "cancelledAt" BIGINT;
DROP INDEX IF EXISTS idx_sched_dispatch_due;
CREATE INDEX IF NOT EXISTS idx_sched_dispatch_due
  ON scheduled_msgs(sent, "sendAt", "claimUntil")
  WHERE sent = FALSE AND "failedAt" IS NULL AND "cancelledAt" IS NULL;
