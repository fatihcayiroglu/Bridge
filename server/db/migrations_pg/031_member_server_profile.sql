-- Migration 031: canonical per-server member profile storage.
-- routes/serverMemberProfile.ts reads/writes members."serverProfile"; without
-- this JSONB column real PostgreSQL rejects every update while mock DB tests pass.

ALTER TABLE members
  ADD COLUMN IF NOT EXISTS "serverProfile" JSONB NOT NULL DEFAULT '{}';
