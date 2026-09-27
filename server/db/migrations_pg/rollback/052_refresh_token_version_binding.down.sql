-- Rollback 052. Existing refresh sessions deleted by the up migration cannot
-- be reconstructed; rollback only restores the older schema shape.
ALTER TABLE refresh_tokens DROP COLUMN IF EXISTS "tokenVersion";
