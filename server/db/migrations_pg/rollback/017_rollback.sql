-- Rollback 017: Sprint 122 dmPrivacy alanını kaldır
ALTER TABLE users DROP COLUMN IF EXISTS "dmPrivacy";
