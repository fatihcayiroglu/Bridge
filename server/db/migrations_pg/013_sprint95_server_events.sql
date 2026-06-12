-- Migration 013 — Sprint 95: Sunucu Etkinlikleri
-- Çalıştır: psql $DATABASE_URL -f migrations/013_sprint95_server_events.sql

BEGIN;

CREATE TABLE IF NOT EXISTS server_events (
  id           TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  server_id    TEXT        NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  creator_id   TEXT        NOT NULL REFERENCES users(id)   ON DELETE SET NULL,
  title        TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  description  TEXT        CHECK (char_length(description) <= 1000),
  location     TEXT        CHECK (char_length(location) <= 200),
  channel_id   TEXT        REFERENCES channels(id) ON DELETE SET NULL,
  starts_at    TIMESTAMPTZ NOT NULL,
  ends_at      TIMESTAMPTZ,
  status       TEXT        NOT NULL DEFAULT 'scheduled'
                           CHECK (status IN ('scheduled','active','ended','cancelled')),
  cover_image  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT ends_after_starts CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS server_event_rsvp (
  event_id    TEXT        NOT NULL REFERENCES server_events(id) ON DELETE CASCADE,
  user_id     TEXT        NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
  status      TEXT        NOT NULL CHECK (status IN ('interested','going','not_going')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (event_id, user_id)
);

-- İndeksler
CREATE INDEX IF NOT EXISTS idx_server_events_server_id  ON server_events (server_id);
CREATE INDEX IF NOT EXISTS idx_server_events_starts_at  ON server_events (starts_at);
CREATE INDEX IF NOT EXISTS idx_server_events_status     ON server_events (status);
CREATE INDEX IF NOT EXISTS idx_server_event_rsvp_event  ON server_event_rsvp (event_id);
CREATE INDEX IF NOT EXISTS idx_server_event_rsvp_user   ON server_event_rsvp (user_id);

-- Otomatik updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_server_events_updated_at      ON server_events;
DROP TRIGGER IF EXISTS trg_server_event_rsvp_updated_at  ON server_event_rsvp;

CREATE TRIGGER trg_server_events_updated_at
  BEFORE UPDATE ON server_events
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_server_event_rsvp_updated_at
  BEFORE UPDATE ON server_event_rsvp
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
