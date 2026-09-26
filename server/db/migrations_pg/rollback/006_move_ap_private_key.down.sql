-- Rollback migration 006: apPrivateKey kolonunu users tablosuna geri taşı
-- UYARI: Bu rollback veri kaybına yol açabilir — sadece acil durumlarda kullanın.
--
-- ════════════════════════════════════════════════════════════════════════════
-- DÜZELTİLDİ: BU BETİK DAHA SONRAKİ BİR MIGRATION'IN SÜTUNUNA BAĞLIYDI
-- ════════════════════════════════════════════════════════════════════════════
-- ÖLÇÜLEN KUSUR (sıralı zincir geri alma ile bulundu): betik `keyVersion`
-- sütununu KOŞULSUZ okuyordu. O sütunun sahibi 006 değil,
-- `008_encrypt_ap_private_keys` migration'ıdır. Sıralı geri almada 008 önce
-- geri alınıp sütunu düşürür; ardından 006'nın geri alması patlıyordu:
--
--     ❌ Rollback başarısız: 006_move_ap_private_key.sql
--        column "keyVersion" does not exist
--
-- Yani TÜM ZİNCİRİN geri alınması 006'da duruyordu — 44 migration'ın 38'i
-- geri alındıktan sonra. Tek tek ölçümde belirti farklıydı
-- (`column k.apPrivateKey does not exist`, çünkü orada 009 henüz geri
-- alınmamıştı); iki belirtinin kökü aynı: bir geri alma betiği YALNIZCA kendi
-- migration'ının oluşturduğu şemaya dayanmalıdır.
--
-- ÇÖZÜM: `keyVersion` varlığı çalışma anında denetlenir. Sütun yoksa (008
-- zaten geri alınmış) hiçbir satır şifreli olamaz — 008 ÖNCESİ durum tam
-- olarak budur — ve tümü geri taşınır. Sütun varsa eski davranış AYNEN korunur:
-- yalnızca `keyVersion = 0` satırları taşınır, şifreliler için uyarı basılır.
BEGIN;

-- users tablosuna apPrivateKey kolonunu geri ekle
ALTER TABLE users ADD COLUMN IF NOT EXISTS "apPrivateKey" TEXT;

-- user_ap_keys'teki plaintext verileri geri taşı (keyVersion=1 olanlar şifreli — taşınamaz)
DO $$
DECLARE
  enc_count   INTEGER;
  has_version BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'user_ap_keys'
       AND column_name  = 'keyVersion'
  ) INTO has_version;

  IF has_version THEN
    EXECUTE 'SELECT COUNT(*) FROM user_ap_keys WHERE "keyVersion" <> 0' INTO enc_count;
    IF enc_count > 0 THEN
      RAISE WARNING
        '[migration-006-down] % sifreli kayit var - bunlar tasinamaz ve kaybolacak. '
        'Sifrelenmemis veriler icin encrypt-ap-keys.js rollback gerekir.',
        enc_count;
    END IF;

    EXECUTE $mig$
      UPDATE users u
         SET "apPrivateKey" = k."apPrivateKey"
        FROM user_ap_keys k
       WHERE u._id = k."userId"
         AND k."keyVersion" = 0
    $mig$;
  ELSE
    EXECUTE $mig$
      UPDATE users u
         SET "apPrivateKey" = k."apPrivateKey"
        FROM user_ap_keys k
       WHERE u._id = k."userId"
    $mig$;
  END IF;
END $$;

DROP TABLE IF EXISTS user_ap_keys;

COMMIT;
