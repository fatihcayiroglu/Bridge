-- Rollback 077: drop the two user FKs this migration owns.
-- Orphan rows removed by the up migration are not restored: they referenced
-- users that no longer exist (ON DELETE CASCADE would have removed them too).
ALTER TABLE oauth_tokens  DROP CONSTRAINT IF EXISTS fk_oauth_tokens_user;
ALTER TABLE server_boosts DROP CONSTRAINT IF EXISTS fk_server_boosts_user;
