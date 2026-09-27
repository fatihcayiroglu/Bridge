-- Rollback 033: remove only the crosspost idempotency log.
-- Persisted crosspost messages intentionally remain as ordinary message history.
BEGIN;
DROP TABLE IF EXISTS crosspost_log;
COMMIT;
