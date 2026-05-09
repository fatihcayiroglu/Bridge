-- db/sqlite/migrations/003_session9_features.sql
-- Session 9: DM okuma durumu (readAt) kolonu ekle
-- Bu migration yalnızca SQLite içindir; PostgreSQL için migrations_pg/004_session9_features.sql kullanılır.

-- ── Adım 1: Tablo yoksa oluştur (readAt dahil) ────────────────────
-- CREATE önce gelir: tablo hiç yokken ALTER TABLE çalışamaz.
CREATE TABLE IF NOT EXISTS dm_messages (
  _id       TEXT PRIMARY KEY,
  dmId      TEXT NOT NULL,
  userId    TEXT,
  content   TEXT,
  createdAt INTEGER,
  readAt    TEXT DEFAULT NULL
);

-- ── Adım 2: Tablo zaten varsa readAt kolonunu ekle ────────────────
-- SQLite'ta "ADD COLUMN IF NOT EXISTS" desteklenmez.
-- Migration sistemi bu satırı yalnızca bir kez çalıştırır;
-- kolonu zaten olan DB'de "duplicate column" hatası alınır — bu beklenen davranıştır.
ALTER TABLE dm_messages ADD COLUMN readAt TEXT DEFAULT NULL;

-- ── Adım 3: Index ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_dm_messages_dmId_readAt
  ON dm_messages(dmId, readAt);
