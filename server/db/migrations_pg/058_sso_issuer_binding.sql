-- 058_sso_issuer_binding.sql
-- A provider subject is unique only inside its issuer/entity-ID namespace.
-- Historical rows are quarantined rather than guessed; the SSO route upgrades
-- them only when an operator explicitly names the trusted legacy authority.

ALTER TABLE users ADD COLUMN IF NOT EXISTS "ssoIssuer" TEXT;

UPDATE users
   SET "ssoIssuer" = 'legacy:' || "ssoProvider"
 WHERE "ssoProvider" IS NOT NULL
   AND "ssoId" IS NOT NULL
   AND "ssoIssuer" IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM users
     WHERE (("ssoProvider" IS NULL) <> ("ssoIssuer" IS NULL))
        OR (("ssoProvider" IS NULL) <> ("ssoId" IS NULL))
        OR ("ssoProvider" IS NOT NULL AND "ssoProvider" NOT IN ('oidc', 'saml'))
        OR ("ssoIssuer" IS NOT NULL AND char_length("ssoIssuer") NOT BETWEEN 1 AND 2048)
        OR ("ssoId" IS NOT NULL AND char_length("ssoId") NOT BETWEEN 1 AND 1024)
  ) THEN
    RAISE EXCEPTION '058: incomplete or invalid issuer-scoped SSO identity; repair explicitly before migration';
  END IF;

  IF EXISTS (
    SELECT 1 FROM users
     WHERE "ssoProvider" IS NOT NULL
     GROUP BY "ssoProvider", "ssoIssuer", "ssoId"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '058: duplicate issuer-scoped SSO identity; repair explicitly before migration';
  END IF;
END $$;

DROP INDEX IF EXISTS idx_users_sso_identity_unique;
DROP INDEX IF EXISTS idx_users_sso_provider_subject_unique;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_sso_binding_valid;
ALTER TABLE users ADD CONSTRAINT users_sso_binding_valid CHECK (
  (("ssoProvider" IS NULL) = ("ssoIssuer" IS NULL))
  AND (("ssoProvider" IS NULL) = ("ssoId" IS NULL))
  AND ("ssoProvider" IS NULL OR "ssoProvider" IN ('oidc', 'saml'))
  AND ("ssoIssuer" IS NULL OR char_length("ssoIssuer") BETWEEN 1 AND 2048)
  AND ("ssoId" IS NULL OR char_length("ssoId") BETWEEN 1 AND 1024)
);
CREATE UNIQUE INDEX idx_users_sso_identity_unique
  ON users("ssoProvider", "ssoIssuer", "ssoId")
  WHERE "ssoProvider" IS NOT NULL;
