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

-- Güvenlik guard'ları — yalnızca düz metin kolonu GERÇEKTEN varsa anlamlıdır.
--
-- Idempotency: taze kurulumlarda user_ap_keys en baştan modern şemayla
-- ("apPrivateKeyEnc") oluşur; "apPrivateKey" hiç var olmaz. Guard sorguları
-- bu kolonu okuduğu için migration "column does not exist" ile düşüyor ve
-- zinciri 009'da durduruyordu.
--
-- Kolon varsa → iki kontrol de aynen çalışır (şifrelenmemiş veri varsa ABORT).
-- Kolon yoksa → silinecek düz metin veri de yoktur, kontroller atlanır.
DO $$
DECLARE
  unencrypted_count INTEGER;
  missing_enc       INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'user_ap_keys'
       AND column_name  = 'apPrivateKey'
  ) THEN
    -- 1) Şifrelenmemiş kayıt kaldıysa abort et
    EXECUTE $chk$
      SELECT COUNT(*) FROM user_ap_keys
       WHERE ("keyVersion" = 0 OR "keyVersion" IS NULL)
         AND "apPrivateKey" IS NOT NULL
    $chk$ INTO unencrypted_count;

    IF unencrypted_count > 0 THEN
      RAISE EXCEPTION
        '[migration-009] ABORT: % kayıt hâlâ şifrelenmemiş (keyVersion=0). '
        'Önce encrypt-ap-keys.js scriptini çalıştırın.',
        unencrypted_count;
    END IF;

    -- 2) Tüm kayıtların apPrivateKeyEnc dolu olduğunu doğrula
    SELECT COUNT(*) INTO missing_enc
      FROM user_ap_keys
     WHERE "apPrivateKeyEnc" IS NULL;

    IF missing_enc > 0 THEN
      RAISE EXCEPTION
        '[migration-009] ABORT: % kayıtta apPrivateKeyEnc NULL. Şifreleme tamamlanmamış.',
        missing_enc;
    END IF;
  ELSE
    RAISE NOTICE '[migration-009] user_ap_keys."apPrivateKey" yok — plaintext kontrolleri atlandı (taze kurulum).';
  END IF;
END $$;

-- Her iki kontrol geçildiyse eski düz metin kolonu kaldır
ALTER TABLE user_ap_keys DROP COLUMN IF EXISTS "apPrivateKey";

-- apPrivateKeyEnc'e NOT NULL constraint ekle (artık tek kaynak)
ALTER TABLE user_ap_keys ALTER COLUMN "apPrivateKeyEnc" SET NOT NULL;

-- keyVersion DEFAULT'u da kanonik degere cekilir.
-- 008 sutunu `DEFAULT 0` ile eklemisti ("henuz sifrelenmemis" anlaminda) ve
-- asagidaki CHECK 0'i YASAKLIYOR. Temiz kurulum (db/postgres/schema.ts) ayni
-- sutunu `DEFAULT 1` ile yaratir. Iki yol ayrisirsa migration ile kurulmus bir
-- veritabaninda keyVersion belirtmeyen her INSERT chk_key_version'i ihlal eder,
-- ve tam bir rollback+re-up semayi temiz kurulumdan farkli birakirdi.
ALTER TABLE user_ap_keys ALTER COLUMN "keyVersion" SET DEFAULT 1;

-- keyVersion'a CHECK constraint ekle: yalnızca bilinen şifreleme versiyonları geçerli
-- keyVersion=1 → AES-256-GCM (mevcut)
-- İleride yeni algoritma eklenirse bu constraint güncellenerek migration ile yayılır.
ALTER TABLE user_ap_keys
  ADD CONSTRAINT chk_key_version CHECK ("keyVersion" IN (1));

COMMIT;
