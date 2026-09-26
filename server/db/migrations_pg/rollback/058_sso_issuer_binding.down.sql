-- Rollback 058. Refuse to collapse issuer namespaces when doing so would make
-- two distinct identities share the former provider/subject unique key.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM users
     WHERE "ssoProvider" IS NOT NULL
     GROUP BY "ssoProvider", "ssoId"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '058 rollback: issuer namespaces contain duplicate provider/subject bindings';
  END IF;
END $$;

DROP INDEX IF EXISTS idx_users_sso_identity_unique;
DROP INDEX IF EXISTS idx_users_sso_provider_subject_unique;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_sso_binding_valid;
ALTER TABLE users DROP COLUMN IF EXISTS "ssoIssuer";
ALTER TABLE users ADD CONSTRAINT users_sso_binding_valid CHECK (
  (("ssoProvider" IS NULL) = ("ssoId" IS NULL))
  AND ("ssoProvider" IS NULL OR "ssoProvider" IN ('oidc', 'saml'))
  AND ("ssoId" IS NULL OR char_length("ssoId") BETWEEN 1 AND 1024)
);
CREATE UNIQUE INDEX idx_users_sso_provider_subject_unique
  ON users("ssoProvider", "ssoId")
  WHERE "ssoProvider" IS NOT NULL;
