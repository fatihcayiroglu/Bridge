-- 040_outgoing_webhook_schema_closure.sql
-- Align outgoing webhook runtime fields with clean/upgraded PostgreSQL and BOOLEAN semantics.

ALTER TABLE outgoing_webhooks ADD COLUMN IF NOT EXISTS "consecutiveFailures" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outgoing_webhooks ADD COLUMN IF NOT EXISTS "lastFailedAt" BIGINT;
ALTER TABLE outgoing_webhooks ADD COLUMN IF NOT EXISTS "lastError" TEXT;
CREATE INDEX IF NOT EXISTS idx_ogwh_server ON outgoing_webhooks("serverId");
