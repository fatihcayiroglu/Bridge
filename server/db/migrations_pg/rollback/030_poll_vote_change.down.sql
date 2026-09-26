-- rollback/030_poll_vote_change.down.sql
-- Anket oyu değiştirme tercihini geri al.

BEGIN;

ALTER TABLE polls DROP COLUMN IF EXISTS "allowVoteChange";

COMMIT;
