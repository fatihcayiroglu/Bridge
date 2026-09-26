-- Migration 021 — Sticker paketi kalıcılığı
-- Çalıştır: npm run db:migrate:pg
--
-- ÖNCE: paketler `routes/sticker-packs.ts` içindeki modül seviyesi bir Map'te
-- tutuluyordu (serverId → paketler). Süreç yeniden başladığında tüm sticker
-- paketleri kayboluyordu; çok süreçli çalışmada süreçler birbirinden ayrışıyordu.
--
-- SONRA: iki normal ilişkisel tablo. Genel API sözleşmesi DEĞİŞMEZ.
--
-- DAHİLİ SÜTUNLAR (API'ye asla sızdırılmaz):
--   sticker_packs.seq        — belirlenimci ekleme sırası. `createdAt` tek başına
--                              yeterli değildir: aynı milisaniyede iki paket
--                              oluşturulabilir. BIGSERIAL eşzamanlılıkta da
--                              tekil ve monoton kalır.
--   sticker_pack_items.position — yükleme dizisindeki sıra. Tek bir istek
--                              içinde atandığı için yarış koşulu yoktur.
--
-- TEKİLLİK YOKTUR: mevcut API yinelenen paket/sticker adlarına izin verir;
-- kısıt eklemek sözleşmeyi kanıtsız güçlendirirdi.

BEGIN;

CREATE TABLE IF NOT EXISTS sticker_packs (
  _id           TEXT   PRIMARY KEY,
  "serverId"    TEXT   NOT NULL,
  name          TEXT   NOT NULL,
  description   TEXT   NOT NULL DEFAULT '',
  "authorId"    TEXT   NOT NULL,
  "createdAt"   BIGINT NOT NULL,
  seq           BIGSERIAL
);

-- sticker_pack_items'ta serverId sütunu YOKTUR: her sticker işlemi önce
-- (packId + serverId) ile çözülen bir pakete bağlanır, bu yüzden sütun hiçbir
-- sorguda yüklem olarak kullanılmazdı.
CREATE TABLE IF NOT EXISTS sticker_pack_items (
  _id         TEXT    PRIMARY KEY,
  "packId"    TEXT    NOT NULL REFERENCES sticker_packs(_id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  url         TEXT    NOT NULL,
  tags        JSONB   NOT NULL DEFAULT '[]',
  width       INTEGER NOT NULL DEFAULT 160,
  height      INTEGER NOT NULL DEFAULT 160,
  position    INTEGER NOT NULL DEFAULT 0,
  "createdAt" BIGINT  NOT NULL
);

-- Yalnızca sorgu ile gerekçelendirilen iki indeks.
-- 1) Listeleme: WHERE "serverId" = $1 ORDER BY seq   (+ sunucu silme temizliği)
CREATE INDEX IF NOT EXISTS idx_sticker_packs_server ON sticker_packs("serverId", seq);
-- 2) Öğe getirme: WHERE "packId" = ANY($1) ORDER BY position
--    Ayrıca FK cascade aramasına hizmet eder — PostgreSQL FK sütunlarını
--    kendiliğinden indekslemez.
CREATE INDEX IF NOT EXISTS idx_sticker_items_pack ON sticker_pack_items("packId", position);

COMMIT;
