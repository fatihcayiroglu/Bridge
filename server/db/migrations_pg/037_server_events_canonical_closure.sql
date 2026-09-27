-- 037 — Server Events canonical schema closure.
-- Historical migration 013 created these tables, but clean-install schema.ts
-- and the inline startup migrator did not. Keep every canonical ownership path
-- aligned without making schema.sql authoritative.
BEGIN;

CREATE TABLE IF NOT EXISTS server_events (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  server_id TEXT NOT NULL REFERENCES servers(_id) ON DELETE CASCADE,
  creator_id TEXT REFERENCES users(_id) ON DELETE SET NULL,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  description TEXT CHECK (char_length(description) <= 1000),
  location TEXT CHECK (char_length(location) <= 200),
  channel_id TEXT REFERENCES channels(_id) ON DELETE CASCADE,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','active','ended','cancelled')),
  cover_image TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT server_events_ends_after_starts CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS server_event_rsvp (
  event_id TEXT NOT NULL REFERENCES server_events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('interested','going','not_going')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(event_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_server_events_server_id ON server_events(server_id);
CREATE INDEX IF NOT EXISTS idx_server_events_starts_at ON server_events(starts_at);
CREATE INDEX IF NOT EXISTS idx_server_events_status ON server_events(status);
CREATE INDEX IF NOT EXISTS idx_server_event_rsvp_event ON server_event_rsvp(event_id);
CREATE INDEX IF NOT EXISTS idx_server_event_rsvp_user ON server_event_rsvp(user_id);

-- Migration 013 created this CHECK as `ends_after_starts`; clean-install
-- schema.ts (and db/postgres/migrations.ts) create it as
-- `server_events_ends_after_starts`. The CREATE TABLE IF NOT EXISTS above
-- cannot reconcile the two, because it does nothing when 013 already made the
-- table - so a migration-path database kept the legacy name forever while a
-- fresh install had the canonical one. Normalise the name explicitly; that is
-- exactly the "canonical ownership" this migration exists to close.
ALTER TABLE server_events DROP CONSTRAINT IF EXISTS ends_after_starts;
ALTER TABLE server_events DROP CONSTRAINT IF EXISTS server_events_ends_after_starts;
ALTER TABLE server_events ADD CONSTRAINT server_events_ends_after_starts
  CHECK (ends_at IS NULL OR ends_at > starts_at);

-- Migration 013 used ON DELETE SET NULL. That can silently widen a private
-- channel event into a server-wide event after channel deletion. Keep the
-- privacy boundary fail-closed by deleting channel-scoped events with channel.
ALTER TABLE server_events DROP CONSTRAINT IF EXISTS server_events_channel_id_fkey;
ALTER TABLE server_events ADD CONSTRAINT server_events_channel_id_fkey
  FOREIGN KEY (channel_id) REFERENCES channels(_id) ON DELETE CASCADE;

COMMIT;
