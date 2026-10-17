-- 084: P7 D2 schema-only, backwards-compatible expiry reservation.
-- IMPORTANT: This migration DOES NOT enable expiring channels, delete data,
-- or claim durable cleanup. API, authorization, multiworker and federation
-- enforcement must ship together in separately verified commits.
-- Existing rows remain permanent: expiresAt stays NULL, expiryVersion 0.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS "expiresAt" BIGINT;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS "expiryVersion" BIGINT NOT NULL DEFAULT 0;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'channels'::regclass
       AND conname = 'channels_expiry_at_check'
  ) THEN
    ALTER TABLE channels ADD CONSTRAINT channels_expiry_at_check
      CHECK ("expiresAt" IS NULL OR ("expiresAt" > 0 AND "expiresAt" <= 9007199254740991));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'channels'::regclass
       AND conname = 'channels_expiry_version_check'
  ) THEN
    ALTER TABLE channels ADD CONSTRAINT channels_expiry_version_check
      CHECK ("expiryVersion" >= 0 AND "expiryVersion" <= 9007199254740991);
  END IF;
END $$;

-- Do not add a FK to channels: the tombstone must survive row deletion.
-- Separate external object cleanup is NOT transactional with PostgreSQL.
CREATE TABLE IF NOT EXISTS channel_expiry_tombstones (
  "channelId" TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL,
  "expiredAt" BIGINT NOT NULL CHECK ("expiredAt" > 0 AND "expiredAt" <= 9007199254740991),
  "expiryVersion" BIGINT NOT NULL CHECK ("expiryVersion" >= 0 AND "expiryVersion" <= 9007199254740991),
  "recordedAt" BIGINT NOT NULL CHECK ("recordedAt" > 0 AND "recordedAt" <= 9007199254740991),
  "cleanupState" TEXT NOT NULL DEFAULT 'pending'
    CHECK ("cleanupState" IN ('pending', 'objects_cleaned', 'converged'))
);
