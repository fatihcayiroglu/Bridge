-- Migration 020 — Sprint 122: channels."order" INTEGER → BIGINT
--
-- routes/servers/channels.ts:185 sıralama anahtarı olarak Date.now() yazıyor
-- (~1.79e12), INTEGER üst sınırı ise 2.147.483.647:
--   ERROR: value "1786570588342" is out of range for type integer
-- → kanal oluşturma HTTP 500.
--
-- Yalnızca genişletme (INTEGER → BIGINT); mevcut değerler ve sıralama korunur.
-- Yeni kurulumlar db/postgres/schema.ts'ten BIGINT olarak alır.

ALTER TABLE channels ALTER COLUMN "order" TYPE BIGINT;
