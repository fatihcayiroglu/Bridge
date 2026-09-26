-- Migration 019 — Sprint 122: channels.bitrate
--
-- routes/servers/channels.ts kanal oluştururken bitrate yazıyor
-- (ses kanalları için 8000-384000, metin kanalları için varsayılan 64000),
-- ancak kolon şemada yoktu → POST /api/servers/:sid/channels HTTP 500.
--
-- 018'de nsfw düzeltilmişti; bitrate aynı insert'te bir sonraki eksik alandı.
-- Yeni kurulumlar db/postgres/schema.ts'ten alır.

ALTER TABLE channels ADD COLUMN IF NOT EXISTS bitrate INTEGER NOT NULL DEFAULT 64000;
