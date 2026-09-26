-- Migration 018 — Sprint 122: kod ile şema arasındaki kalan boşluklar
--
-- Bu üç alan uygulama kodunda kullanılıyordu ama şemada yoktu; sonuç olarak
-- ilgili işlemler çalışma zamanında hata veriyordu:
--
--   1) channels.nsfw        → routes/servers/channels.ts kanal oluştururken yazıyor
--                             (POST /api/servers/:sid/channels → HTTP 500)
--   2) messages.autoModAlert→ jobs/autoModeration.ts yazıyor ve sorguluyor
--                             ([AutoMod] Unknown column name hatası)
--   3) server_events.creator_id → 013'te "NOT NULL ... ON DELETE SET NULL" çelişkisi;
--                             kullanıcı silinince FK NULL yazmaya çalışıp hata verirdi.
--                             Etkinlik, oluşturanı silinse de yaşamalı → kolon NULLABLE.
--
-- Yeni kurulumlar 1 ve 2'yi db/postgres/schema.ts'ten, 3'ü düzeltilmiş 013'ten alır.

ALTER TABLE channels ADD COLUMN IF NOT EXISTS nsfw INTEGER NOT NULL DEFAULT 0;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS "autoModAlert" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE server_events ALTER COLUMN creator_id DROP NOT NULL;
