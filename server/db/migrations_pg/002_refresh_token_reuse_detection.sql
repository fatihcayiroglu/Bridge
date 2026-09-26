-- Migration 002: Add token reuse detection columns to refresh_tokens
-- Required for auth.js token family / reuse detection to work correctly.
--
-- ════════════════════════════════════════════════════════════════════════════
-- `used` TİPİ DÜZELTİLDİ: SMALLINT -> BOOLEAN
-- ════════════════════════════════════════════════════════════════════════════
-- ÖLÇÜLEN KUSUR (rollback doğrulayıcısı ortaya çıkardı): bu migration `used`
-- sütununu SMALLINT olarak tanımlıyordu, oysa kanonik şema BOOLEAN diyor:
--
--     db/postgres/schema.ts:60   used BOOLEAN NOT NULL DEFAULT FALSE
--
-- Taze kurulumda `schema.ts` sütunu ÖNCE oluşturduğu için buradaki
-- `ADD COLUMN IF NOT EXISTS` hiç çalışmıyor ve çelişki görünmüyordu. Ama
-- sütunun önceden var olmadığı her yolda SMALLINT kazanıyordu ve üretim kodu
-- BOOLEAN yazıyor:
--
--     db/repositories/AuthRepository.ts:129
--         SET used = TRUE, "usedAt" = $2, family = $3
--
-- SMALLINT bir sütuna `TRUE` yazmak PostgreSQL'de hata verir. Yani yenileme
-- jetonu ROTASYONU — replay tespitinin dayandığı yol — bozulurdu.
--
-- Aynı çelişki `016_sprint121_message_schema_fix` migration'ının YENİDEN
-- UYGULANMASINI da imkânsız kılıyordu:
--
--     CREATE INDEX ... ON refresh_tokens(used, "usedAt") WHERE used = TRUE;
--     ERROR: operator does not exist: smallint = boolean
--
-- `AuthRepository.ts:97`teki `row.used === true || row.used === 1` savunması
-- da bu sürüklenmenin izidir.
--
-- Zaten uygulanmış veritabanları etkilenmez: migration yeniden koşmaz ve
-- koşsa bile `IF NOT EXISTS` hiçbir şey yapmaz.
ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS used       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "usedAt"   BIGINT,
  ADD COLUMN IF NOT EXISTS family     TEXT;

-- Kısmi indeks: kanonik tanım `db/postgres/schema.ts:64` ile AYNI. Önceden
-- burada koşulsuz bir indeks vardı; iki kaynak aynı adı farklı tanımla
-- oluşturuyordu ve hangisinin kazandığı yalnızca çalışma sırasına bağlıydı.
CREATE INDEX IF NOT EXISTS idx_rt_family ON refresh_tokens(family) WHERE family IS NOT NULL;
