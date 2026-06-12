-- Migration 009: user_ap_keys.apPrivateKey (düz metin) kolonunu kaldır
--
-- ÖNKOŞUL: Migration 008 + encrypt-ap-keys.js çalıştırılmış olmalıdır.
-- Tüm kayıtların keyVersion=1 olduğunu doğrula, sonra bu migration'ı çalıştır.
--
-- Güvenlik kontrolü: keyVersion=0 veya NULL olan kayıt varsa migration HATA verir.
-- Bu sayede şifrelenmemiş veri varken eski kolon silinemez.
--
-- Çalıştırma:
--   psql -d bridge -f server/db/migrations_pg/009_drop_ap_private_key_plaintext.sql

BEGIN;

-- Güvenlik guard: şifrelenmemiş kayıt kaldıysa abort et
DO $$
DECLARE
  unencrypted_count INTEGER;
BEGIN
  SELECT COUNT(*)
    INTO unencrypted_count
    FROM user_ap_keys
   WHERE ("keyVersion" = 0 OR "keyVersion" IS NULL)
     AND "apPrivateKey" IS NOT NULL;

  IF unencrypted_count > 0 THEN
    RAISE EXCEPTION
      '[migration-009] ABORT: % kayıt hâlâ şifrelenmemiş (keyVersion=0). '
      'Önce encrypt-ap-keys.js scriptini çalıştırın.',
      unencrypted_count;
  END IF;
END $$;

-- Tüm kayıtların apPrivateKeyEnc dolu olduğunu doğrula
DO $$
DECLARE
  missing_enc INTEGER;
BEGIN
  SELECT COUNT(*)
    INTO missing_enc
    FROM user_ap_keys
   WHERE "apPrivateKeyEnc" IS NULL;

  IF missing_enc > 0 THEN
    RAISE EXCEPTION
      '[migration-009] ABORT: % kayıtta apPrivateKeyEnc NULL. Şifreleme tamamlanmamış.',
      missing_enc;
  END IF;
END $$;

-- Her iki kontrol geçildiyse eski düz metin kolonu kaldır
ALTER TABLE user_ap_keys DROP COLUMN IF EXISTS "apPrivateKey";

-- apPrivateKeyEnc'e NOT NULL constraint ekle (artık tek kaynak)
ALTER TABLE user_ap_keys ALTER COLUMN "apPrivateKeyEnc" SET NOT NULL;

-- keyVersion'a CHECK constraint ekle: yalnızca bilinen şifreleme versiyonları geçerli
-- keyVersion=1 → AES-256-GCM (mevcut)
-- İleride yeni algoritma eklenirse bu constraint güncellenerek migration ile yayılır.
ALTER TABLE user_ap_keys
  ADD CONSTRAINT chk_key_version CHECK ("keyVersion" IN (1));

COMMIT;
