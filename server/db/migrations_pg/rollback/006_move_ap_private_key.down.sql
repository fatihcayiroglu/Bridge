-- Rollback migration 006: apPrivateKey kolonunu users tablosuna geri taşı
-- UYARI: Bu rollback veri kaybına yol açabilir — sadece acil durumlarda kullanın.
BEGIN;

-- users tablosuna apPrivateKey kolonunu geri ekle
ALTER TABLE users ADD COLUMN IF NOT EXISTS "apPrivateKey" TEXT;

-- user_ap_keys'teki plaintext verileri geri taşı (keyVersion=1 olanlar şifreli — taşınamaz)
-- Bu nedenle rollback sadece keyVersion=0 olan verileri taşır.
DO $$
DECLARE
  enc_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO enc_count FROM user_ap_keys WHERE "keyVersion" != 0;
  IF enc_count > 0 THEN
    RAISE WARNING
      '[migration-006-down] % şifreli kayıt var — bunlar taşınamaz ve kaybolacak. '
      'Şifrelenmemiş veriler için encrypt-ap-keys.js rollback gerekir.',
      enc_count;
  END IF;
END $$;

UPDATE users u
SET "apPrivateKey" = k."apPrivateKey"
FROM user_ap_keys k
WHERE u._id = k."userId"
  AND k."keyVersion" = 0;

DROP TABLE IF EXISTS user_ap_keys;

COMMIT;
