-- 084: only reversible while this D2 groundwork remains unpopulated.
-- Fail closed instead of destroying expiry/tombstone state if feature wiring
-- has begun. Run as part of the migration runner's transaction.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM channel_expiry_tombstones) THEN
    RAISE EXCEPTION 'Cannot roll back 084: channel expiry tombstones exist';
  END IF;
  IF EXISTS (
    SELECT 1 FROM channels
     WHERE "expiresAt" IS NOT NULL OR "expiryVersion" <> 0
  ) THEN
    RAISE EXCEPTION 'Cannot roll back 084: channel expiry metadata is in use';
  END IF;
END $$;

-- No CASCADE: a later migration depending on these objects must be rolled
-- back first instead of silently destroying its schema.
DROP TABLE channel_expiry_tombstones;
ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_expiry_at_check;
ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_expiry_version_check;
ALTER TABLE channels DROP COLUMN IF EXISTS "expiresAt";
ALTER TABLE channels DROP COLUMN IF EXISTS "expiryVersion";
