-- 078: per-server AI opt-out (P6)
--
-- The installation decides whether AI exists at all (AI_PROVIDER). A server
-- owner decides whether their server's content may reach it: with
-- "aiEnabled" = FALSE no channel context, message text, audio or embedding of
-- that server is sent to an AI provider (server/lib/aiServerPolicy.ts).
--
-- Existing and new servers default to TRUE. That preserves behaviour: AI still
-- needs the operator to configure a provider, and the owner opts out.

ALTER TABLE servers
  ADD COLUMN IF NOT EXISTS "aiEnabled" BOOLEAN NOT NULL DEFAULT TRUE;
