-- Migration 006: apPrivateKey'i ayrı tabloya taşı
-- Güvenlik: özel anahtar artık users SELECT * sorgularında dönmez.
-- apPublicKey users tablosunda kalır (federation actor endpoint için gerekli).
-- Çalıştırma: psql -d bridge -f server/db/migrations_pg/006_move_ap_private_key.sql

BEGIN;

CREATE TABLE IF NOT EXISTS user_ap_keys (
  "userId"       TEXT PRIMARY KEY REFERENCES users(_id) ON DELETE CASCADE,
  "apPrivateKey" TEXT NOT NULL,
  "createdAt"    BIGINT NOT NULL,
  "updatedAt"    BIGINT NOT NULL
);

-- Mevcut verileri taşı (apPrivateKey NULL olmayanlar)
--
-- Idempotency guard: taze kurulumlarda users."apPrivateKey" hiç var olmamıştır
-- (initSchema modern şemayı kurar ve anahtar user_ap_keys."apPrivateKeyEnc"
-- içinde tutulur). Guard olmadan bu INSERT ... SELECT "column does not exist"
-- hatası verip migration zincirini 006'da durduruyordu.
--
-- Kolon varsa  → taşıma aynen yapılır (eski kurulumların davranışı korunur).
-- Kolon yoksa  → blok sessizce atlanır.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'users'
       AND column_name  = 'apPrivateKey'
  ) THEN
    EXECUTE $mig$
      INSERT INTO user_ap_keys ("userId", "apPrivateKey", "createdAt", "updatedAt")
      SELECT _id,
             "apPrivateKey",
             EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
             EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
      FROM users
      WHERE "apPrivateKey" IS NOT NULL
      ON CONFLICT ("userId") DO NOTHING
    $mig$;
    RAISE NOTICE '[migration-006] apPrivateKey verileri user_ap_keys tablosuna taşındı.';
  ELSE
    RAISE NOTICE '[migration-006] users."apPrivateKey" yok — taşıma atlandı (taze kurulum).';
  END IF;
END $$;

-- users tablosundan apPrivateKey sütununu kaldır
ALTER TABLE users DROP COLUMN IF EXISTS "apPrivateKey";

COMMIT;
