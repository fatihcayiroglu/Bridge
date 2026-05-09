-- Migration 002: Add token reuse detection columns to refresh_tokens
-- Required for auth.js token family / reuse detection to work correctly.
ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS used       SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "usedAt"   BIGINT,
  ADD COLUMN IF NOT EXISTS family     TEXT;

CREATE INDEX IF NOT EXISTS idx_rt_family ON refresh_tokens(family);
