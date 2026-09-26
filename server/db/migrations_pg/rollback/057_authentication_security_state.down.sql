-- Rollback 057. This is an exact schema rollback when WebAuthn counters still
-- fit the former signed INTEGER domain. Refuse a lossy narrowing otherwise.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM webauthn_credentials WHERE counter > 2147483647) THEN
    RAISE EXCEPTION '057 rollback: WebAuthn counters exceed INTEGER; refusing lossy type narrowing';
  END IF;
END $$;

DROP INDEX IF EXISTS idx_users_sso_identity_unique;
DROP INDEX IF EXISTS idx_users_sso_provider_subject_unique;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_x3dh_bundle_valid;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_x3dh_otpks_array_check;
ALTER TABLE users ADD CONSTRAINT users_x3dh_otpks_array_check
  CHECK (jsonb_typeof("x3dhOneTimePreKeys") = 'array');
DROP FUNCTION IF EXISTS bridge_valid_x3dh_otpks(jsonb);
DROP FUNCTION IF EXISTS bridge_valid_x3dh_signed_prekey(jsonb);
ALTER TABLE webauthn_credentials DROP CONSTRAINT IF EXISTS webauthn_counter_uint32;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_sso_binding_valid;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_two_factor_state_valid;
DROP FUNCTION IF EXISTS bridge_valid_two_factor_backup(jsonb);
DROP FUNCTION IF EXISTS bridge_valid_totp_secret(text);
-- Migration 052 owns the refresh-token issuance-version invariant. 057
-- temporarily reasserts it while hardening the authentication domain, so a
-- rollback to the 056 schema must restore (not remove) the 052 constraint.
ALTER TABLE refresh_tokens DROP CONSTRAINT IF EXISTS refresh_tokens_token_version_nonnegative;
ALTER TABLE refresh_tokens ADD CONSTRAINT refresh_tokens_token_version_nonnegative
  CHECK ("tokenVersion" >= 0);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_token_version_nonnegative;
ALTER TABLE webauthn_credentials ALTER COLUMN counter TYPE INTEGER USING counter::integer;
ALTER TABLE users DROP COLUMN IF EXISTS "twoFactorLastUsedStep";
