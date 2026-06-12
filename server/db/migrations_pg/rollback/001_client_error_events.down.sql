-- Rollback migration 001: client_error_events tablosunu kaldır
BEGIN;
DROP INDEX IF EXISTS idx_client_error_events_type;
DROP INDEX IF EXISTS idx_client_error_events_created_at;
DROP TABLE IF EXISTS client_error_events;
COMMIT;
