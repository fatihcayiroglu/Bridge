-- server/db/migrations_pg/003_session8_features.sql
-- Session 8: DM Okundu Bilgisi + Canvas kalıcı depolama (opsiyonel)

-- ══════════════════════════════════════════════════════════════════
-- 1. DM Conversations: readAt kolonu ekle
--    Mevcut tablo adı: dm_conversations (ya da prizma şemasına göre)
--    readAt: { userId: timestamp } map'i JSONB olarak
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE dm_conversations
  ADD COLUMN IF NOT EXISTS "readAt" JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN dm_conversations."readAt" IS
  'userId → timestamp map: son mesajın okunduğu zaman';

-- ══════════════════════════════════════════════════════════════════
-- 2. Canvas: Kalıcı kanvas depolama (opsiyonel — server memory yeterli)
--    Production'da sunucu restart'ta kaybolmaması için aktif edilebilir.
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS canvas_strokes (
  id          TEXT        PRIMARY KEY,
  "channelId" TEXT        NOT NULL,
  tool        TEXT        NOT NULL DEFAULT 'pen',
  color       TEXT        NOT NULL DEFAULT '#ffffff',
  width       INT         NOT NULL DEFAULT 2,
  points      JSONB       NOT NULL DEFAULT '[]',
  text        TEXT,
  "userId"    TEXT        NOT NULL,
  "displayName" TEXT,
  ts          BIGINT      NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
);

CREATE INDEX IF NOT EXISTS idx_canvas_channel ON canvas_strokes("channelId");
CREATE INDEX IF NOT EXISTS idx_canvas_ts       ON canvas_strokes(ts);

COMMENT ON TABLE canvas_strokes IS
  'Kanal bazlı ortak çizim tahtası stroke kayıtları';
