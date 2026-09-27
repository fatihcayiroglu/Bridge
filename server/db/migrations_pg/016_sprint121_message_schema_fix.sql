-- Sprint 121 FIX 2/5/13: messages tablosuna eksik sütunlar eklendi
--
-- DÜZELTME (Sprint 122): eski yorum "yeni kurulumlar schema.sql'den alır" diyordu;
-- schema.sql hiç çalıştırılmıyor. Yeni kurulumlar db/postgres/schema.ts'ten alır ve
-- bu sütunlar oraya da eklendi. Bu migration mevcut kurulumlar için gereklidir.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS "avatarUrl"         TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS "editedAt"          BIGINT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS embeds              JSONB;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS "encryptedContent"  TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS iv                  TEXT;

-- Sprint 121 FIX: refresh_token index'leri (eski kurulumlar için)
CREATE INDEX IF NOT EXISTS idx_rt_family  ON refresh_tokens(family) WHERE family IS NOT NULL;
-- refresh_tokens.used bu şemada BOOLEAN'dır; "used = 1" (integer) partial index
-- predicate'i "operator does not exist: boolean = integer" ile patlıyordu.
CREATE INDEX IF NOT EXISTS idx_rt_cleanup ON refresh_tokens(used, "usedAt") WHERE used = TRUE;

-- Sprint 121 FIX 15: servers tablosuna mfaLevel eklendi
ALTER TABLE servers ADD COLUMN IF NOT EXISTS "mfaLevel" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE servers DROP CONSTRAINT IF EXISTS servers_mfa_level_check;
ALTER TABLE servers ADD CONSTRAINT servers_mfa_level_check
  CHECK ("mfaLevel" IN (0, 1, 2));

-- Sprint 121 FIX 17: messages tablosuna soft delete alanları
ALTER TABLE messages ADD COLUMN IF NOT EXISTS "deletedAt" BIGINT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS "deletedBy" TEXT;
