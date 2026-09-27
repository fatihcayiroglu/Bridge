-- 052_refresh_token_version_binding.sql
-- SECURITY: a refresh token must be bound to the user tokenVersion that was
-- current at issuance. Otherwise a stale refresh row surviving logout-all or
-- password-change cleanup can read the NEW user row and mint a fresh access
-- token with the new version.
ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER;

-- Historical rows have no trustworthy issuance version. Revoking them is the
-- only fail-closed migration; users perform a one-time re-login after deploy.
DELETE FROM refresh_tokens WHERE "tokenVersion" IS NULL;

ALTER TABLE refresh_tokens
  ALTER COLUMN "tokenVersion" SET NOT NULL;

ALTER TABLE refresh_tokens
  DROP CONSTRAINT IF EXISTS refresh_tokens_token_version_nonnegative;
ALTER TABLE refresh_tokens
  ADD CONSTRAINT refresh_tokens_token_version_nonnegative
  CHECK ("tokenVersion" >= 0);
