// server/db/fts.ts — PostgreSQL Full-Text Search helpers
//
// Sprint 41: SQLite FTS5 (better-sqlite3) tamamen kaldırıldı.
// PostgreSQL native tsvector/tsquery ile değiştirildi.
//
// Mimari notlar:
//   • Ana arama mantığı db/postgres/index.ts::ftsSearch() içinde yaşar;
//     bu dosya migration yardımcısını ve tip tanımlarını sağlar.
//   • messages tablosunda GIN index zaten schema.sql'de tanımlı:
//       idx_msg_content_fts  ON messages USING GIN(to_tsvector('simple', content))
//       idx_messages_fts     ON messages USING GIN(to_tsvector('simple', unaccent(...)))
//   • setupFTS() artık bir idempotent migration helper — uygulama
//     startup'ında ya da migration runner'dan çağrılabilir.

import type { Pool } from 'pg';

/**
 * PostgreSQL FTS migration helper.
 * GIN index ve unaccent extension'ı güvence altına alır.
 * Idempotent — birden fazla kez çalıştırılabilir.
 *
 * @param pool  - pg Pool instance (db._pool)
 */
export async function setupFTS(pool: Pool): Promise<void> {
  // unaccent extension — Türkçe karakter desteği için (ş→s, ğ→g, vb.)
  await pool.query(`CREATE EXTENSION IF NOT EXISTS unaccent`);

  // pg_trgm — trigram benzerlik araması (typo toleransı)
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

  // GIN index — zaten schema.sql'de var ama burada IF NOT EXISTS ile güvence altına al
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_messages_fts_combined
      ON messages
      USING GIN (
        to_tsvector('simple', coalesce(content, '') || ' ' || coalesce("displayName", ''))
      )
  `);

  // DM mesajları için de FTS index
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_dm_messages_fts
      ON dm_messages
      USING GIN (
        to_tsvector('simple', coalesce(content, ''))
      )
  `);
}

/**
 * PostgreSQL FTS arama — tsvector/tsquery tabanlı.
 *
 * Arama stratejisi (sırayla, fallback zinciri):
 *   1. websearch_to_tsquery   — tam özellikli (+, -, "phrase" desteği)
 *   2. prefix to_tsquery      — kısmi kelime eşleşmesi (e.g. "merha" → "merhaba")
 *   3. pg_trgm similarity     — typo toleransı
 *   4. ILIKE                  — son çare fallback
 *
 * Not: Ana implementasyon db/postgres/index.ts::ftsSearch()'tedir.
 * Bu wrapper db._ftsSearch'ü çağırmayan bağlamlarda (migration
 * scriptleri, test harness) doğrudan kullanılabilir.
 *
 * @param pool       - pg Pool instance
 * @param query      - arama terimi
 * @param serverIds  - kullanıcının üye olduğu sunucu ID'leri
 * @param limit      - maksimum sonuç sayısı
 */
export async function ftsSearch(
  pool: Pool,
  query: string,
  serverIds: string[],
  limit = 20,
): Promise<Record<string, unknown>[]> {
  if (!query?.trim() || !serverIds?.length) return [];

  const q = query.trim();

  // ── 1. websearch_to_tsquery ────────────────────────────────
  try {
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT m.*,
          ts_rank_cd(
            to_tsvector('simple', unaccent(coalesce(m.content,'') || ' ' || coalesce(m."displayName",''))),
            websearch_to_tsquery('simple', unaccent($2)),
            32
          )
          + CASE
              WHEN m."createdAt" > (extract(epoch from now() - interval '7 days') * 1000)::bigint
              THEN 0.1
              ELSE 0
            END
          AS _score
        FROM messages m
        WHERE m."serverId" = ANY($1)
          AND to_tsvector('simple', unaccent(coalesce(m.content,'') || ' ' || coalesce(m."displayName",'')))
              @@ websearch_to_tsquery('simple', unaccent($2))
        ORDER BY _score DESC, m."createdAt" DESC
        LIMIT $3`,
      [serverIds, q, limit],
    );
    if (rows.length > 0) return rows;
  } catch { /* syntax hatası → sonraki strateji */ }

  // ── 2. Prefix arama ───────────────────────────────────────
  try {
    const prefixTerms = q
      .split(/\s+/)
      .filter(Boolean)
      .map(w => `${w.replace(/[&|!():*]/g, ' ').trim()}:*`)
      .join(' & ');

    if (prefixTerms) {
      const { rows } = await pool.query<Record<string, unknown>>(
        `SELECT m.*
          FROM messages m
          WHERE m."serverId" = ANY($1)
            AND to_tsvector('simple', unaccent(coalesce(m.content,'') || ' ' || coalesce(m."displayName",'')))
                @@ to_tsquery('simple', unaccent($2))
          ORDER BY m."createdAt" DESC
          LIMIT $3`,
        [serverIds, prefixTerms, limit],
      );
      if (rows.length > 0) return rows;
    }
  } catch { /* prefix başarısız → sonraki */ }

  // ── 3. Trigram benzerliği ─────────────────────────────────
  try {
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT m.*,
          similarity(m.content, $2) AS _score
        FROM messages m
        WHERE m."serverId" = ANY($1)
          AND similarity(m.content, $2) > 0.2
        ORDER BY _score DESC, m."createdAt" DESC
        LIMIT $3`,
      [serverIds, q, limit],
    );
    if (rows.length > 0) return rows;
  } catch { /* pg_trgm yüklü değil → son fallback */ }

  // ── 4. ILIKE fallback ────────────────────────────────────
  const escaped = q.replace(/[%_\\]/g, c => `\\${c}`);
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT *
      FROM messages
      WHERE "serverId" = ANY($1)
        AND content ILIKE $2
      ORDER BY "createdAt" DESC
      LIMIT $3`,
    [serverIds, `%${escaped}%`, limit],
  );
  return rows;
}
