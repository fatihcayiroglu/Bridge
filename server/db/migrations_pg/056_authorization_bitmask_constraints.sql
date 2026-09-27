-- 056_authorization_bitmask_constraints.sql
-- Persisted authorization masks must obey the same contract as runtime PERMS.
-- Fail the upgrade if unknown/negative/overlapping authorization state exists;
-- guessing a repair could silently grant or revoke privileges.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM roles
    WHERE permissions IS NULL
       OR permissions < 0 OR permissions > 1094713343
       OR (permissions::bigint & 1094713343::bigint) <> permissions::bigint
  ) THEN
    RAISE EXCEPTION '056: invalid persisted roles.permissions; repair explicitly before migration';
  END IF;

  IF EXISTS (
    SELECT 1 FROM channel_overrides
    WHERE allow IS NULL OR deny IS NULL
       OR allow < 0 OR deny < 0
       OR allow > 1094713343 OR deny > 1094713343
       OR (allow::bigint & 1094713343::bigint) <> allow::bigint
       OR (deny::bigint & 1094713343::bigint) <> deny::bigint
       OR (allow::bigint & deny::bigint) <> 0
  ) THEN
    RAISE EXCEPTION '056: invalid persisted channel_overrides mask; repair explicitly before migration';
  END IF;

  IF EXISTS (
    SELECT 1 FROM channel_permissions
    WHERE allow IS NULL OR deny IS NULL
       OR allow < 0 OR deny < 0
       OR allow > 1094713343 OR deny > 1094713343
       OR (allow::bigint & 1094713343::bigint) <> allow::bigint
       OR (deny::bigint & 1094713343::bigint) <> deny::bigint
       OR (allow::bigint & deny::bigint) <> 0
  ) THEN
    RAISE EXCEPTION '056: invalid persisted channel_permissions mask; repair explicitly before migration';
  END IF;
END $$;

-- CHECK treats NULL/unknown as passing. Re-assert the canonical non-null
-- storage contract so drifted schemas cannot persist an unvalidated mask.
ALTER TABLE roles
  ALTER COLUMN permissions SET DEFAULT 16,
  ALTER COLUMN permissions SET NOT NULL;
ALTER TABLE channel_overrides
  ALTER COLUMN allow SET DEFAULT 0,
  ALTER COLUMN allow SET NOT NULL,
  ALTER COLUMN deny SET DEFAULT 0,
  ALTER COLUMN deny SET NOT NULL;
ALTER TABLE channel_permissions
  ALTER COLUMN allow SET DEFAULT 0,
  ALTER COLUMN allow SET NOT NULL,
  ALTER COLUMN deny SET DEFAULT 0,
  ALTER COLUMN deny SET NOT NULL;

ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_permissions_valid;
ALTER TABLE roles ADD CONSTRAINT roles_permissions_valid CHECK (
  permissions >= 0 AND permissions <= 1094713343
  AND (permissions::bigint & 1094713343::bigint) = permissions::bigint
);

ALTER TABLE channel_overrides DROP CONSTRAINT IF EXISTS channel_overrides_masks_valid;
ALTER TABLE channel_overrides ADD CONSTRAINT channel_overrides_masks_valid CHECK (
  allow >= 0 AND deny >= 0
  AND allow <= 1094713343 AND deny <= 1094713343
  AND (allow::bigint & 1094713343::bigint) = allow::bigint
  AND (deny::bigint & 1094713343::bigint) = deny::bigint
  AND (allow::bigint & deny::bigint) = 0
);

ALTER TABLE channel_permissions DROP CONSTRAINT IF EXISTS channel_permissions_masks_valid;
ALTER TABLE channel_permissions ADD CONSTRAINT channel_permissions_masks_valid CHECK (
  allow >= 0 AND deny >= 0
  AND allow <= 1094713343 AND deny <= 1094713343
  AND (allow::bigint & 1094713343::bigint) = allow::bigint
  AND (deny::bigint & 1094713343::bigint) = deny::bigint
  AND (allow::bigint & deny::bigint) = 0
);
