-- Migration 008: user_ap_keys.apPrivateKey → apPrivateKeyEnc (AES-256-GCM)
--
-- Bu migration iki şey yapar:
--   1. user_ap_keys tablosuna apPrivateKeyEnc + keyVersion sütunları ekler
--   2. Mevcut düz metin verileri Node.js scripti ile şifreler (aşağıya bak)
--
-- ÖNEMLİ: SQL tek başına yeterli değil — şifreleme Node.js'de yapılır.
-- Çalıştırma sırası:
--   psql -d bridge -f server/db/migrations_pg/008_encrypt_ap_private_keys.sql
--   node server/scripts/encrypt-ap-keys.js
--
-- AP_ENCRYPTION_KEY ortam değişkeni ayarlanmış olmalıdır.

BEGIN;

-- Yeni sütunları ekle
ALTER TABLE user_ap_keys
  ADD COLUMN IF NOT EXISTS "apPrivateKeyEnc" TEXT,
  ADD COLUMN IF NOT EXISTS "keyVersion"      INTEGER NOT NULL DEFAULT 0;

-- keyVersion=0 → şifrelenmemiş (eski veri), =1 → AES-256-GCM
-- Node.js scripti keyVersion=0 olan satırları işleyip keyVersion=1 yapacak.

COMMIT;

-- Şifreleme scripti çalıştıktan SONRA eski kolonu kaldır:
--   ALTER TABLE user_ap_keys DROP COLUMN IF EXISTS "apPrivateKey";
--
-- Script: server/scripts/encrypt-ap-keys.js
