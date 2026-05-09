-- Migration 003: Add token reuse detection columns to refresh_tokens (SQLite)
ALTER TABLE refresh_tokens ADD COLUMN used    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE refresh_tokens ADD COLUMN usedAt  INTEGER;
ALTER TABLE refresh_tokens ADD COLUMN family  TEXT;
CREATE INDEX IF NOT EXISTS idx_rt_family ON refresh_tokens(family);
