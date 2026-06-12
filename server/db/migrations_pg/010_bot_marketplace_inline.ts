// server/db/postgres/migrations_pg/010_bot_marketplace_inline.ts
// Sprint 83 — Bot Marketplace TypeScript sabitleri
//
// NEDEN AYRI DOSYA:
//   010_bot_marketplace.sql → pgMigrate / CLI araçlarıyla çalıştırılan SQL migration
//   010_bot_marketplace_inline.ts → migrations.ts EXTRA_TABLES dizisine spread edilen
//                                   TypeScript sabitleri (uygulama startup'ında çalışır)
//
//   İki dosya aynı numarayı paylaşır çünkü aynı özellik setine aittir.
//   "_inline" son eki bu farkı açıkça belirtir; bağımsız bir migration değildir.
//
// ENTEGRASYON (zaten yapıldı — referans için):
//   migrations.ts başındaki import'tan otomatik yüklenir:
//     import { BOT_MARKETPLACE_TABLES } from '../../migrations_pg/010_bot_marketplace_inline';
//   EXTRA_TABLES dizisine spread edilir:
//     ...BOT_MARKETPLACE_TABLES,

export const BOT_MARKETPLACE_TABLES: string[] = [
  // ── Ana katalog tablosu ─────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS bot_marketplace (
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
    rating           NUMERIC(3,2) NOT NULL DEFAULT 0,
    "ratingCount"    INTEGER NOT NULL DEFAULT 0,
    commands         JSONB NOT NULL DEFAULT '[]',
    permissions      JSONB NOT NULL DEFAULT '[]',
    changelog        TEXT NOT NULL DEFAULT '',
    "supportUrl"     TEXT NOT NULL DEFAULT '#',
    "sourceUrl"      TEXT NOT NULL DEFAULT '#',
    approved         BOOLEAN NOT NULL DEFAULT FALSE,
    "submittedBy"    TEXT,
    "createdAt"      BIGINT NOT NULL,
    "updatedAt"      BIGINT NOT NULL
  )`,

  // ── İndeksler ──────────────────────────────────────────────────────────
  `CREATE INDEX IF NOT EXISTS idx_bmp_category  ON bot_marketplace(category)`,
  `CREATE INDEX IF NOT EXISTS idx_bmp_approved  ON bot_marketplace(approved)`,
  `CREATE INDEX IF NOT EXISTS idx_bmp_featured  ON bot_marketplace(featured, installs DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_bmp_submitted ON bot_marketplace("submittedBy")`,
  `CREATE INDEX IF NOT EXISTS idx_bmp_tags      ON bot_marketplace USING GIN(tags)`,
  `CREATE INDEX IF NOT EXISTS idx_bmp_fts       ON bot_marketplace USING GIN(
    to_tsvector('simple',
      coalesce(name,'') || ' ' || coalesce(description,'')
    )
  )`,

  // ── Onay audit log tablosu ────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS bot_marketplace_reviews (
    _id          TEXT PRIMARY KEY,
    "botId"      TEXT NOT NULL REFERENCES bot_marketplace(id) ON DELETE CASCADE,
    "reviewerId" TEXT NOT NULL,
    action       TEXT NOT NULL,
    note         TEXT NOT NULL DEFAULT '',
    "createdAt"  BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bmp_reviews_bot ON bot_marketplace_reviews("botId")`,
];
