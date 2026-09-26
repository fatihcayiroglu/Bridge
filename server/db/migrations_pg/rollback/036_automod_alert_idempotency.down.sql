-- 036_automod_alert_idempotency.down.sql
-- Roll back only the review-added idempotency index; message data is untouched.
DROP INDEX IF EXISTS idx_automod_alert_flagged_msg;
