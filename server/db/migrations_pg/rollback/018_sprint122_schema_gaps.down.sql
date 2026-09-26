-- rollback/018_sprint122_schema_gaps.down.sql
-- Sprint 122: şema boşluklarını geri al.
--
-- DİKKAT — `server_events.creator_id`: ileri yön `DROP NOT NULL` yaptı.
-- Tersi `SET NOT NULL`'dur ve sütunda NULL varsa PostgreSQL HATA VERİR.
-- Bu KASITLIDIR: sessizce satır silmek ya da uydurma bir değer yazmak
-- veri kaybı olurdu. Geri alma, veri gerçekten eski kısıta uyuyorsa geçer.

BEGIN;

ALTER TABLE server_events ALTER COLUMN creator_id SET NOT NULL;

ALTER TABLE messages DROP COLUMN IF EXISTS "autoModAlert";
ALTER TABLE channels DROP COLUMN IF EXISTS nsfw;

COMMIT;
