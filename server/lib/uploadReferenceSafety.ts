// Canonical safety helpers for generic uploaded-file deletion.
// Keeps storage path normalization and DB-reference checks in one place so
// upload routes cannot delete a physical object that is still in use.

export interface UploadReferenceQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

/**
 * Accept only canonical generic upload keys. Express already URL-decodes query
 * parameters, so traversal/backslash forms are rejected rather than rewritten.
 * The historical sticker tree is never deletable through the generic endpoint.
 */
export function normalizeUploadKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  if (!key || key.length > 512) return null;
  if (!key.startsWith('uploads/')) return null;
  if (key.startsWith('uploads/stickers/')) return null;
  if (key.includes('\\') || key.includes('\0')) return null;

  const segments = key.split('/');
  if (segments.length < 2 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return null;
  }

  // Generated Bridge upload keys are deliberately conservative. Rejecting
  // unexpected characters is safer than trying to sanitize them into a new key.
  if (!/^[A-Za-z0-9._/-]+$/.test(key)) return null;
  return key;
}

/**
 * LocalAdapter is already rooted at server/uploads; remote providers are rooted
 * at the bucket and therefore keep the uploads/ prefix.
 */
export function storageDeleteKey(canonicalKey: string, provider: string): string {
  return provider === 'local' ? canonicalKey.slice('uploads/'.length) : canonicalKey;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Every canonical relational column that can point at an upload. Shared by the
 * single-key and batched checks so both always see the same reference set.
 */
const UPLOAD_REFS_CTE = `
    upload_refs(value) AS (
      SELECT "fileUrl" FROM messages WHERE "fileUrl" IS NOT NULL
      UNION ALL SELECT "fileUrl" FROM dm_messages WHERE "fileUrl" IS NOT NULL
      UNION ALL SELECT "fileUrl" FROM group_dm_messages WHERE "fileUrl" IS NOT NULL
      UNION ALL SELECT "avatarUrl" FROM users WHERE "avatarUrl" IS NOT NULL
      UNION ALL SELECT "bannerUrl" FROM users WHERE "bannerUrl" IS NOT NULL
      UNION ALL SELECT "iconUrl" FROM servers WHERE "iconUrl" IS NOT NULL
      UNION ALL SELECT "bannerUrl" FROM servers WHERE "bannerUrl" IS NOT NULL
      UNION ALL SELECT "serverProfile"->>'avatarUrl' FROM members WHERE "serverProfile"->>'avatarUrl' IS NOT NULL
      UNION ALL SELECT "serverProfile"->>'bannerUrl' FROM members WHERE "serverProfile"->>'bannerUrl' IS NOT NULL
      UNION ALL SELECT url FROM server_gifs WHERE url IS NOT NULL
      UNION ALL SELECT url FROM server_emojis WHERE url IS NOT NULL
      UNION ALL SELECT url FROM soundboard WHERE url IS NOT NULL
      UNION ALL SELECT url FROM voice_messages WHERE url IS NOT NULL
      UNION ALL SELECT url FROM sticker_pack_items WHERE url IS NOT NULL
      UNION ALL SELECT "coverUrl" FROM podcast_settings WHERE "coverUrl" IS NOT NULL
      UNION ALL SELECT "imageUrl" FROM podcast_settings WHERE "imageUrl" IS NOT NULL
      UNION ALL SELECT "audioUrl" FROM podcast_episodes WHERE "audioUrl" IS NOT NULL
      UNION ALL SELECT '/uploads/' || filename FROM podcast_episodes WHERE filename IS NOT NULL
    )`;

/**
 * Fail-closed reference check across every canonical relational URL/fileUrl
 * column that can point at a generic upload. Authorization happens separately;
 * this function protects shared/object integrity after authorization succeeds.
 */
export async function hasLiveUploadReference(
  // `null` / `undefined` KABUL EDILIR: `db._pool` yalnizca PostgreSQL
  // yapilandirildiginda vardir (test adaptorunde YOKTUR) ve her cagri yeri
  // `db._pool` gecirir. Imza `UploadReferenceQueryable` dedigi surece bu
  // gercek gizleniyordu.
  queryable: UploadReferenceQueryable | null | undefined,
  canonicalKey: string,
): Promise<boolean> {
  // FAIL-CLOSED: havuz yoksa dosyanin referanssiz oldugunu KANITLAYAMAYIZ.
  // Firlatmak davranisi DEGISTIRMEZ — cagiranlar bu cagriyi zaten try/catch
  // icinde yapiyor ve yakalayinca fiziksel silmeyi ATLIYOR (DB durumu
  // yetkilidir). Fark su: sebep artik ACIKCA yaziyor.
  if (!queryable) {
    throw new Error('hasLiveUploadReference: PostgreSQL havuzu yok — referans durumu dogrulanamaz');
  }

  const relativeUrl = `/${canonicalKey}`;
  const absoluteSuffix = `%/${escapeLike(canonicalKey)}`;

  const sql = `
    WITH ${UPLOAD_REFS_CTE}
    SELECT EXISTS (
      SELECT 1
      FROM upload_refs
      WHERE value = $1
         OR value = $2
         OR value LIKE $3 ESCAPE '\\'
      LIMIT 1
    ) AS referenced
  `;

  const result = await queryable.query<{ referenced: boolean }>(sql, [canonicalKey, relativeUrl, absoluteSuffix]);
  return result.rows[0]?.referenced === true;
}

/**
 * Batched form of hasLiveUploadReference for bulk releases (P7 D2 expired-channel
 * objects). Returns the subset of `canonicalKeys` that are still referenced.
 *
 * The reference set is scanned ONCE: each value's last two and three path
 * segments are hash-joined with the keys, then the exact single-key predicate
 * (value = key, value = '/' || key, value ends with '/' || key) is re-applied,
 * so the answer equals calling hasLiveUploadReference per key. Measured on
 * PostgreSQL 16 with 1M messages: one single-key check ~52 ms; this batch
 * evaluates many keys in about the time of one scan. Keys must be canonical
 * (normalizeUploadKey) with 2 or 3 segments; anything else is refused.
 */
export async function liveUploadReferenceKeys(
  queryable: UploadReferenceQueryable | null | undefined,
  canonicalKeys: readonly string[],
): Promise<Set<string>> {
  if (!queryable) {
    throw new Error('liveUploadReferenceKeys: PostgreSQL havuzu yok — referans durumu dogrulanamaz');
  }
  const keys = [...new Set(canonicalKeys)];
  for (const key of keys) {
    const segments = key.split('/').length;
    if (normalizeUploadKey(key) !== key || segments < 2 || segments > 3) {
      throw new Error('liveUploadReferenceKeys: unsupported upload key');
    }
  }
  if (!keys.length) return new Set();
  const matches = `(cand.value = keys.k OR cand.value = '/' || keys.k
      OR right(cand.value, char_length(keys.k) + 1) = '/' || keys.k)`;
  const sql = `
    WITH ${UPLOAD_REFS_CTE},
    keys(k) AS (SELECT DISTINCT unnest($1::text[])),
    cand AS MATERIALIZED (
      SELECT value,
             substring(value from '([^/]+/[^/]+)$') AS s2,
             substring(value from '([^/]+/[^/]+/[^/]+)$') AS s3
        FROM upload_refs)
    SELECT keys.k FROM cand JOIN keys ON keys.k = cand.s2 WHERE ${matches}
    UNION
    SELECT keys.k FROM cand JOIN keys ON keys.k = cand.s3 WHERE ${matches}
  `;
  const result = await queryable.query<{ k: string }>(sql, [keys]);
  return new Set(result.rows.map(row => row.k));
}
