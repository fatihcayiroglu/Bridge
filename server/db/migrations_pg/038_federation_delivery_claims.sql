-- 038_federation_delivery_claims.sql
-- Multi-node-safe ActivityPub retry ownership.

ALTER TABLE ap_delivery_queue ADD COLUMN IF NOT EXISTS "claimOwner" TEXT;
ALTER TABLE ap_delivery_queue ADD COLUMN IF NOT EXISTS "claimUntil" BIGINT;

CREATE INDEX IF NOT EXISTS idx_apqueue_claim_due
  ON ap_delivery_queue("nextAt", "claimUntil");
