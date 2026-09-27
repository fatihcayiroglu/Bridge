-- 053_server_mfa_domain.sql
-- SECURITY: all server-join entry points treat mfaLevel as the bounded enum
-- 0|1|2. Historical malformed values used to become NaN through Number(...)
-- and silently bypass `mfaLevel >= 1`; repair them fail-closed to level 2.

ALTER TABLE servers
  ADD COLUMN IF NOT EXISTS "mfaLevel" INTEGER NOT NULL DEFAULT 0;

UPDATE servers
   SET "mfaLevel" = 2
 WHERE "mfaLevel" IS NULL
    OR "mfaLevel" NOT IN (0, 1, 2);

-- `ADD COLUMN IF NOT EXISTS` does not repair a pre-existing drifted column.
-- Re-assert the canonical storage contract before adding the bounded domain so
-- a nullable/default-less historical column cannot retain a second meaning for
-- "MFA disabled" outside the application parser.
ALTER TABLE servers
  ALTER COLUMN "mfaLevel" SET DEFAULT 0,
  ALTER COLUMN "mfaLevel" SET NOT NULL;

ALTER TABLE servers
  DROP CONSTRAINT IF EXISTS servers_mfa_level_check;

ALTER TABLE servers
  ADD CONSTRAINT servers_mfa_level_check
  CHECK ("mfaLevel" IN (0, 1, 2));
