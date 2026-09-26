-- 036_automod_alert_idempotency.sql
-- Prevent duplicate AutoMod alerts for the same source message across overlapping scans/nodes.

CREATE UNIQUE INDEX IF NOT EXISTS idx_automod_alert_flagged_msg
  ON messages("flaggedMsgId")
  WHERE "autoModAlert" = TRUE AND "flaggedMsgId" IS NOT NULL;
