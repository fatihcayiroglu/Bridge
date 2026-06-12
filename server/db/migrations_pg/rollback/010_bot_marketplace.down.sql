-- rollback/010_bot_marketplace.down.sql
-- Sprint 83: bot_marketplace tablolarını geri al

BEGIN;

DROP INDEX IF EXISTS idx_bmp_reviews_bot;
DROP TABLE IF EXISTS bot_marketplace_reviews;

DROP INDEX IF EXISTS idx_bmp_fts;
DROP INDEX IF EXISTS idx_bmp_tags;
DROP INDEX IF EXISTS idx_bmp_submitted;
DROP INDEX IF EXISTS idx_bmp_featured;
DROP INDEX IF EXISTS idx_bmp_approved;
DROP INDEX IF EXISTS idx_bmp_category;

DROP TABLE IF EXISTS bot_marketplace;

COMMIT;
