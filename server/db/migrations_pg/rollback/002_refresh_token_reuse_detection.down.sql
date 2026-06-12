-- Rollback migration 002: token reuse detection kolonlarını kaldır
BEGIN;
DROP INDEX IF EXISTS idx_rt_family;
ALTER TABLE refresh_tokens DROP COLUMN IF EXISTS family;
ALTER TABLE refresh_tokens DROP COLUMN IF EXISTS "usedAt";
ALTER TABLE refresh_tokens DROP COLUMN IF EXISTS used;
COMMIT;
