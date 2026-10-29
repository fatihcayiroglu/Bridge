/**
 * P7 D2: owner-only channel expiry configuration (PostgreSQL).
 *
 * One short transaction per change:
 *   1. Lock the server row FOR NO KEY UPDATE. This serialises every expiry
 *      change in the server (the "keep a permanent channel" rule below needs
 *      it) without blocking writers: the write barrier and FKs take
 *      FOR KEY SHARE, which does not conflict.
 *   2. Check the actor owns the server.
 *   3. Lock the channel row FOR NO KEY UPDATE and re-read it with the
 *      database clock. An expired or tombstoned channel is gone: it is
 *      never revived. If the expiry worker holds or deleted the row, the
 *      lock wait ends with no row and the answer is "not found".
 *   4. Validate the requested time against the database clock and the
 *      bounds, then bump "expiryVersion" with the new "expiresAt".
 *
 * A new expiry is always at least the minimum lifetime in the future, so a
 * writer that passed the write barrier just before the change stays valid.
 */
import { validateChannelExpiryRequest, MIN_CHANNEL_LIFETIME_MS, MAX_CHANNEL_LIFETIME_MS,
  type ChannelExpiryBounds } from './channelExpiry';
import { parsePersistedNonNegativeInteger } from './persistedInteger';

export interface ExpiryConfigQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
}
export interface ExpiryConfigClient extends ExpiryConfigQueryable { release(): void }
export interface ExpiryConfigPool { connect(): Promise<ExpiryConfigClient> }

/**
 * Default product policy (needs owner sign-off): 1 hour to 30 days, and an
 * expiring channel may be made permanent again before it expires.
 */
export const CHANNEL_EXPIRY_BOUNDS: Readonly<ChannelExpiryBounds> = Object.freeze({
  minLifetimeMs: MIN_CHANNEL_LIFETIME_MS,
  maxLifetimeMs: MAX_CHANNEL_LIFETIME_MS,
  allowPermanent: true,
});

const NOW_MS = 'FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT';

export const LOCK_SERVER_SQL =
  'SELECT "ownerId" FROM servers WHERE _id = $1 FOR NO KEY UPDATE';

export const LOCK_CHANNEL_SQL = `
  SELECT c._id, c."expiresAt", c."expiryVersion", ${NOW_MS} AS "nowMs",
         EXISTS (SELECT 1 FROM channel_expiry_tombstones t WHERE t."channelId" = c._id) AS "hasTombstone"
    FROM channels c
   WHERE c._id = $1 AND c."serverId" = $2
   FOR NO KEY UPDATE OF c`;

/** Other channels of the server that stay permanent. */
export const OTHER_PERMANENT_SQL = `
  SELECT 1 FROM channels
   WHERE "serverId" = $1 AND _id <> $2 AND "expiresAt" IS NULL
   LIMIT 1`;

export const UPDATE_EXPIRY_SQL = `
  UPDATE channels SET "expiresAt" = $3, "expiryVersion" = "expiryVersion" + 1
   WHERE _id = $1 AND "serverId" = $2
   RETURNING "expiresAt", "expiryVersion"`;

export interface SetChannelExpiryInput {
  serverId: string;
  channelId: string;
  actorId: string;
  /** Epoch milliseconds, or null to make the channel permanent. */
  expiresAt: unknown;
  /** Optional optimistic-concurrency check against the current version. */
  expectedVersion?: unknown;
}

export type SetChannelExpiryResult =
  | { ok: true; expiresAt: number | null; expiryVersion: number }
  | { ok: false; reason: 'not_found' | 'forbidden' | 'invalid_request' | 'outside_window'
      | 'version_conflict' | 'last_permanent_channel' };

function badId(value: unknown): boolean {
  return typeof value !== 'string' || !value || value.length > 256;
}

export async function setChannelExpiry(
  pool: ExpiryConfigPool, input: SetChannelExpiryInput,
  bounds: ChannelExpiryBounds = CHANNEL_EXPIRY_BOUNDS,
): Promise<SetChannelExpiryResult> {
  if (badId(input.serverId) || badId(input.channelId) || badId(input.actorId)) {
    return { ok: false, reason: 'not_found' };
  }
  if (input.expectedVersion !== undefined &&
      (typeof input.expectedVersion !== 'number' || !Number.isSafeInteger(input.expectedVersion) ||
       input.expectedVersion < 0)) {
    return { ok: false, reason: 'invalid_request' };
  }
  if (input.expiresAt !== null &&
      (typeof input.expiresAt !== 'number' || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= 0)) {
    return { ok: false, reason: 'invalid_request' };
  }

  const client = await pool.connect();
  let open = false;
  const finish = async (result: SetChannelExpiryResult) => {
    await client.query(result.ok ? 'COMMIT' : 'ROLLBACK');
    open = false;
    return result;
  };
  try {
    await client.query('BEGIN');
    open = true;

    const server = await client.query(LOCK_SERVER_SQL, [input.serverId]);
    const owner = server.rows.length === 1 ? server.rows[0] : undefined;
    if (!owner) return await finish({ ok: false, reason: 'not_found' });
    if (owner.ownerId !== input.actorId) return await finish({ ok: false, reason: 'forbidden' });

    const locked = await client.query(LOCK_CHANNEL_SQL, [input.channelId, input.serverId]);
    const row = locked.rows[0];
    if (locked.rows.length !== 1 || !row || row._id !== input.channelId || row.hasTombstone !== false) {
      return await finish({ ok: false, reason: 'not_found' });
    }
    // Corrupt stored values throw: the caller answers 500 and nothing changes.
    const nowMs = parsePersistedNonNegativeInteger(row.nowMs, 'database clock');
    const version = parsePersistedNonNegativeInteger(row.expiryVersion, 'expiry version');
    const current = row.expiresAt === null ? null : parsePersistedNonNegativeInteger(row.expiresAt, 'channel expiry');
    if (current !== null && (current === 0 || version === 0)) throw new TypeError('Corrupt channel expiry');
    // Expired but not yet claimed by the worker: already gone, never revived.
    if (current !== null && current <= nowMs) return await finish({ ok: false, reason: 'not_found' });

    if (input.expectedVersion !== undefined && input.expectedVersion !== version) {
      return await finish({ ok: false, reason: 'version_conflict' });
    }
    const decision = validateChannelExpiryRequest(input.expiresAt, nowMs, bounds);
    if (!decision.valid) {
      return await finish({ ok: false, reason: decision.reason === 'outside_window' ? 'outside_window' : 'invalid_request' });
    }
    if (decision.expiresAt !== null && current === null) {
      // Keep at least one permanent channel per server. The server-row lock
      // makes this check race-free against other expiry changes.
      const others = await client.query(OTHER_PERMANENT_SQL, [input.serverId, input.channelId]);
      if (!others.rows.length) return await finish({ ok: false, reason: 'last_permanent_channel' });
    }

    const updated = await client.query(UPDATE_EXPIRY_SQL, [input.channelId, input.serverId, decision.expiresAt]);
    const out = updated.rows[0];
    if (updated.rows.length !== 1 || !out) throw new Error('Channel expiry update lost its row');
    return await finish({
      ok: true,
      expiresAt: out.expiresAt === null ? null : parsePersistedNonNegativeInteger(out.expiresAt, 'channel expiry'),
      expiryVersion: parsePersistedNonNegativeInteger(out.expiryVersion, 'expiry version'),
    });
  } catch (err) {
    if (open) { try { await client.query('ROLLBACK'); } catch { /* keep original error */ } }
    throw err;
  } finally {
    client.release();
  }
}
