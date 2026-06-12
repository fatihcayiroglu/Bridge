-- Migration 007: user_badges tablosu
-- badges.ts bu tabloyu kullanır; schema.sql'de eksikti.
-- Çalıştırma: psql -d bridge -f server/db/migrations_pg/007_user_badges.sql

BEGIN;

CREATE TABLE IF NOT EXISTS user_badges (
  _id        TEXT PRIMARY KEY,
  "userId"   TEXT NOT NULL REFERENCES users(_id) ON DELETE CASCADE,
  badge      TEXT NOT NULL,
  label      TEXT NOT NULL,
  icon       TEXT NOT NULL DEFAULT '',
  "awardedAt" BIGINT NOT NULL,
  "awardedBy" TEXT,
  UNIQUE("userId", badge)
);

CREATE INDEX IF NOT EXISTS idx_user_badges_user ON user_badges("userId");

COMMIT;
