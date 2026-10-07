-- 080: P7 B1 server anti-raid policy
--
-- Bounded, explainable configuration only. There is no permanent per-user
-- trust score. raidLockdownUntil is an absolute expiry and can be cleared by a
-- moderator; expired values have no enforcement effect.

ALTER TABLE servers
  ADD COLUMN IF NOT EXISTS "raidMitigationLevel" TEXT NOT NULL DEFAULT 'balanced';

UPDATE servers
   SET "raidMitigationLevel" = 'strict'
 WHERE "raidMitigationLevel" IS NULL
    OR "raidMitigationLevel" NOT IN ('off', 'balanced', 'strict');

ALTER TABLE servers
  ALTER COLUMN "raidMitigationLevel" SET DEFAULT 'balanced',
  ALTER COLUMN "raidMitigationLevel" SET NOT NULL;

ALTER TABLE servers
  ADD COLUMN IF NOT EXISTS "raidLockdownUntil" BIGINT;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'servers_raid_mitigation_level_check'
  ) THEN
    ALTER TABLE servers
      ADD CONSTRAINT servers_raid_mitigation_level_check
      CHECK ("raidMitigationLevel" IN ('off', 'balanced', 'strict'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'servers_raid_lockdown_until_nonnegative'
  ) THEN
    ALTER TABLE servers
      ADD CONSTRAINT servers_raid_lockdown_until_nonnegative
      CHECK ("raidLockdownUntil" IS NULL OR "raidLockdownUntil" >= 0);
  END IF;
END $$;
