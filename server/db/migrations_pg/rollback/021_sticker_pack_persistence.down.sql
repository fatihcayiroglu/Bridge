-- Rollback 021 — Sticker paketi kalıcılığı
--
-- UYARI: BU İŞLEM VERİ SİLER. Tabloları düşürmek kalıcı tüm sticker
-- paketlerini ve öğelerini yok eder. Geri alma yalnızca özelliğin tümüyle
-- kaldırılması durumunda anlamlıdır.
--
-- Yüklenmiş sticker dosyaları (uploads/stickers/) bu betikle SİLİNMEZ;
-- satırlar gidince sahipsiz kalırlar.

BEGIN;

-- Önce çocuk tablo: FK bağımlılığı bu sırayı zorunlu kılar.
-- (sticker_packs düşürülseydi CASCADE gerekirdi; açık sıra daha güvenlidir.)
DROP TABLE IF EXISTS sticker_pack_items;
DROP TABLE IF EXISTS sticker_packs;

COMMIT;
