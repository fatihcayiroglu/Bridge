-- 044_privacy_domain_constraints.sql
--
-- ════════════════════════════════════════════════════════════════════════════
-- users."dmPrivacy" VE users."presenceVisibility" ALAN KISITLARI
-- ════════════════════════════════════════════════════════════════════════════
-- ÖLÇÜLEN KUSUR (canlı PostgreSQL üzerinde doğrulandı, varsayılmadı):
--
--   TAZE KURULUM      (db/postgres/index.ts)            -> users CHECK: YOK
--   TAM DAĞITIM       (index.ts + migrate-postgres up)  -> users CHECK: YOK
--   INSERT "dmPrivacy"='nobody'            -> KABUL EDİLDİ
--   INSERT "presenceVisibility"='Hidden'   -> KABUL EDİLDİ
--
-- NEDEN: `017` ve `026` kısıtı `ADD COLUMN IF NOT EXISTS ... CHECK (...)` ile
-- tanımlıyordu. Ama sütunları `db/postgres/schema.ts` DAHA ÖNCE oluşturuyor,
-- dolayısıyla `IF NOT EXISTS` dalı hiç çalışmıyor ve kısıt HİÇ oluşmuyordu.
-- İki migration da "uygulandı" olarak işaretleniyordu.
--
-- ÜRÜN ETKİSİ: alan dışı bir değer yalnızca "kirli veri" değildi. DM
-- kontrolleri `if (p && p !== 'everyone') { if (p === 'none') … }` biçimindeydi;
-- `'None'` ya da `'nobody'` HİÇBİR dala girmez ve sessizce İZİN VERİLİRDİ —
-- kullanıcının koyduğu gizlilik kısıtı fark edilmeden kalkardı (FAIL-OPEN).
-- Okuma tarafı `lib/userUtils.ts` içindeki kanonik normalleştiriciye taşındı;
-- bu migration da yeni çöp yazılmasını veritabanı düzeyinde engeller.
--
-- ── NEDEN `NOT VALID` + KOŞULLU `VALIDATE` ────────────────────────────────
-- Doğrudan `ADD CONSTRAINT ... CHECK` tüm tabloyu tarar ve TEK bir uyumsuz
-- satır varsa DAĞITIMI DÜŞÜRÜR. `NOT VALID` ise:
--   · YENİ ve GÜNCELLENEN satırlar için kısıtı ANINDA uygular,
--   · mevcut satırları taramaz (kilit süresi kısa),
--   · veriyi DEĞİŞTİRMEZ.
-- Sonra satırlar denetlenir; TEMİZSE `VALIDATE CONSTRAINT` ile kısıt tam
-- geçerli hale gelir. Uyumsuz satır varsa kısıt NOT VALID kalır ve bir UYARI
-- basılır.
--
-- ── VERİ NEDEN NORMALLEŞTİRİLMİYOR ────────────────────────────────────────
-- `'nobody'` değerinin `'none'` mü yoksa `'everyone'` mı demek istediği
-- BİLİNEMEZ. Tahmin etmek, kullanıcının hiç seçmediği bir gizlilik ayarını
-- dayatmak (ya da kaldırmak) olurdu. Anlamı belirsiz kullanıcı verisi sessizce
-- yeniden yazılmaz; bunun yerine sayılır ve raporlanır.
--
-- Idempotenttir: tekrar tekrar çalıştırılabilir.

DO $$
DECLARE
  bad_dm       BIGINT;
  bad_presence BIGINT;
BEGIN
  -- ── 1. Kısıtları NOT VALID olarak ekle (yeni yazmalar anında korunur) ────
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid
     WHERE r.relname = 'users' AND c.conname = 'users_dmPrivacy_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT "users_dmPrivacy_check"
      CHECK ("dmPrivacy" IN ('everyone', 'friends', 'none')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid
     WHERE r.relname = 'users' AND c.conname = 'users_presenceVisibility_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT "users_presenceVisibility_check"
      CHECK ("presenceVisibility" IN ('visible', 'hidden')) NOT VALID;
  END IF;

  -- ── 2. Mevcut satırları DENETLE (değiştirme) ────────────────────────────
  SELECT count(*) INTO bad_dm
    FROM users WHERE "dmPrivacy" IS NULL OR "dmPrivacy" NOT IN ('everyone', 'friends', 'none');
  SELECT count(*) INTO bad_presence
    FROM users WHERE "presenceVisibility" IS NULL OR "presenceVisibility" NOT IN ('visible', 'hidden');

  -- ── 3. Yalnızca TEMİZSE doğrula ─────────────────────────────────────────
  IF bad_dm = 0 THEN
    ALTER TABLE users VALIDATE CONSTRAINT "users_dmPrivacy_check";
  ELSE
    RAISE WARNING
      '[044] users."dmPrivacy" alan disi % satir iceriyor. Kisit NOT VALID birakildi: yeni yazmalar korunuyor, mevcut satirlar DEGISTIRILMEDI. Denetleyin: SELECT _id, "dmPrivacy" FROM users WHERE "dmPrivacy" NOT IN (''everyone'',''friends'',''none''); duzeltince: ALTER TABLE users VALIDATE CONSTRAINT "users_dmPrivacy_check";',
      bad_dm;
  END IF;

  IF bad_presence = 0 THEN
    ALTER TABLE users VALIDATE CONSTRAINT "users_presenceVisibility_check";
  ELSE
    RAISE WARNING
      '[044] users."presenceVisibility" alan disi % satir iceriyor. Kisit NOT VALID birakildi; mevcut satirlar DEGISTIRILMEDI. Duzeltince: ALTER TABLE users VALIDATE CONSTRAINT "users_presenceVisibility_check";',
      bad_presence;
  END IF;
END $$;
