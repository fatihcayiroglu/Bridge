-- Scopes a server admin granted to an installed marketplace bot (Final21 Phase 14).
--
-- Before this column a marketplace install was a bare (botId, serverId) link:
-- no consent was recorded and nothing could be enforced. Existing links get the
-- base scope only ("commands": receive the slash commands users invoke); any
-- further capability requires the admin to consent again. Fail closed.

ALTER TABLE server_bots
  ADD COLUMN IF NOT EXISTS "grantedScopes" JSONB NOT NULL DEFAULT '["commands"]'::jsonb;
