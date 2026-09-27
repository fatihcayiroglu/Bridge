BEGIN;
DROP INDEX IF EXISTS uq_bot_marketplace_executable;
ALTER TABLE bot_marketplace DROP CONSTRAINT IF EXISTS bot_marketplace_executable_bot_fk;
ALTER TABLE bot_marketplace DROP COLUMN IF EXISTS "executableBotId";
COMMIT;
