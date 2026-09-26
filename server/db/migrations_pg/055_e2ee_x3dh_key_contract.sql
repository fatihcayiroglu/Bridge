-- 055_e2ee_x3dh_key_contract.sql
-- Canonicalize the E2EE public-key/X3DH server-side bundle schema and make
-- one-time prekeys representable as structured JSONB. Private keys are never
-- stored by this migration.
ALTER TABLE users ADD COLUMN IF NOT EXISTS "e2ePublicKey" TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "e2eKeyVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "e2eAlgorithm" TEXT NOT NULL DEFAULT 'X25519';
ALTER TABLE users ADD COLUMN IF NOT EXISTS "e2eKeyUpdatedAt" BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "x3dhIdentityKey" TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "x3dhSignedPreKey" JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "x3dhOneTimePreKeys" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE users ADD COLUMN IF NOT EXISTS "x3dhUpdatedAt" BIGINT;

-- These values describe existing cryptographic key material. Guessing a key
-- version/algorithm or replacing a malformed bundle with [] can permanently
-- mislabel or erase live keys. Newly-added columns receive the safe defaults
-- above; a pre-existing drifted column must be audited explicitly.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM users
     WHERE "e2eKeyVersion" IS NULL OR "e2eKeyVersion" < 1
        OR "e2eAlgorithm" IS NULL OR "e2eAlgorithm" NOT IN ('X25519', 'P-256')
        OR "x3dhOneTimePreKeys" IS NULL
        OR jsonb_typeof("x3dhOneTimePreKeys") <> 'array'
  ) THEN
    RAISE EXCEPTION '055: invalid persisted E2EE/X3DH key state; repair explicitly before migration';
  END IF;
END $$;

ALTER TABLE users ALTER COLUMN "e2eKeyVersion" SET DEFAULT 1;
ALTER TABLE users ALTER COLUMN "e2eKeyVersion" SET NOT NULL;
ALTER TABLE users ALTER COLUMN "e2eAlgorithm" SET DEFAULT 'X25519';
ALTER TABLE users ALTER COLUMN "e2eAlgorithm" SET NOT NULL;
ALTER TABLE users ALTER COLUMN "x3dhOneTimePreKeys" SET DEFAULT '[]'::jsonb;
ALTER TABLE users ALTER COLUMN "x3dhOneTimePreKeys" SET NOT NULL;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_e2e_key_version_check;
ALTER TABLE users ADD CONSTRAINT users_e2e_key_version_check
  CHECK ("e2eKeyVersion" >= 1);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_e2e_algorithm_check;
ALTER TABLE users ADD CONSTRAINT users_e2e_algorithm_check
  CHECK ("e2eAlgorithm" IN ('X25519', 'P-256'));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_x3dh_otpks_array_check;
DO $$
BEGIN
  -- Migration 057 supersedes this coarse guard with users_x3dh_bundle_valid.
  -- During isolated down/up verification (or a repaired partial deploy), do
  -- not install both constraints and create order-dependent schema drift.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'users'::regclass AND conname = 'users_x3dh_bundle_valid'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_x3dh_otpks_array_check
      CHECK (jsonb_typeof("x3dhOneTimePreKeys") = 'array');
  END IF;
END $$;
