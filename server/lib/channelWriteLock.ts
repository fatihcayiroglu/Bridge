/**
 * P7 D2 — dormant, transaction-scoped live-channel write barrier.
 *
 * This helper is intentionally NOT wired into production message writers.
 * Callers must separately prove authorization and invoke it on the very same
 * PostgreSQL client used for durable writes. External effects (socket emits,
 * object-store requests, federation delivery) do not belong in the callback.
 *
 * FOR SHARE conflicts with the FOR UPDATE used by expiry claims (#331), and
 * with expiry/version UPDATEs. The cooperating expiry worker MUST lock this
 * same channel row before creating a tombstone. Without that invariant this
 * helper alone cannot prevent a concurrent standalone tombstone insert.
 *
 * Server time is sampled only AFTER the lock is acquired, then AGAIN before
 * COMMIT, to deny callbacks that cross the expiry instant. The final check is
 * not a universal no-post-after-expiry guarantee: a clock boundary between
 * that check and COMMIT still needs an authoritative DB write policy.
 */
import { classifyChannelExpiryWithTombstone, type ChannelExpiryDecisionState } from './channelExpiry';
import { parsePersistedNonNegativeInteger } from './persistedInteger';

export interface ChannelWriteTransaction {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

export interface ChannelWritePool {
  connect(): Promise<ChannelWriteTransaction>;
}

export const CHANNEL_WRITE_LOCK_SQL = [
  'SELECT _id AS "channelId", "serverId" AS "serverId",',
  '       "expiresAt" AS "expiresAt", "expiryVersion" AS "expiryVersion"',
  'FROM channels WHERE _id=$1 AND "serverId"=$2 FOR SHARE',
].join('\n');

export const CHANNEL_WRITE_CLOCK_SQL =
  'SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS "nowMs"';

export const CHANNEL_WRITE_TOMBSTONE_SQL = [
  'SELECT "channelId", "serverId", "expiredAt", "expiryVersion",',
  '       "recordedAt", "cleanupState"',
  // Global channel identities: never hide a mismatched-tenant tombstone.
  'FROM channel_expiry_tombstones WHERE "channelId"=$1',
].join('\n');

export type ChannelWriteDenial = 'missing' | 'expired' | 'tombstoned' | 'invalid' | 'unverified';
export type ChannelWriteOutcome<T> =
  | { state: 'committed'; value: T }
  | { state: 'denied'; reason: ChannelWriteDenial };

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= 256 && value.trim() === value;
}

async function evaluateLockedChannel(
  tx: ChannelWriteTransaction,
  channelId: string,
  serverId: string,
  channel: Record<string, unknown> | null,
): Promise<ChannelWriteDenial | null> {
  // A failed or incomplete database projection never becomes a grant.
  const clockResult = await tx.query(CHANNEL_WRITE_CLOCK_SQL);
  if (clockResult.rows.length !== 1) return 'invalid';

  let now: number;
  try {
    now = parsePersistedNonNegativeInteger(clockResult.rows[0]?.nowMs, 'PostgreSQL server time');
  } catch {
    return 'invalid';
  }

  const tombstoneResult = await tx.query(CHANNEL_WRITE_TOMBSTONE_SQL, [channelId]);
  if (tombstoneResult.rows.length > 1) return 'invalid';

  if (channel !== null &&
      (channel.channelId !== channelId || channel.serverId !== serverId ||
       !Object.prototype.hasOwnProperty.call(channel, 'expiresAt') ||
       !Object.prototype.hasOwnProperty.call(channel, 'expiryVersion'))) {
    return 'invalid';
  }

  const evidence = channel === null ? null : {
    _id: channel.channelId,
    serverId: channel.serverId,
    expiresAt: channel.expiresAt,
    expiryVersion: channel.expiryVersion,
  };
  const decision = classifyChannelExpiryWithTombstone(
    evidence, tombstoneResult.rows[0] ?? null, now,
  );
  if (decision.accessible) return null;
  if (channel === null && decision.state === 'invalid' && tombstoneResult.rows.length === 0) {
    return 'missing';
  }
  const state: ChannelExpiryDecisionState = decision.state;
  return state === 'expired' || state === 'tombstoned' || state === 'unverified'
    ? state : 'invalid';
}

/**
 * A successful callback's DATABASE writes are committed only if the locked
 * channel stays eligible through the final server-clock check.
 *
 * Denials ROLLBACK without invoking any callback (or roll back its writes if
 * the expiry instant passes during the callback). Errors reject; never silently
 * fall back to an unlocked read. This helper does NOT grant tenant permissions.
 */
export async function withLiveChannelWriteLock<T>(
  pool: ChannelWritePool,
  channelId: string,
  serverId: string,
  write: (tx: ChannelWriteTransaction) => Promise<T>,
): Promise<ChannelWriteOutcome<T>> {
  if (!validId(channelId) || !validId(serverId)) {
    return { state: 'denied', reason: 'invalid' };
  }

  const tx = await pool.connect();
  let finished = false;
  try {
    await tx.query('BEGIN');
    const locked = await tx.query(CHANNEL_WRITE_LOCK_SQL, [channelId, serverId]);
    if (locked.rows.length > 1) {
      await tx.query('ROLLBACK');
      finished = true;
      return { state: 'denied', reason: 'invalid' };
    }
    const channel = locked.rows[0] ?? null;
    const firstDenial = await evaluateLockedChannel(tx, channelId, serverId, channel);
    if (firstDenial) {
      await tx.query('ROLLBACK');
      finished = true;
      return { state: 'denied', reason: firstDenial };
    }

    const value = await write(tx);
    // Re-read within the SAME transaction: the callback may have changed
    // expiry metadata itself. A cached channel projection is not sufficient.
    const refreshed = await tx.query(CHANNEL_WRITE_LOCK_SQL, [channelId, serverId]);
    if (refreshed.rows.length !== 1) {
      await tx.query('ROLLBACK');
      finished = true;
      return { state: 'denied', reason: 'invalid' };
    }
    const lastDenial = await evaluateLockedChannel(tx, channelId, serverId, refreshed.rows[0]);
    if (lastDenial) {
      await tx.query('ROLLBACK');
      finished = true;
      return { state: 'denied', reason: lastDenial };
    }

    await tx.query('COMMIT');
    finished = true;
    return { state: 'committed', value };
  } catch (err) {
    if (!finished) {
      try { await tx.query('ROLLBACK'); } catch { /* preserve original error */ }
    }
    throw err;
  } finally {
    tx.release();
  }
}
