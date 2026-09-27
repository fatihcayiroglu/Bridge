-- rollback/013_sprint95_server_events.down.sql
-- Sprint 95: sunucu etkinlikleri ve RSVP şemasını geri al.
-- RSVP önce düşürülür: server_events(id) üzerine FK taşır.

BEGIN;

DROP INDEX IF EXISTS idx_server_event_rsvp_user;
DROP INDEX IF EXISTS idx_server_event_rsvp_event;
DROP TABLE IF EXISTS server_event_rsvp;

DROP INDEX IF EXISTS idx_server_events_status;
DROP INDEX IF EXISTS idx_server_events_starts_at;
DROP INDEX IF EXISTS idx_server_events_server_id;
DROP TABLE IF EXISTS server_events;

COMMIT;
