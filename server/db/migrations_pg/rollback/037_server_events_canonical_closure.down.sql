-- Rollback 037 — Server Events canonical schema closure.
--
-- server_events / server_event_rsvp are NOT dropped here: they predate this
-- closure (migration 013 owns them) and dropping them would destroy historical
-- product data. What 037 actually CHANGED is exactly two definitions, and a
-- rollback has to put both back the way 013 left them. The previous version of
-- this file was an empty BEGIN/COMMIT, so rolling 037 back silently changed
-- nothing at all.
--
-- WARNING: restoring ON DELETE SET NULL re-opens the privacy behaviour 037
-- closed (deleting a channel would widen a channel-scoped event into a
-- server-wide one). That is deliberate: a rollback must reproduce the previous
-- release's schema, because the previous release's code is what will run
-- against it. Roll forward again to restore the fail-closed behaviour.
BEGIN;

ALTER TABLE server_events DROP CONSTRAINT IF EXISTS server_events_channel_id_fkey;
ALTER TABLE server_events ADD CONSTRAINT server_events_channel_id_fkey
  FOREIGN KEY (channel_id) REFERENCES channels(_id) ON DELETE SET NULL;

ALTER TABLE server_events DROP CONSTRAINT IF EXISTS server_events_ends_after_starts;
ALTER TABLE server_events DROP CONSTRAINT IF EXISTS ends_after_starts;
ALTER TABLE server_events ADD CONSTRAINT ends_after_starts
  CHECK (ends_at IS NULL OR ends_at > starts_at);

COMMIT;
