-- migrations_pg/010_bot_marketplace.sql
-- Sprint 83: Bot Marketplace kalıcı katalog tablosu
-- In-memory Map yerine PostgreSQL'e taşıma.
-- Her statement idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).

BEGIN;

-- ── Ana tablo ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bot_marketplace (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  author           TEXT NOT NULL,
  "authorVerified" BOOLEAN NOT NULL DEFAULT FALSE,
  avatar           TEXT NOT NULL DEFAULT '🤖',
  category         TEXT NOT NULL DEFAULT 'utility',
  tags             JSONB NOT NULL DEFAULT '[]',
  description      TEXT NOT NULL DEFAULT '',
  "longDescription" TEXT NOT NULL DEFAULT '',
  verified         BOOLEAN NOT NULL DEFAULT FALSE,
  featured         BOOLEAN NOT NULL DEFAULT FALSE,
  installs         INTEGER NOT NULL DEFAULT 0,
  rating           NUMERIC(3, 2) NOT NULL DEFAULT 0,
  "ratingCount"    INTEGER NOT NULL DEFAULT 0,
  commands         JSONB NOT NULL DEFAULT '[]',
  permissions      JSONB NOT NULL DEFAULT '[]',
  changelog        TEXT NOT NULL DEFAULT '',
  "supportUrl"     TEXT NOT NULL DEFAULT '#',
  "sourceUrl"      TEXT NOT NULL DEFAULT '#',
  approved         BOOLEAN NOT NULL DEFAULT FALSE,
  "submittedBy"    TEXT,                  -- FK users._id, NULL for seeded/builtin bots
  "createdAt"      BIGINT NOT NULL,       -- epoch ms
  "updatedAt"      BIGINT NOT NULL
);

-- ── İndeksler ──────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_bmp_category  ON bot_marketplace(category);
CREATE INDEX IF NOT EXISTS idx_bmp_approved  ON bot_marketplace(approved);
CREATE INDEX IF NOT EXISTS idx_bmp_featured  ON bot_marketplace(featured, installs DESC);
CREATE INDEX IF NOT EXISTS idx_bmp_submitted ON bot_marketplace("submittedBy");
-- Tags GIN: marketplace/?tags=müzik gibi JSONB @> sorgular için
CREATE INDEX IF NOT EXISTS idx_bmp_tags      ON bot_marketplace USING GIN(tags);
-- Full-text arama: name + description
CREATE INDEX IF NOT EXISTS idx_bmp_fts ON bot_marketplace USING GIN(
  to_tsvector('simple',
    coalesce(name, '') || ' ' || coalesce(description, '')
  )
);

-- ── Onay geçmişi (audit trail) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bot_marketplace_reviews (
  _id          TEXT PRIMARY KEY,
  "botId"      TEXT NOT NULL REFERENCES bot_marketplace(id) ON DELETE CASCADE,
  "reviewerId" TEXT NOT NULL,            -- admin userId
  action       TEXT NOT NULL,            -- 'approve' | 'reject' | 'feature' | 'unfeature'
  note         TEXT NOT NULL DEFAULT '',
  "createdAt"  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bmp_reviews_bot ON bot_marketplace_reviews("botId");

COMMIT;
