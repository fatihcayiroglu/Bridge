-- Rollback 051: command metadata can be re-registered by the bot SDK.
ALTER TABLE bots DROP COLUMN IF EXISTS "slashCommands";
