-- Rollback migration 008: apPrivateKeyEnc + keyVersion kolonlarını kaldır
-- UYARI: Bu rollback şifreli verileri siler. Önce plain-text yedek alın.
BEGIN;

DO $$
DECLARE
  enc_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO enc_count
  FROM user_ap_keys
  WHERE "keyVersion" = 1 AND "apPrivateKeyEnc" IS NOT NULL;

  IF enc_count > 0 THEN
    RAISE WARNING
      '[migration-008-down] % şifreli kayıt silinecek. '
      'Bu işlem geri alınamaz — devam etmeden önce yedek alın.',
      enc_count;
  END IF;
END $$;

ALTER TABLE user_ap_keys DROP COLUMN IF EXISTS "apPrivateKeyEnc";
ALTER TABLE user_ap_keys DROP COLUMN IF EXISTS "keyVersion";

COMMIT;
