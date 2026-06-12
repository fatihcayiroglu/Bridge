-- Rollback migration 007: user_badges tablosunu kaldır
-- NOT: 005 down zaten bunu yapıyor; bu dosya bağımsız rollback için.
BEGIN;
DROP INDEX IF EXISTS idx_user_badges_user;
DROP TABLE IF EXISTS user_badges;
COMMIT;
