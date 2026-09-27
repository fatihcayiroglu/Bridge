-- 042_outgoing_webhook_durable_delivery.sql
-- Bounded, multi-node-safe retry queue for outgoing webhooks.

CREATE TABLE IF NOT EXISTS outgoing_webhook_deliveries (
  _id TEXT PRIMARY KEY,
  "webhookId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "eventName" TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  attempts INTEGER NOT NULL DEFAULT 0,
  "nextAt" BIGINT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  "claimOwner" TEXT,
  "claimUntil" BIGINT,
  "lastError" TEXT
);
CREATE INDEX IF NOT EXISTS idx_ogwh_delivery_due ON outgoing_webhook_deliveries("nextAt", "claimUntil");
CREATE INDEX IF NOT EXISTS idx_ogwh_delivery_webhook ON outgoing_webhook_deliveries("webhookId", "createdAt");
