// server/db/postgres/fts.ts
// Full-Text Search — PostgreSQL native FTS ile mesaj arama.
//
// Strateji (en iyiden fallback'e):
//   1. websearch_to_tsquery  → "merhaba dünya" -hariç +zorunlu gibi Discord-benzeri syntax
//   2. to_tsquery prefix     → kısmi kelime (merhab:* → merhaba eşleşir)
//   3. pg_trgm similarity   → typo toleransı (meraba → merhaba)
//   4. ILIKE                 → son çare fallback
//
// Skor hesabı:
//   ts_rank_cd: konum ağırlıklı rank (başta geçen → yüksek skor)
//   recency bonus: son 7 günlük mesajlara +0.1 bonus

import { pool } from './pool';

export async function ftsSearch(
  queryText: string,
  serverIds: string[],
  limit = 50,
): Promise<Record<string, unknown>[]> {
  if (!queryText?.trim() || !serverIds?.length) return [];

  const q = queryText.trim();

  // ── 1. websearch_to_tsquery (tam özellikli arama) ─────────
  try {
    const { rows } = await pool.query(
      `
      SELECT m.*,
        ts_rank_cd(
          to_tsvector('simple', unaccent(coalesce(m.content,'') || ' ' || coalesce(m."displayName",''))),
          websearch_to_tsquery('simple', unaccent($2)),
          32
        )
        + CASE WHEN m."createdAt" > (extract(epoch from now()-interval '7 days')*1000)::bigint
               THEN 0.1 ELSE 0 END
        AS _score
      FROM messages m
      WHERE m."serverId" = ANY($1)
        AND to_tsvector('simple', unaccent(coalesce(m.content,'') || ' ' || coalesce(m."displayName",'')))
            @@ websearch_to_tsquery('simple', unaccent($2))
      ORDER BY _score DESC, m."createdAt" DESC
      LIMIT $3
      `,
      [serverIds, q, limit],
    );
    if (rows.length > 0) return rows;
  } catch (_) { /* syntax hatası → sonraki strateji */ }

  // ── 2. Prefix arama (kısmi kelime desteği) ────────────────
  try {
    const prefixQ = q
      .split(/\s+/)
      .filter(Boolean)
      .map(w => w.replace(/[^\w\u00C0-\u024F]/g, '') + ':*')
      .join(' & ');

    if (prefixQ) {
      const { rows } = await pool.query(
        `
        SELECT m.*,
          ts_rank_cd(
            to_tsvector('simple', unaccent(coalesce(m.content,'') || ' ' || coalesce(m."displayName",''))),
            to_tsquery('simple', unaccent($2)),
            32
          ) AS _score
        FROM messages m
        WHERE m."serverId" = ANY($1)
          AND to_tsvector('simple', unaccent(coalesce(m.content,'') || ' ' || coalesce(m."displayName",'')))
              @@ to_tsquery('simple', unaccent($2))
        ORDER BY _score DESC, m."createdAt" DESC
        LIMIT $3
        `,
        [serverIds, prefixQ, limit],
      );
      if (rows.length > 0) return rows;
    }
  } catch (_) { /* fallback */ }

  // ── 3. Trigram similarity (typo toleransı) ────────────────
  try {
    const { rows } = await pool.query(
      `
      SELECT m.*, similarity(m.content, $2) AS _score
      FROM messages m
      WHERE m."serverId" = ANY($1)
        AND m.content % $2
      ORDER BY _score DESC, m."createdAt" DESC
      LIMIT $3
      `,
      [serverIds, q, limit],
    );
    if (rows.length > 0) return rows;
  } catch (_) { /* pg_trgm kurulu değilse fallback */ }

  // ── 4. ILIKE fallback (son çare) ──────────────────────────
  const escaped = q.replace(/[%_\\]/g, c => `\\${c}`);
  const { rows } = await pool.query(
    `
    SELECT m.*
    FROM messages m
    WHERE m."serverId" = ANY($1)
      AND m.content ILIKE $2
    ORDER BY m."createdAt" DESC
    LIMIT $3
    `,
    [serverIds, `%${escaped}%`, limit],
  );

  return rows;
}
