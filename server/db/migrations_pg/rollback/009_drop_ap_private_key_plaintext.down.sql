-- Rollback migration 009: apPrivateKey kolonunu geri ekle
-- NOT: Kolon silindikten sonra veri geri getirilemez.
-- Bu rollback sadece kolonu yeniden oluşturur — veriler yoktur.
BEGIN;

ALTER TABLE user_ap_keys ADD COLUMN IF NOT EXISTS "apPrivateKey" TEXT;

-- NOT NULL constraint kaldır (009 tarafından eklenmişti)
ALTER TABLE user_ap_keys ALTER COLUMN "apPrivateKeyEnc" DROP NOT NULL;

-- keyVersion CHECK constraint kaldır
ALTER TABLE user_ap_keys DROP CONSTRAINT IF EXISTS chk_key_version;

COMMIT;
