/**
 * P7 D2: authoritative read preflight for channel message surfaces.
 *
 * Never decide from the 60s channel cache or the first-page message cache.
 * Query the live PG row, tenant ID, tombstone and database time together.
 * This is NOT a transaction-spanning lock or an end-to-end expiry feature.
 */
import { classifyChannelExpiryWithTombstone } from './channelExpiry';
import { parsePersistedNonNegativeInteger } from './persistedInteger';
import { performance } from 'node:perf_hooks';

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
  return (await channelLiveWindowForRead(pool, channelId, serverId)).live;
}

/**
 * The authoritative decision behind channelLiveForMessageRead, plus how much
 * longer the channel stays live by the database clock, from the same read. `remainingMs` is expiresAt - now
 * for an expiring channel and null for a permanent one. A caller may reuse a
 * positive answer only within that window; the expiry API's minimum lifetime
 * means an expiry can never be moved closer than it, while a tombstone only
 * follows expiresAt.
 */
export async function channelLiveWindowForRead(
  pool: ChannelReadQuery, channelId: string, serverId: string,
): Promise<{ live: boolean; remainingMs: number | null }> {
  const closed = { live: false, remainingMs: 0 };
  if (typeof channelId !== 'string' || typeof serverId !== 'string' ||
      !channelId || !serverId || channelId.length > 256 || serverId.length > 256) return closed;
  const result = await pool.query(CHANNEL_READ_EXPIRY_SQL, [channelId, serverId]);
  if (!result || !Array.isArray(result.rows) || result.rows.length !== 1) return closed;
  const row = result.rows[0];
  if (!row || row._id !== channelId || row.serverId !== serverId ||
      typeof row.hasTombstone !== 'boolean' || row.hasTombstone) return closed;
  try {
    const nowMs = parsePersistedNonNegativeInteger(row.nowMs, 'database clock');
    const decision = classifyChannelExpiryWithTombstone(
      { _id: row._id, serverId: row.serverId, expiresAt: row.expiresAt, expiryVersion: row.expiryVersion },
      null, nowMs,
    );
    if (!decision.accessible) return closed;
    if (decision.state === 'permanent') return { live: true, remainingMs: null };
    const expiresAt = parsePersistedNonNegativeInteger(row.expiresAt, 'channel expiry');
    return { live: true, remainingMs: expiresAt - nowMs };
  } catch {
    return closed;
  }
}

/**
 * Batch form of channelLiveForMessageRead for list surfaces (search, saved,
 * inbox). One statement reads every channel row, its tombstone and the
 * database clock, so all decisions share one metadata snapshot.
 *
 * Each pair names the tenant the caller expects. A channel is live only if
 * its row exists under exactly that server, has no tombstone and classifies
 * as accessible. Duplicate channel IDs that disagree on the server are
 * excluded rather than resolved. Database failures throw (fail closed).
 */
export const CHANNEL_BATCH_READ_EXPIRY_SQL = [
  'SELECT c._id, c."serverId", c."expiresAt", c."expiryVersion",',
  '  EXISTS (SELECT 1 FROM channel_expiry_tombstones t',
  '          WHERE t."channelId" = c._id) AS "hasTombstone",',
  '  FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT AS "nowMs"',
  'FROM channels c WHERE c._id = ANY($1::text[])',
].join('\n');

const BATCH_CHUNK = 500;

export interface ChannelPair {
  channelId: unknown;
  serverId: unknown;
  /** Stored record the caller already holds; used only by the unit-test fallback. */
  channel?: unknown;
}

function validPairId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

export interface ChannelReadWindow {
  /** Conservative process-monotonic deadline; null means permanent. */
  validUntilMs: number | null;
}

export async function liveChannelWindowsForRead(
  pool: ChannelReadQuery, pairs: ReadonlyArray<ChannelPair>,
): Promise<Map<string, ChannelReadWindow>> {
  const expected = new Map<string, string | null>();
  for (const pair of pairs) {
    if (!validPairId(pair.channelId) || !validPairId(pair.serverId)) continue;
    const previous = expected.get(pair.channelId);
    if (previous === undefined) expected.set(pair.channelId, pair.serverId);
    else if (previous !== pair.serverId) expected.set(pair.channelId, null);
  }
  const ids = [...expected.entries()].filter(([, serverId]) => serverId !== null).map(([id]) => id);
  const live = new Map<string, ChannelReadWindow>();
  for (let i = 0; i < ids.length; i += BATCH_CHUNK) {
    // The DB may sample its clock long before the response reaches this node.
    // Starting here makes the remaining lifetime conservative, including all
    // query/network time, without trusting this node's wall clock.
    const startedAtMs = performance.now();
    const result = await pool.query(CHANNEL_BATCH_READ_EXPIRY_SQL, [ids.slice(i, i + BATCH_CHUNK)]);
    if (!result || !Array.isArray(result.rows)) throw new Error('Channel availability query failed');
    for (const row of result.rows) {
      const channelId = row?._id;
      if (typeof channelId !== 'string' || live.has(channelId)) continue;
      const serverId = expected.get(channelId);
      if (!serverId || row.serverId !== serverId ||
          typeof row.hasTombstone !== 'boolean' || row.hasTombstone) continue;
      try {
        const nowMs = parsePersistedNonNegativeInteger(row.nowMs, 'database clock');
        const decision = classifyChannelExpiryWithTombstone(
          { _id: channelId, serverId, expiresAt: row.expiresAt, expiryVersion: row.expiryVersion },
          null, nowMs,
        );
        if (decision.accessible) live.set(channelId, {
          validUntilMs: decision.state === 'permanent' ? null
            : startedAtMs + (parsePersistedNonNegativeInteger(row.expiresAt, 'channel expiry') - nowMs),
        });
      } catch { /* corrupt metadata is unavailable, never live */ }
    }
  }
  return live;
}

export async function liveChannelIdsForRead(
  pool: ChannelReadQuery, pairs: ReadonlyArray<ChannelPair>,
): Promise<Set<string>> {
  return new Set((await liveChannelWindowsForRead(pool, pairs)).keys());
}
