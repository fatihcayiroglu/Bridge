import { liveUploadReferenceKeys, normalizeUploadKey, type UploadReferenceQueryable } from './uploadReferenceSafety';

interface UploadReleaseClient extends UploadReferenceQueryable { release(): void }
interface UploadReleasePool extends UploadReferenceQueryable { connect(): Promise<UploadReleaseClient> }

/**
 * Reserve unreferenced keys BEFORE any storage operation. Reference writers
 * participate through migration 091's row locks. One scan still answers the
 * entire batch; durable reservations deny late references after COMMIT and
 * survive a crash or a failed storage request. Shared keys remain writable.
 */
export async function reserveUploadReleaseKeys(
  queryable: UploadReferenceQueryable | null | undefined, canonicalKeys: readonly string[],
): Promise<Set<string>> {
  const pool = queryable as Partial<UploadReleasePool> | null | undefined;
  if (!pool || typeof pool.connect !== 'function') throw new Error('Upload release requires a PostgreSQL transaction');
  const keys = [...new Set(canonicalKeys)].sort();
  for (const key of keys) {
    if (normalizeUploadKey(key) !== key || key.split('/').length > 3) throw new Error('Invalid upload release key');
  }
  if (!keys.length) return new Set();
  const client = await pool.connect();
  try {
    // The reference scan must see writers that committed while the reservation
    // UPSERT waited for them; do not inherit a repeatable-read pool default.
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query(`INSERT INTO upload_release_keys AS k (key, reserved)
      SELECT key, TRUE FROM unnest($1::text[]) AS key ORDER BY key
      ON CONFLICT (key) DO UPDATE SET reserved = TRUE`, [keys]);
    const referenced = await liveUploadReferenceKeys(client, keys);
    if (referenced.size) {
      await client.query('UPDATE upload_release_keys SET reserved = FALSE WHERE key = ANY($1::text[])', [[...referenced]]);
    }
    await client.query('COMMIT');
    return referenced;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
    throw error;
  } finally {
    client.release();
  }
}
