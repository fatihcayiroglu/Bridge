-- rollback/011_sprint93_boost_vanity_oauth.down.sql
-- Sprint 93: boost / vanity URL / OAuth şemasını geri al.
-- Yalnızca bu migration'ın EKLEDİĞİ nesneler düşürülür.

BEGIN;

DROP INDEX IF EXISTS idx_oauth_user;
DROP TABLE IF EXISTS oauth_tokens;

DROP INDEX IF EXISTS idx_servers_vanity;
ALTER TABLE servers DROP COLUMN IF EXISTS "boostTier";
ALTER TABLE servers DROP COLUMN IF EXISTS "boostCount";
ALTER TABLE servers DROP COLUMN IF EXISTS "vanityUrl";

DROP INDEX IF EXISTS idx_boosts_user_server;
DROP INDEX IF EXISTS idx_boosts_user;
DROP INDEX IF EXISTS idx_boosts_server;
DROP TABLE IF EXISTS server_boosts;

COMMIT;
