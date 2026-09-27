-- rollback/017_sprint122_dm_privacy.down.sql
-- Sprint 122: DM gizlilik tercihini geri al.
--
-- VERİ KAYBI UYARISI: kullanıcıların seçtiği 'friends' / 'none' tercihleri bu
-- sütunla birlikte silinir. Geri alma sonrası tüm kullanıcılar örtük olarak
-- 'everyone' davranışına döner. Bu, migration'ın kendisinin tersidir; ileri
-- yönde varsayılan zaten 'everyone' idi.

BEGIN;

ALTER TABLE users DROP COLUMN IF EXISTS "dmPrivacy";

COMMIT;
