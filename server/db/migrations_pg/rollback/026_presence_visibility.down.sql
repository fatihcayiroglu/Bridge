-- rollback/026_presence_visibility.down.sql
-- Presence görünürlük tercihini geri al.
--
-- VERİ KAYBI UYARISI: 'hidden' seçmiş kullanıcıların tercihi silinir ve
-- geri alma sonrası herkes örtük olarak 'visible' olur. Gizlilik yönünde
-- GEVŞEME anlamına gelir; geri alma bilinçli bir karar olmalıdır.

BEGIN;

ALTER TABLE users DROP COLUMN IF EXISTS "presenceVisibility";

COMMIT;
