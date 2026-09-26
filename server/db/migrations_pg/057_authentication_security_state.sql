-- 057_authentication_security_state.sql
-- Durable replay/security invariants shared by TOTP, WebAuthn, refresh tokens,
-- and external SSO identity binding. Invalid historical security state is not
-- guessed or repaired: the operator must audit it explicitly.

ALTER TABLE users ADD COLUMN IF NOT EXISTS "twoFactorLastUsedStep" BIGINT;

CREATE OR REPLACE FUNCTION bridge_valid_totp_secret(value text)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT char_length(value) BETWEEN 16 AND 134
     AND value ~ '^[A-Za-z2-7]{16,128}={0,6}$'
$$;

CREATE OR REPLACE FUNCTION bridge_valid_two_factor_backup(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE item jsonb; code text;
BEGIN
  IF jsonb_typeof(value) <> 'array' OR jsonb_array_length(value) > 32 THEN RETURN FALSE; END IF;
  FOR item IN
    SELECT value_item
    FROM jsonb_array_elements(value) AS items(value_item)
  LOOP
    IF jsonb_typeof(item) <> 'string' THEN RETURN FALSE; END IF;
    code := item #>> '{}';
    IF char_length(code) NOT BETWEEN 8 AND 128 THEN RETURN FALSE; END IF;
  END LOOP;
  RETURN TRUE;
END $$;

DO $$
DECLARE has_sso_issuer boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'ssoIssuer'
  ) INTO has_sso_issuer;
  IF EXISTS (SELECT 1 FROM users WHERE "tokenVersion" IS NULL OR "tokenVersion" < 0) THEN
    RAISE EXCEPTION '057: negative users.tokenVersion; repair explicitly before migration';
  END IF;
  IF EXISTS (SELECT 1 FROM refresh_tokens WHERE "tokenVersion" IS NULL OR "tokenVersion" < 0) THEN
    RAISE EXCEPTION '057: negative refresh_tokens.tokenVersion; revoke or repair explicitly before migration';
  END IF;
  IF EXISTS (
    SELECT 1 FROM users
     WHERE "twoFactorEnabled" IS NULL OR "twoFactorBackup" IS NULL
        OR "twoFactorLastUsedStep" < 0
        OR bridge_valid_two_factor_backup("twoFactorBackup") IS NOT TRUE
        OR ("twoFactorEnabled" AND bridge_valid_totp_secret("twoFactorSecret") IS NOT TRUE)
  ) THEN
    RAISE EXCEPTION '057: invalid persisted two-factor state; repair explicitly before migration';
  END IF;
  IF has_sso_issuer THEN
    IF EXISTS (
      SELECT 1 FROM users u
       WHERE ((u."ssoProvider" IS NULL) <> ((to_jsonb(u)->>'ssoIssuer') IS NULL))
          OR ((u."ssoProvider" IS NULL) <> (u."ssoId" IS NULL))
          OR (u."ssoProvider" IS NOT NULL AND u."ssoProvider" NOT IN ('oidc', 'saml'))
          OR ((to_jsonb(u)->>'ssoIssuer') IS NOT NULL AND char_length(to_jsonb(u)->>'ssoIssuer') NOT BETWEEN 1 AND 2048)
          OR (u."ssoId" IS NOT NULL AND char_length(u."ssoId") NOT BETWEEN 1 AND 1024)
    ) THEN
      RAISE EXCEPTION '057: incomplete or invalid issuer-scoped SSO identity binding; repair explicitly before migration';
    END IF;
    IF EXISTS (
      SELECT 1 FROM users u
       WHERE u."ssoProvider" IS NOT NULL
       GROUP BY u."ssoProvider", (to_jsonb(u)->>'ssoIssuer'), u."ssoId"
      HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION '057: duplicate issuer-scoped SSO identity binding; repair explicitly before migration';
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1 FROM users
       WHERE ("ssoProvider" IS NULL) <> ("ssoId" IS NULL)
          OR ("ssoProvider" IS NOT NULL AND "ssoProvider" NOT IN ('oidc', 'saml'))
          OR ("ssoId" IS NOT NULL AND char_length("ssoId") NOT BETWEEN 1 AND 1024)
    ) THEN
      RAISE EXCEPTION '057: incomplete or invalid SSO identity binding; repair explicitly before migration';
    END IF;
    IF EXISTS (
      SELECT 1 FROM users
       WHERE "ssoProvider" IS NOT NULL
       GROUP BY "ssoProvider", "ssoId"
      HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION '057: duplicate SSO provider/subject binding; repair explicitly before migration';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM webauthn_credentials WHERE counter IS NULL OR counter < 0 OR counter > 4294967295) THEN
    RAISE EXCEPTION '057: WebAuthn counter is outside the unsigned 32-bit authenticator domain';
  END IF;
END $$;

ALTER TABLE webauthn_credentials ALTER COLUMN counter TYPE BIGINT USING counter::bigint;
ALTER TABLE webauthn_credentials ALTER COLUMN counter SET DEFAULT 0;
ALTER TABLE webauthn_credentials ALTER COLUMN counter SET NOT NULL;

ALTER TABLE users ALTER COLUMN "tokenVersion" SET DEFAULT 0;
ALTER TABLE users ALTER COLUMN "tokenVersion" SET NOT NULL;
ALTER TABLE users ALTER COLUMN "twoFactorEnabled" SET DEFAULT FALSE;
ALTER TABLE users ALTER COLUMN "twoFactorEnabled" SET NOT NULL;
ALTER TABLE users ALTER COLUMN "twoFactorBackup" SET DEFAULT '[]'::jsonb;
ALTER TABLE users ALTER COLUMN "twoFactorBackup" SET NOT NULL;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_token_version_nonnegative;
ALTER TABLE users ADD CONSTRAINT users_token_version_nonnegative CHECK ("tokenVersion" >= 0);
ALTER TABLE refresh_tokens DROP CONSTRAINT IF EXISTS refresh_tokens_token_version_nonnegative;
ALTER TABLE refresh_tokens ADD CONSTRAINT refresh_tokens_token_version_nonnegative CHECK ("tokenVersion" >= 0);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_two_factor_state_valid;
ALTER TABLE users ADD CONSTRAINT users_two_factor_state_valid CHECK (
  ("twoFactorLastUsedStep" IS NULL OR "twoFactorLastUsedStep" >= 0)
  AND bridge_valid_two_factor_backup("twoFactorBackup") IS TRUE
  AND (NOT "twoFactorEnabled" OR bridge_valid_totp_secret("twoFactorSecret") IS TRUE)
);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_sso_binding_valid;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'ssoIssuer'
  ) THEN
    EXECUTE $sql$ALTER TABLE users ADD CONSTRAINT users_sso_binding_valid CHECK (
      (("ssoProvider" IS NULL) = ("ssoIssuer" IS NULL))
      AND (("ssoProvider" IS NULL) = ("ssoId" IS NULL))
      AND ("ssoProvider" IS NULL OR "ssoProvider" IN ('oidc', 'saml'))
      AND ("ssoIssuer" IS NULL OR char_length("ssoIssuer") BETWEEN 1 AND 2048)
      AND ("ssoId" IS NULL OR char_length("ssoId") BETWEEN 1 AND 1024)
    )$sql$;
  ELSE
    ALTER TABLE users ADD CONSTRAINT users_sso_binding_valid CHECK (
      (("ssoProvider" IS NULL) = ("ssoId" IS NULL))
      AND ("ssoProvider" IS NULL OR "ssoProvider" IN ('oidc', 'saml'))
      AND ("ssoId" IS NULL OR char_length("ssoId") BETWEEN 1 AND 1024)
    );
  END IF;
END $$;
ALTER TABLE webauthn_credentials DROP CONSTRAINT IF EXISTS webauthn_counter_uint32;
ALTER TABLE webauthn_credentials ADD CONSTRAINT webauthn_counter_uint32
  CHECK (counter BETWEEN 0 AND 4294967295);

DROP INDEX IF EXISTS idx_users_sso_provider_subject_unique;
DROP INDEX IF EXISTS idx_users_sso_identity_unique;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'ssoIssuer'
  ) THEN
    CREATE UNIQUE INDEX idx_users_sso_identity_unique
      ON users("ssoProvider", "ssoIssuer", "ssoId") WHERE "ssoProvider" IS NOT NULL;
  ELSE
    CREATE UNIQUE INDEX idx_users_sso_provider_subject_unique
      ON users("ssoProvider", "ssoId") WHERE "ssoProvider" IS NOT NULL;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION bridge_valid_x3dh_signed_prekey(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE key_id_text text;
BEGIN
  IF jsonb_typeof(value) <> 'object'
     OR value - 'keyId' - 'publicKey' - 'signature' <> '{}'::jsonb
     OR jsonb_typeof(value->'keyId') <> 'number'
     OR jsonb_typeof(value->'publicKey') <> 'string'
     OR jsonb_typeof(value->'signature') <> 'string' THEN
    RETURN FALSE;
  END IF;
  key_id_text := value->>'keyId';
  RETURN key_id_text ~ '^(0|[1-9][0-9]{0,9})$'
     AND key_id_text::bigint <= 2147483647
     AND char_length(value->>'publicKey') BETWEEN 1 AND 256
     AND char_length(value->>'signature') BETWEEN 1 AND 512;
END $$;

CREATE OR REPLACE FUNCTION bridge_valid_x3dh_otpks(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  item jsonb;
  key_id_text text;
  key_id bigint;
  public_key text;
  seen_ids bigint[] := ARRAY[]::bigint[];
  seen_keys text[] := ARRAY[]::text[];
BEGIN
  IF jsonb_typeof(value) <> 'array' OR jsonb_array_length(value) > 100 THEN RETURN FALSE; END IF;
  FOR item IN
    SELECT value_item
    FROM jsonb_array_elements(value) AS items(value_item)
  LOOP
    IF jsonb_typeof(item) <> 'object'
       OR item - 'keyId' - 'publicKey' <> '{}'::jsonb
       OR jsonb_typeof(item->'keyId') <> 'number'
       OR jsonb_typeof(item->'publicKey') <> 'string' THEN RETURN FALSE; END IF;
    key_id_text := item->>'keyId';
    IF key_id_text !~ '^(0|[1-9][0-9]{0,9})$' THEN RETURN FALSE; END IF;
    key_id := key_id_text::bigint;
    public_key := item->>'publicKey';
    IF key_id > 2147483647 OR char_length(public_key) NOT BETWEEN 1 AND 256
       OR key_id = ANY(seen_ids) OR public_key = ANY(seen_keys) THEN RETURN FALSE; END IF;
    seen_ids := array_append(seen_ids, key_id);
    seen_keys := array_append(seen_keys, public_key);
  END LOOP;
  RETURN TRUE;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM users
     WHERE bridge_valid_x3dh_otpks("x3dhOneTimePreKeys") IS NOT TRUE
        OR ("x3dhSignedPreKey" IS NOT NULL AND NOT bridge_valid_x3dh_signed_prekey("x3dhSignedPreKey"))
        OR ("x3dhIdentityKey" IS NOT NULL AND char_length("x3dhIdentityKey") NOT BETWEEN 1 AND 256)
  ) THEN
    RAISE EXCEPTION '057: malformed or duplicate persisted X3DH bundle; repair explicitly before migration';
  END IF;
END $$;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_x3dh_otpks_array_check;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_x3dh_bundle_valid;
ALTER TABLE users ADD CONSTRAINT users_x3dh_bundle_valid CHECK (
  bridge_valid_x3dh_otpks("x3dhOneTimePreKeys") IS TRUE
  AND ("x3dhSignedPreKey" IS NULL OR bridge_valid_x3dh_signed_prekey("x3dhSignedPreKey"))
  AND ("x3dhIdentityKey" IS NULL OR char_length("x3dhIdentityKey") BETWEEN 1 AND 256)
);
