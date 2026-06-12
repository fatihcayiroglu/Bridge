-- Rollback migration 005: user_badges + servers featured/category kaldır
BEGIN;
DROP INDEX IF EXISTS idx_servers_category;
DROP INDEX IF EXISTS idx_servers_featured;
ALTER TABLE servers DROP COLUMN IF EXISTS category;
ALTER TABLE servers DROP COLUMN IF EXISTS "featuredAt";
ALTER TABLE servers DROP COLUMN IF EXISTS featured;
DROP INDEX IF EXISTS idx_user_badges_user;
DROP TABLE IF EXISTS user_badges;
COMMIT;
