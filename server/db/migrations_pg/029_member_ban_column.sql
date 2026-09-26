-- ════════════════════════════════════════════════════════════════════════════
-- ÜYE YASAKLAMA — SÜTUN HİÇ YOKTU
-- ════════════════════════════════════════════════════════════════════════════
-- `MemberRepository` üç yerde `banned` alanını kullanıyordu:
--     findBans   → db.members.find({ serverId, banned: true })
--     insertBan  → db.members.insert({ ..., banned: true })
--     removeBan  → db.members.remove({ ..., banned: true })
--
-- Ama `members` tablosunda BÖYLE BİR SÜTUN YOKTU. Gerçek sütunlar:
--     joinedAt, roles, serverId, timeoutUntil, userId, verified
--
-- Sonuç: yasak listesi 500 döndürüyordu ve moderasyon sekmesi
-- "Ban listesi yüklenemedi (500)." gösteriyordu (ekran görüntüsüyle
-- doğrulandı). Yasaklama özelliği KALICI DEĞİLDİ — arayüzde "Yasakla"
-- düğmesi vardı ama veri katmanı yoktu.
--
-- pgCollection'ın sütun beyaz listesi hatayı DOĞRU biçimde yakalıyordu
-- (SQL enjeksiyonuna karşı koruma); eksik olan sütunun kendisiydi.
ALTER TABLE members
  ADD COLUMN IF NOT EXISTS banned BOOLEAN NOT NULL DEFAULT FALSE;

-- Yasaklı üyeler sık sorgulanır ve tablo geneline göre KÜÇÜK bir alt kümedir;
-- kısmi indeks hem küçük hem seçicidir.
CREATE INDEX IF NOT EXISTS idx_members_banned
  ON members("serverId") WHERE banned = TRUE;

COMMENT ON COLUMN members.banned IS
  'Üye bu sunucudan yasaklı mı. Yetki denetimi SUNUCUDA yapılır.';
