-- Migration 015: server_federation_keys
-- ADR-0006 Faz 1+2: Bridge instance RSA-2048 key çifti (private key şifreli)

BEGIN;

CREATE TABLE IF NOT EXISTS server_federation_keys (
  _id             TEXT PRIMARY KEY DEFAULT 'instance',
  "publicKeyPem"  TEXT NOT NULL,
  "privateKeyEnc" TEXT NOT NULL,
  "keyVersion"    INTEGER NOT NULL DEFAULT 1,
  "createdAt"     BIGINT NOT NULL,
  "rotatedAt"     BIGINT
);

COMMENT ON TABLE server_federation_keys IS
  'Bridge instance federation RSA key çifti. ADR-0006 Faz 1+2.';
COMMENT ON COLUMN server_federation_keys."privateKeyEnc" IS
  'AES-256-GCM şifreli PKCS#8 private key (apKeyEncryption formatı).';

COMMIT;
