DROP INDEX IF EXISTS idx_apqueue_claim_due;
ALTER TABLE ap_delivery_queue DROP COLUMN IF EXISTS "claimUntil";
ALTER TABLE ap_delivery_queue DROP COLUMN IF EXISTS "claimOwner";
