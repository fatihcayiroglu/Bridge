BEGIN;
ALTER TABLE bot_marketplace
  ADD COLUMN IF NOT EXISTS "executableBotId" TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bot_marketplace_executable_bot_fk') THEN
    ALTER TABLE bot_marketplace
      ADD CONSTRAINT bot_marketplace_executable_bot_fk
      FOREIGN KEY ("executableBotId") REFERENCES bots(_id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_bot_marketplace_executable ON bot_marketplace("executableBotId") WHERE "executableBotId" IS NOT NULL;
COMMIT;
