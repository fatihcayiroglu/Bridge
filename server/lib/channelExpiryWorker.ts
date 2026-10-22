/**
 * P7 D2: durable, multi-node channel expiry worker.
 *
 * Two phases, each in short transactions so a busy channel never holds a
 * long lock and a crash at any point is recovered by the next tick:
 *
 * 1. CLAIM (one transaction per channel). Lock ONE expired channel
 *    `FOR UPDATE SKIP LOCKED` (other nodes skip it), lock one surviving
 *    live sibling `FOR KEY SHARE SKIP LOCKED` (the server keeps a channel),
 *    write the durable tombstone and delete the channel row. From this
 *    commit on, reads deny (read preflights) and writes deny (migration 085
 *    write barrier); FK-cascaded rows go with the channel row.
 *    Lock order matches the write barrier: channel row first. A writer that
 *    already holds FOR KEY SHARE makes the claim skip the channel this tick.
 *
 * 2. CLEANUP (bounded batches). For every tombstone still `pending`, lock
 *    the tombstone row `FOR UPDATE SKIP LOCKED` and delete at most
 *    `batchSize` rows per channel-owned table. When a pass deletes nothing,
 *    the tombstone becomes `converged`. Deletes are idempotent, so retries,
 *    crashes and concurrent nodes are safe. Attachment files are released by
 *    the existing reference-based upload cleanup once no row references them.
 *
 * A server's last live channel is never claimed. The expiry API
 * (lib/channelExpiryConfig.ts) also keeps one permanent channel per server.
 */

export interface ExpiryQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
}
export interface ExpiryClient extends ExpiryQueryable { release(): void }
export interface ExpiryPool { connect(): Promise<ExpiryClient> }

const NOW_MS = 'FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT';

export const CLAIM_EXPIRED_CHANNEL_SQL = `
  SELECT c._id, c."serverId", c."expiresAt", c."expiryVersion"
    FROM channels c
   WHERE c."expiresAt" IS NOT NULL
     AND c."expiresAt" <= ${NOW_MS}
     AND c."expiryVersion" > 0
     AND EXISTS (
       SELECT 1 FROM channels s
        WHERE s."serverId" = c."serverId" AND s._id <> c._id
          AND (s."expiresAt" IS NULL OR s."expiresAt" > ${NOW_MS}))
   ORDER BY c."expiresAt", c._id
   LIMIT 1
   FOR UPDATE OF c SKIP LOCKED`;

export const LOCK_SURVIVOR_SQL = `
  SELECT _id FROM channels
   WHERE "serverId" = $1 AND _id <> $2
     AND ("expiresAt" IS NULL OR "expiresAt" > ${NOW_MS})
   LIMIT 1
   FOR KEY SHARE SKIP LOCKED`;

export const INSERT_TOMBSTONE_SQL = `
  INSERT INTO channel_expiry_tombstones
    ("channelId", "serverId", "expiredAt", "expiryVersion", "recordedAt", "cleanupState")
  VALUES ($1, $2, $3, $4, ${NOW_MS}, 'pending')
  ON CONFLICT ("channelId") DO NOTHING`;

/** Tables whose rows point at a channel from either side (edges). */
const EDGE_TABLES: ReadonlyArray<[string, ReadonlyArray<string>]> = [
  ['channel_bridges', ['sourceChannelId', 'targetChannelId']],
  ['channel_follows', ['sourceChannelId', 'targetChannelId']],
  ['crosspost_log', ['sourceChannelId', 'targetChannelId']],
];

export type ClaimOutcome =
  | { state: 'claimed'; channelId: string; serverId: string }
  | { state: 'none' };

/** Claim and tombstone at most one expired channel. */
export async function claimExpiredChannel(pool: ExpiryPool): Promise<ClaimOutcome> {
  const client = await pool.connect();
  let open = false;
  try {
    await client.query('BEGIN');
    open = true;
    const candidate = await client.query(CLAIM_EXPIRED_CHANNEL_SQL);
    const row = candidate.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      open = false;
      return { state: 'none' };
    }
    const channelId = String(row._id);
    const serverId = String(row.serverId);
    const survivor = await client.query(LOCK_SURVIVOR_SQL, [serverId, channelId]);
    if (!survivor.rows.length) {
      // The surviving sibling is being deleted or claimed right now; retry later.
      await client.query('ROLLBACK');
      open = false;
      return { state: 'none' };
    }
    await client.query(INSERT_TOMBSTONE_SQL, [channelId, serverId, row.expiresAt, row.expiryVersion]);
    await client.query('DELETE FROM channels WHERE _id = $1 AND "serverId" = $2', [channelId, serverId]);
    await client.query('COMMIT');
    open = false;
    return { state: 'claimed', channelId, serverId };
  } catch (err) {
    if (open) { try { await client.query('ROLLBACK'); } catch { /* keep original error */ } }
    throw err;
  } finally {
    client.release();
  }
}

/** Every table with a "channelId" column except channels and tombstones. */
async function channelOwnedTables(db: ExpiryQueryable): Promise<{ owned: string[]; edges: Array<[string, string[]]>; saved: boolean }> {
  const result = await db.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema()`);
  const cols = new Map<string, Set<string>>();
  for (const r of result.rows) {
    const t = String(r.table_name);
    if (!cols.has(t)) cols.set(t, new Set());
    cols.get(t)!.add(String(r.column_name));
  }
  const owned = [...cols.entries()]
    .filter(([t, c]) => c.has('channelId') && t !== 'channels' && t !== 'channel_expiry_tombstones')
    .map(([t]) => t)
    .sort();
  const edges = EDGE_TABLES
    .map(([t, candidates]) => [t, candidates.filter(c => cols.get(t)?.has(c))] as [string, string[]])
    .filter(([t, c]) => cols.has(t) && c.length > 0);
  const saved = cols.get('saved_messages')?.has('destinationType') === true &&
    cols.get('saved_messages')?.has('destinationId') === true;
  return { owned, edges, saved };
}

const quote = (identifier: string) => '"' + identifier.replace(/"/g, '""') + '"';

export type CleanupOutcome =
  | { state: 'progress'; channelId: string; deleted: number }
  | { state: 'converged'; channelId: string }
  | { state: 'none' };

/**
 * One bounded cleanup pass over the oldest pending tombstone that no other
 * node is processing. Deletes at most `batchSize` rows per table.
 */
export async function cleanupNextTombstone(pool: ExpiryPool, batchSize = 500): Promise<CleanupOutcome> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) throw new RangeError('Invalid cleanup batch size');
  const client = await pool.connect();
  let open = false;
  try {
    await client.query('BEGIN');
    open = true;
    const pending = await client.query(
      `SELECT "channelId" FROM channel_expiry_tombstones
        WHERE "cleanupState" = 'pending'
        ORDER BY "recordedAt", "channelId"
        LIMIT 1
        FOR UPDATE SKIP LOCKED`);
    const channelId = pending.rows[0]?.channelId;
    if (typeof channelId !== 'string') {
      await client.query('ROLLBACK');
      open = false;
      return { state: 'none' };
    }
    // Never touch a live channel that reuses the id (defensive: ids are UUIDs).
    const live = await client.query('SELECT 1 FROM channels WHERE _id = $1', [channelId]);
    if (live.rows.length) throw new Error('Tombstoned channel id still has a channel row');

    const { owned, edges, saved } = await channelOwnedTables(client);
    let deleted = 0;
    const batch = async (table: string, predicate: string, params: unknown[]) => {
      const r = await client.query(
        `DELETE FROM ${quote(table)} WHERE ctid = ANY(ARRAY(
           SELECT ctid FROM ${quote(table)} WHERE ${predicate} LIMIT ${batchSize}))`, params);
      deleted += r.rowCount ?? 0;
    };
    for (const [table, columns] of edges) {
      await batch(table, columns.map(c => `${quote(c)} = $1`).join(' OR '), [channelId]);
    }
    if (saved) await batch('saved_messages', `"destinationType" = 'channel' AND "destinationId" = $1`, [channelId]);
    for (const table of owned) await batch(table, '"channelId" = $1', [channelId]);

    if (deleted === 0) {
      await client.query(
        `UPDATE channel_expiry_tombstones SET "cleanupState" = 'converged'
          WHERE "channelId" = $1 AND "cleanupState" = 'pending'`, [channelId]);
      await client.query('COMMIT');
      open = false;
      return { state: 'converged', channelId };
    }
    await client.query('COMMIT');
    open = false;
    return { state: 'progress', channelId, deleted };
  } catch (err) {
    if (open) { try { await client.query('ROLLBACK'); } catch { /* keep original error */ } }
    throw err;
  } finally {
    client.release();
  }
}

export interface ExpiryTickLimits { maxClaims?: number; maxCleanupPasses?: number; batchSize?: number }
export interface ExpiryTickReport {
  claimed: string[];
  /** The same claims with their server, for broadcasting and cache invalidation. */
  claimedChannels: Array<{ channelId: string; serverId: string }>;
  converged: string[];
  deleted: number;
}

/** One bounded worker tick: claim up to N channels, then up to M cleanup passes. */
export async function runChannelExpiryTick(pool: ExpiryPool, limits: ExpiryTickLimits = {}): Promise<ExpiryTickReport> {
  const maxClaims = limits.maxClaims ?? 20;
  const maxPasses = limits.maxCleanupPasses ?? 50;
  const report: ExpiryTickReport = { claimed: [], claimedChannels: [], converged: [], deleted: 0 };
  for (let i = 0; i < maxClaims; i++) {
    const claim = await claimExpiredChannel(pool);
    if (claim.state !== 'claimed') break;
    report.claimed.push(claim.channelId);
    report.claimedChannels.push({ channelId: claim.channelId, serverId: claim.serverId });
  }
  for (let i = 0; i < maxPasses; i++) {
    const pass = await cleanupNextTombstone(pool, limits.batchSize);
    if (pass.state === 'none') break;
    if (pass.state === 'converged') report.converged.push(pass.channelId);
    else report.deleted += pass.deleted;
  }
  return report;
}
