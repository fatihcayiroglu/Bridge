-- 051_bot_sdk_command_contract.sql
-- Persist canonical slash-command metadata registered by executable Bridge bots.
ALTER TABLE bots
  ADD COLUMN IF NOT EXISTS "slashCommands" JSONB NOT NULL DEFAULT '[]';
