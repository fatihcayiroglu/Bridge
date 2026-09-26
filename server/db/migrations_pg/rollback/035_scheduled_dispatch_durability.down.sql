DROP INDEX IF EXISTS idx_messages_scheduled_id;
DROP INDEX IF EXISTS idx_sched_dispatch_due;
ALTER TABLE scheduled_msgs DROP COLUMN IF EXISTS "failureReason";
ALTER TABLE scheduled_msgs DROP COLUMN IF EXISTS "failedAt";
ALTER TABLE scheduled_msgs DROP COLUMN IF EXISTS "lastError";
ALTER TABLE scheduled_msgs DROP COLUMN IF EXISTS "dispatchAttempts";
ALTER TABLE scheduled_msgs DROP COLUMN IF EXISTS "claimUntil";
ALTER TABLE scheduled_msgs DROP COLUMN IF EXISTS "claimOwner";
