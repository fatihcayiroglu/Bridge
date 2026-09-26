-- rollback/012_sprint94_channel_follows.down.sql
-- Sprint 94: kanal takip (crosspost kaynağı) şemasını geri al.

BEGIN;

DROP INDEX IF EXISTS idx_channel_follows_target;
DROP INDEX IF EXISTS idx_channel_follows_source;
DROP TABLE IF EXISTS channel_follows;

COMMIT;
