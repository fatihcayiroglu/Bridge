-- Persist poll vote-change policy used by the API.
ALTER TABLE polls
  ADD COLUMN IF NOT EXISTS "allowVoteChange" BOOLEAN NOT NULL DEFAULT TRUE;
