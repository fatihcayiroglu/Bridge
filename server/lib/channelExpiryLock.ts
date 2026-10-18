/**
 * P7 D2 — dormant, transaction-scoped expiry candidate lock.
 *
 * This selects one expired channel row using PostgreSQL FOR UPDATE SKIP LOCKED
 * and runs a DATABASE-ONLY callback while the row lock is held. No production
 * route, socket handler, or cleanup worker calls this yet.
 *
 * This is NOT authorization and NOT a complete expiry worker. Final wiring
 * must check tenant roles, revalidate version/expiry before mutation, lock the
 * sibling set for last-channel policy, perform graph/tombstone changes in the
 * transaction, and separately reconcile external objects/federation.
 *
 * Do not use this callback for network requests, object storage, or user-visible
 * effects: they are not rolled back with the PostgreSQL transaction.
 */
import { parsePersistedNonNegativeInteger } from './persistedInteger';

export interface ExpiryLockedTransaction {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}
export interface ExpiryLockPool {
  connect(): Promise<ExpiryLockedTransaction>;
}
export interface LockedExpiryCandidate {
  channelId: string;
  serverId: string;
  expiresAt: number;
  expiryVersion: number;
}
export type ExpiryLockResult<T> =
  | { state: 'invalid' | 'not_claimed' }
  | { state: 'executed'; value: T };

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= 256 && value.trim() === value;
}

export const EXPIRED_CHANNEL_LOCK_SQL = [
  'SELECT c._id AS "channelId", c."serverId" AS "serverId",',
  '       c."expiresAt" AS "expiresAt", c."expiryVersion" AS "expiryVersion"',
  'FROM channels AS c',
  'WHERE c._id=$1::text AND c."serverId"=$2::text',
  '  AND c."expiresAt" IS NOT NULL AND c."expiresAt" <= $3::bigint',
  '  AND c."expiryVersion" > 0',
  '  AND NOT EXISTS (',
  '    SELECT 1 FROM channel_expiry_tombstones t WHERE t."channelId"=c._id',
  '  )',
  'FOR UPDATE OF c SKIP LOCKED',
].join('\n');

/**
 * The callback runs under one real transaction while the selected channel
 * remains row-locked. A busy, active, permanent, missing, or tombstoned channel
 * all return not_claimed (no attempt to guess why). DB/callback/projection
 * failures ROLLBACK and throw so CI/worker monitoring cannot falsely pass.
 *
 * Lock selection does NOT protect against other writers which ignore this lock.
 * A future expiry worker must make its own graph/permission/last-channel
 * invariants atomic, and must not expose this helper as a public access grant.
 */
export async function withExpiredChannelRowLock<T>(
  pool: ExpiryLockPool,
  channelId: unknown,
  serverId: unknown,
  serverNowMs: unknown,
  action: (transaction: ExpiryLockedTransaction, candidate: LockedExpiryCandidate) => Promise<T>,
): Promise<ExpiryLockResult<T>> {
  if (!validId(channelId) || !validId(serverId) ||
      typeof serverNowMs !== 'number' || !Number.isSafeInteger(serverNowMs) ||
      serverNowMs < 0 || typeof action !== 'function') {
    return { state: 'invalid' };
  }

  const tx = await pool.connect();
  let open = false;
  try {
    await tx.query('BEGIN');
    open = true;
    const result = await tx.query(EXPIRED_CHANNEL_LOCK_SQL, [channelId, serverId, serverNowMs]);
    if (!result || !Array.isArray(result.rows) || result.rows.length > 1) {
      throw new TypeError('Unverified expiry lock projection');
    }
    if (result.rows.length === 0) {
      await tx.query('ROLLBACK');
      open = false;
      return { state: 'not_claimed' };
    }

    const row = result.rows[0];
    if (!row || typeof row !== 'object' ||
        !['channelId', 'serverId', 'expiresAt', 'expiryVersion']
          .every(key => Object.prototype.hasOwnProperty.call(row, key)) ||
        row.channelId !== channelId || row.serverId !== serverId) {
      throw new TypeError('Invalid expiry lock identity');
    }
    const expiresAt = parsePersistedNonNegativeInteger(row.expiresAt, 'locked expiry');
    const expiryVersion = parsePersistedNonNegativeInteger(row.expiryVersion, 'locked expiry version');
    if (expiresAt <= 0 || expiresAt > serverNowMs || expiryVersion <= 0) {
      throw new TypeError('Invalid expiry lock state');
    }

    const value = await action(tx, { channelId, serverId, expiresAt, expiryVersion });
    await tx.query('COMMIT');
    open = false;
    return { state: 'executed', value };
  } catch (error) {
    if (open) {
      try { await tx.query('ROLLBACK'); } catch { /* preserve first failure */ }
    }
    throw error;
  } finally {
    tx.release();
  }
}
