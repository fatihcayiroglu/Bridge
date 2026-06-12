-- server/db/migrations_pg/004_session9_features.sql
-- Session 9: DM messages tablosuna readAt kolonu ekle
--
-- Session 8'deki 003_session8_features.sql, dm_conversations.readAt kolonunu ekledi
-- (konuşma bazlı okuma durumu — JSONB map).
-- Bu migration ise dm_messages tablosuna mesaj bazlı readAt ekler
-- (bireysel mesajın okunduğu zaman — TEXT / ISO 8601).

-- ── 1. dm_messages: mesaj bazlı readAt ───────────────────────────
ALTER TABLE dm_messages
  ADD COLUMN IF NOT EXISTS "readAt" TEXT DEFAULT NULL;

COMMENT ON COLUMN dm_messages."readAt" IS
  'Mesajın karşı tarafça okunduğu zaman (ISO 8601 timestamp veya ms epoch). NULL = okunmadı.';

-- ── 2. Index: okunmamış mesaj sorgusu için ────────────────────────
CREATE INDEX IF NOT EXISTS idx_dm_messages_dmid_readat
  ON dm_messages("dmId", "readAt");
