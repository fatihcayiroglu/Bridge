DROP INDEX IF EXISTS idx_sched_dispatch_due;
ALTER TABLE scheduled_msgs DROP COLUMN IF EXISTS "cancelledAt";
CREATE INDEX IF NOT EXISTS idx_sched_dispatch_due
  ON scheduled_msgs(sent, "sendAt", "claimUntil")
  WHERE sent = FALSE AND "failedAt" IS NULL;
