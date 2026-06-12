-- server/db/migrations_pg/005_session10_social_discover.sql
-- Session 10: Sosyal özellikler (rozetler) + Keşif güçlendirmesi (öne çıkan, kategori)
-- Bağımlılık: 004_session9_features.sql

-- ── 1. user_badges — kullanıcı rozet tablosu ─────────────────────────────────
CREATE TABLE IF NOT EXISTS user_badges (
  _id          TEXT PRIMARY KEY,
  "userId"     TEXT NOT NULL,
  badge        TEXT NOT NULL,           -- rozet tanımlayıcısı (bkz. BADGE_DEFS)
  label        TEXT NOT NULL DEFAULT '',
  icon         TEXT NOT NULL DEFAULT '',
  "awardedAt"  BIGINT NOT NULL,         -- epoch ms
  "awardedBy"  TEXT DEFAULT NULL,       -- admin userId ya da 'system'
  UNIQUE ("userId", badge)
);
CREATE INDEX IF NOT EXISTS idx_user_badges_user ON user_badges("userId");

COMMENT ON TABLE user_badges IS
  'Kullanıcılara verilen rozetler. badge sütunu BADGE_DEFS sabitindeki key ile eşleşir.';

-- ── 2. servers: featured + category kolonları ────────────────────────────────
ALTER TABLE servers
  ADD COLUMN IF NOT EXISTS featured     BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE servers
  ADD COLUMN IF NOT EXISTS "featuredAt" BIGINT DEFAULT NULL;

ALTER TABLE servers
  ADD COLUMN IF NOT EXISTS category     TEXT NOT NULL DEFAULT 'other';

-- Öne çıkan sunucular için index
CREATE INDEX IF NOT EXISTS idx_servers_featured
  ON servers(featured, "featuredAt" DESC)
  WHERE featured = TRUE;

-- Kategori filtreleme için index
CREATE INDEX IF NOT EXISTS idx_servers_category
  ON servers(category, discoverable);

COMMENT ON COLUMN servers.featured     IS 'Haftalık öne çıkan sunucu işareti (admin tarafından set edilir).';
COMMENT ON COLUMN servers."featuredAt" IS 'Öne çıkarılma zamanı (epoch ms). Sıralama için kullanılır.';
COMMENT ON COLUMN servers.category     IS 'Sunucu kategorisi: gaming, music, art, tech, edu, social, other';
