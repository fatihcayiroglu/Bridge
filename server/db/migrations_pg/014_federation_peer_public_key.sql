-- Migration 014: federation_peers.publicKey
-- ADR-0006 Faz 1: Per-peer RSA-2048 public key sütunu eklendi.
-- Nullable — geçiş döneminde mevcut peer'lar etkilenmez.
-- Sprint 108'de imza doğrulama katmanı bu sütunu kullanacak.

ALTER TABLE federation_peers
  ADD COLUMN IF NOT EXISTS "publicKey" TEXT;

COMMENT ON COLUMN federation_peers."publicKey" IS
  'RSA-2048 PEM public key. ADR-0006 Faz 1. Sprint 108+ imza doğrulamasında kullanılır.';
