-- rollback/029_member_ban_column.down.sql
-- Üye yasaklama sütununu geri al.
--
-- VERİ KAYBI UYARISI: mevcut yasaklar silinir. Geri alma sonrası yasaklı
-- üyeler yeniden erişim kazanır — bu bir GÜVENLİK GEVŞEMESİDİR ve yalnızca
-- yasakları başka bir yerde koruyan bir plan varsa uygulanmalıdır.

BEGIN;

DROP INDEX IF EXISTS idx_members_banned;
ALTER TABLE members DROP COLUMN IF EXISTS banned;

COMMIT;
