-- Rollback for 040_outgoing_webhook_schema_closure.sql
--
-- ── DUZELTILDI: idx_ogwh_server HIC DUSURULMUYORDU ─────────────────────────
-- 040'in `up` betigi uc sutun EKLER ve `idx_ogwh_server` indeksini olusturur.
-- Bu geri alma betigi yalnizca uc sutunu dusuruyordu; indeks geride kaliyordu.
-- Onceki dogrulayici bunu GOREMIYORDU: `up` yeniden uygulandiginda indeksi
-- zaten `IF NOT EXISTS` ile geri olusturuyor, dolayisiyla once/sonra
-- karsilastirmasi ayni cikiyordu. DOWN_INCOMPLETE denetimi bunu yakaladi.
--
-- Indeks once dusurulur: sutunlar ustunde degil ("serverId") uzerinde
-- oldugundan sira zorunlu degil, ama okunurluk icin acik tutuldu.
DROP INDEX IF EXISTS idx_ogwh_server;

ALTER TABLE outgoing_webhooks DROP COLUMN IF EXISTS "lastError";
ALTER TABLE outgoing_webhooks DROP COLUMN IF EXISTS "lastFailedAt";
ALTER TABLE outgoing_webhooks DROP COLUMN IF EXISTS "consecutiveFailures";
