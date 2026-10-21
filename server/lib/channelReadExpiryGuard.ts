/**
 * P7 D2: authoritative read preflight for channel message surfaces.
 *
 * Never decide from the 60s channel cache or the first-page message cache.
 * Query the live PG row, tenant ID, tombstone and database time together.
 * This is NOT a transaction-spanning lock or an end-to-end expiry feature.
 */
import { classifyChannelExpiryWithTombstone } from './channelExpiry';
import { parsePersistedNonNegativeInteger } from './persistedInteger';

export interface ChannelReadQuery {
  query(sql: string, params: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export const CHANNEL_READ_EXPIRY_SQL = [
  'SELECT c._id, c."serverId", c."expiresAt", c."expiryVersion",',
  '  EXISTS (SELECT 1 FROM channel_expiry_tombstones t',
  '          WHERE t."channelId" = c._id) AS "hasTombstone",',
  '  FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT AS "nowMs"',
  'FROM channels c WHERE c._id=$1 AND c."serverId"=$2',
].join('\n');

/**
 * False means unavailable or unverifiable. Database failures deliberately
 * throw: the HTTP boundary must fail closed, including on cache hits.
 * A tombstone blocks even if the same ID was accidentally recreated.
 */
export async function channelLiveForMessageRead(
  pool: ChannelReadQuery, channelId: string, serverId: string,
): Promise<boolean> {
  if (typeof channelId !== 'string' || typeof serverId !== 'string' ||
      !channelId || !serverId || channelId.length > 256 || serverId.length > 256) return false;
  const result = await pool.query(CHANNEL_READ_EXPIRY_SQL, [channelId, serverId]);
  if (!result || !Array.isArray(result.rows) || result.rows.length !== 1) return false;
  const row = result.rows[0];
  if (!row || row._id !== channelId || row.serverId !== serverId ||
      typeof row.hasTombstone !== 'boolean' || row.hasTombstone) return false;
  try {
    const nowMs = parsePersistedNonNegativeInteger(row.nowMs, 'database clock');
    return classifyChannelExpiryWithTombstone(
      { _id: row._id, serverId: row.serverId, expiresAt: row.expiresAt,
        expiryVersion: row.expiryVersion },
      null, nowMs,
    ).accessible;
  } catch {
    return false;
  }
}
