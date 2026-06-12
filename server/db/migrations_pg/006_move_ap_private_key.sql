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
INSERT INTO user_ap_keys ("userId", "apPrivateKey", "createdAt", "updatedAt")
SELECT _id,
       "apPrivateKey",
       EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
       EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
FROM users
WHERE "apPrivateKey" IS NOT NULL
ON CONFLICT ("userId") DO NOTHING;

-- users tablosundan apPrivateKey sütununu kaldır
ALTER TABLE users DROP COLUMN IF EXISTS "apPrivateKey";

COMMIT;
