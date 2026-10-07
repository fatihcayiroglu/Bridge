-- 080_server_raid_protection.down.sql
--
-- Structurally lossless after re-up; configuration and any still-active
-- lockdown timestamp are intentionally forgotten on rollback.
ALTER TABLE servers DROP CONSTRAINT IF EXISTS servers_raid_lockdown_until_nonnegative;
ALTER TABLE servers DROP CONSTRAINT IF EXISTS servers_raid_mitigation_level_check;
ALTER TABLE servers DROP COLUMN IF EXISTS "raidLockdownUntil";
ALTER TABLE servers DROP COLUMN IF EXISTS "raidMitigationLevel";
