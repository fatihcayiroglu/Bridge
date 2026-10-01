-- 078_server_ai_enabled.down.sql
--
-- Structurally lossless. Data consequence: every server's AI opt-out is
-- forgotten; servers that had turned AI off are AI-enabled again after the
-- column is re-added with its default. Re-apply 078 and have owners turn it
-- off again before re-enabling an AI provider.
ALTER TABLE servers DROP COLUMN IF EXISTS "aiEnabled";
