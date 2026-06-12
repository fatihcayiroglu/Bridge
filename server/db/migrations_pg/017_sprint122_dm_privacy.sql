-- Migration 017: Sprint 122 — DM Gizlilik Politikası
-- users tablosuna dmPrivacy alanı eklenir.
-- Değerler: 'everyone' (varsayılan) | 'friends' | 'none'
--
-- 'everyone' → herkesten DM kabul et (Discord varsayılanı)
-- 'friends'  → yalnızca karşılıklı kabul edilmiş arkadaşlar
-- 'none'     → kimse DM gönderemiyor (kullanıcı kendisi başlatabilir)
--
-- Geri alma: rollback/017_rollback.sql

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS "dmPrivacy" TEXT NOT NULL DEFAULT 'everyone'
  CHECK ("dmPrivacy" IN ('everyone', 'friends', 'none'));

COMMENT ON COLUMN users."dmPrivacy" IS
  'DM gizlilik politikası: everyone | friends | none';

-- Mevcut kullanıcılar varsayılan olarak ''everyone'' alır (non-breaking)
