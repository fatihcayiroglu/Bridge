-- Migration 011: Sprint 93 — Boost, Vanity URL, OAuth Tokens
-- Run: psql $DATABASE_URL < migrations_pg/011_sprint93_boost_vanity_oauth.sql

BEGIN;

-- Boost tablosu
CREATE TABLE IF NOT EXISTS server_boosts (
  _id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "serverId"   TEXT NOT NULL REFERENCES servers(_id) ON DELETE CASCADE,
  "userId"     TEXT NOT NULL,
  "boostedAt"  BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
  "expiresAt"  BIGINT,
  active       BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_boosts_server ON server_boosts("serverId", active);
CREATE INDEX IF NOT EXISTS idx_boosts_user   ON server_boosts("userId");
CREATE UNIQUE INDEX IF NOT EXISTS idx_boosts_user_server ON server_boosts("userId","serverId") WHERE active = TRUE;

-- Sunucu tablosuna yeni alanlar
ALTER TABLE servers ADD COLUMN IF NOT EXISTS "vanityUrl"  TEXT;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS "boostCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS "boostTier"  INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_vanity ON servers("vanityUrl") WHERE "vanityUrl" IS NOT NULL;

-- OAuth token tablosu
CREATE TABLE IF NOT EXISTS oauth_tokens (
  _id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "userId"       TEXT NOT NULL,
  platform       TEXT NOT NULL,
  "accessToken"  TEXT NOT NULL,
  "refreshToken" TEXT,
  "expiresAt"    BIGINT,
  scope          TEXT,
  "createdAt"    BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
  UNIQUE("userId", platform)
);
CREATE INDEX IF NOT EXISTS idx_oauth_user ON oauth_tokens("userId");

COMMIT;
