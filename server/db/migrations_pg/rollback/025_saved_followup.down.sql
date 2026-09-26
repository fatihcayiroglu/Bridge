-- rollback/025_saved_followup.down.sql
-- Kaydedilen mesajlar tablosunu geri al.
--
-- VERİ KAYBI UYARISI: kullanıcıların kaydettiği mesaj işaretleri silinir.
-- Mesajların KENDİSİ etkilenmez; yalnızca kaydetme kayıtları düşer.

BEGIN;

DROP INDEX IF EXISTS idx_saved_messages_owner_created;
DROP INDEX IF EXISTS idx_saved_messages_owner_target;
DROP TABLE IF EXISTS saved_messages;

COMMIT;
