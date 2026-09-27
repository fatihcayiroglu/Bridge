-- 039 — canonical persisted Super Reaction counters on messages
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS "superReactions" JSONB NOT NULL DEFAULT '{}'::jsonb;
