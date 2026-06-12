-- Sprint 121 FIX 2/5/13: messages tablosuna eksik sütunlar eklendi
-- Yeni kurulumlar schema.sql'den alır; mevcut kurulumlar bu migration'ı çalıştırır.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS "avatarUrl"         TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS "editedAt"          BIGINT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS embeds              JSONB;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS "encryptedContent"  TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS iv                  TEXT;

-- Sprint 121 FIX: refresh_token index'leri (eski kurulumlar için)
CREATE INDEX IF NOT EXISTS idx_rt_family  ON refresh_tokens(family) WHERE family IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rt_cleanup ON refresh_tokens(used, "usedAt") WHERE used = 1;

-- Sprint 121 FIX 15: servers tablosuna mfaLevel eklendi
ALTER TABLE servers ADD COLUMN IF NOT EXISTS "mfaLevel" INTEGER NOT NULL DEFAULT 0;

-- Sprint 121 FIX 17: messages tablosuna soft delete alanları
ALTER TABLE messages ADD COLUMN IF NOT EXISTS "deletedAt" BIGINT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS "deletedBy" TEXT;
