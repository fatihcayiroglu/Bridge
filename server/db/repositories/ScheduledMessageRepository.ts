// server/db/repositories/ScheduledMessageRepository.ts
// Zamanlanmış mesaj sorgularını tek noktada toplar.

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';
import type { ScheduledMessage } from './types/entities';
import { postgresPoolOrTestFallback } from './postgresInvariant';
import { parsePersistedEpochMillis } from '../../lib/persistedEpoch';
import { parsePersistedNonNegativeInteger } from '../../lib/persistedInteger';

export type ScheduledClaim = ScheduledMessage & {
  claimOwner: string;
  claimUntil: number;
  dispatchAttempts: number;
};

let testClaimSerial: Promise<void> = Promise.resolve();

function requireSafeTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`Invalid ${label}`);
  return value;
}

function requireClaimOwner(value: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 || value.length > 256) {
    throw new TypeError('Invalid scheduled-message claim owner');
  }
  return value;
}

function requirePositiveSafeInt(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Invalid ${label}`);
  return value;
}

function requireId(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 || value.length > 256) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

class ScheduledMessageRepository {
  async findPending(userId: string) {
    return db.scheduledMsgs.find({ userId, sent: false, failedAt: null, cancelledAt: null }).sort({ sendAt: 1 });
  }

  async findById(id: string, userId: string) {
    return db.scheduledMsgs.findOne({ _id: id, userId });
  }

  async insert(data: Record<string, unknown>) {
    return db.scheduledMsgs.insert({
      _id: uuidv4(),
      createdAt: Date.now(),
      sent: false,
      dispatchAttempts: 0,
      ...data,
    });
  }

  async delete(id: string) {
    return db.scheduledMsgs.remove({ _id: id });
  }

  async deleteByServer(serverId: string) {
    return db.scheduledMsgs.remove({ serverId });
  }

  /**
   * Atomically lease due work. PostgreSQL uses FOR UPDATE SKIP LOCKED so two
   * backend nodes cannot dispatch the same schedule concurrently. The test
   * adapter serializes the same decision instead of pretending its collection
   * operations are transactional.
   */
  async claimDueBefore(
    timestamp: number,
    claimOwner: string,
    leaseMs = 120_000,
    limit = 50,
  ): Promise<ScheduledClaim[]> {
    requireSafeTimestamp(timestamp, 'scheduled-message timestamp');
    requireClaimOwner(claimOwner);
    const boundedLimit = Math.min(requirePositiveSafeInt(limit, 'scheduled-message claim limit'), 100);
    const boundedLeaseMs = Math.min(requirePositiveSafeInt(leaseMs, 'scheduled-message lease'), 10 * 60_000);
    const claimUntil = timestamp + Math.max(30_000, boundedLeaseMs);
    if (!Number.isSafeInteger(claimUntil)) throw new TypeError('Invalid scheduled-message lease deadline');
    const rawPool = (db as unknown as { _pool?: import('pg').Pool })._pool;
    const pool = postgresPoolOrTestFallback(rawPool?.connect ? rawPool : null, 'ScheduledMessageRepository claimDueBefore');

    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query<ScheduledClaim>(
          `WITH due AS (
             SELECT _id
               FROM scheduled_msgs
              WHERE sent = FALSE
                AND "failedAt" IS NULL
                AND "cancelledAt" IS NULL
                AND "sendAt" <= $1
                AND ("claimUntil" IS NULL OR "claimUntil" <= $1)
              ORDER BY "sendAt" ASC, "createdAt" ASC
              FOR UPDATE SKIP LOCKED
              LIMIT $4
           )
           UPDATE scheduled_msgs s
              SET "claimOwner" = $2,
                  "claimUntil" = $3,
                  "dispatchAttempts" = COALESCE(s."dispatchAttempts", 0) + 1,
                  "lastError" = NULL
             FROM due
            WHERE s._id = due._id
          RETURNING s.*`,
          [timestamp, claimOwner, claimUntil, boundedLimit],
        );
        await client.query('COMMIT');
        return result.rows;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }

    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const previous = testClaimSerial;
    testClaimSerial = previous.then(() => turn);
    await previous;
    try {
      const dueRows = await db.scheduledMsgs
        .find({ sent: false, failedAt: null, cancelledAt: null, sendAt: { $lte: timestamp } })
        .sort({ sendAt: 1 });
      const due = dueRows
        .filter((row) => (parsePersistedEpochMillis(row.claimUntil) ?? 0) <= timestamp)
        .slice(0, boundedLimit);
      const claimed: ScheduledClaim[] = [];
      for (const row of due) {
        const attempts = parsePersistedNonNegativeInteger(row.dispatchAttempts, 'scheduled-message dispatch attempts', { defaultWhenMissing: 0, max: 2_147_483_646 }) + 1;
        await db.scheduledMsgs.update(
          { _id: row._id },
          { $set: { claimOwner, claimUntil, dispatchAttempts: attempts, lastError: null } },
        );
        claimed.push({ ...(row as ScheduledMessage), claimOwner, claimUntil, dispatchAttempts: attempts });
      }
      return claimed;
    } finally {
      release();
    }
  }

  async finalizeSent(id: string, claimOwner: string, sentAt = Date.now()): Promise<boolean> {
    requireId(id, 'scheduled-message id');
    requireClaimOwner(claimOwner);
    requireSafeTimestamp(sentAt, 'scheduled-message sentAt');
    const result = await db.scheduledMsgs.update(
      { _id: id, claimOwner, sent: false, cancelledAt: null },
      { $set: { sent: true, sentAt, claimOwner: null, claimUntil: null, lastError: null } },
    );
    return Number((result as { updated?: number } | null)?.updated ?? 0) > 0;
  }

  async releaseClaim(id: string, claimOwner: string, error: string, retryAt: number): Promise<boolean> {
    requireId(id, 'scheduled-message id');
    requireClaimOwner(claimOwner);
    if (typeof error !== 'string') throw new TypeError('Invalid scheduled-message error');
    requireSafeTimestamp(retryAt, 'scheduled-message retryAt');
    const result = await db.scheduledMsgs.update(
      { _id: id, claimOwner, sent: false },
      { $set: { claimOwner: null, claimUntil: retryAt, lastError: error.slice(0, 1000) } },
    );
    return Number((result as { updated?: number } | null)?.updated ?? 0) > 0;
  }

  async markFailed(id: string, claimOwner: string, reason: string, failedAt = Date.now()): Promise<boolean> {
    requireId(id, 'scheduled-message id');
    requireClaimOwner(claimOwner);
    if (typeof reason !== 'string') throw new TypeError('Invalid scheduled-message failure reason');
    requireSafeTimestamp(failedAt, 'scheduled-message failedAt');
    const result = await db.scheduledMsgs.update(
      { _id: id, claimOwner, sent: false },
      { $set: {
        claimOwner: null,
        claimUntil: null,
        failedAt,
        failureReason: reason.slice(0, 1000),
        lastError: reason.slice(0, 1000),
      } },
    );
    return Number((result as { updated?: number } | null)?.updated ?? 0) > 0;
  }

  /**
   * Cancel only when no live dispatcher lease owns the row. PostgreSQL locks
   * the schedule row so claim and cancel cannot both report success. A caller
   * that races an active dispatcher receives `dispatching` and must not claim
   * that cancellation succeeded.
   */
  async cancelPending(id: string, userId: string, now = Date.now()): Promise<'cancelled' | 'dispatching' | 'sent' | 'not_found'> {
    requireId(id, 'scheduled-message id');
    requireId(userId, 'scheduled-message user id');
    requireSafeTimestamp(now, 'scheduled-message cancellation timestamp');
    const rawPool = (db as unknown as { _pool?: import('pg').Pool })._pool;
    const pool = postgresPoolOrTestFallback(rawPool?.connect ? rawPool : null, 'ScheduledMessageRepository cancelPending');
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query<{
          sent: boolean;
          claimOwner: string | null;
          claimUntil: number | null;
          cancelledAt: number | null;
        }>(
          `SELECT sent, "claimOwner", "claimUntil", "cancelledAt"
             FROM scheduled_msgs
            WHERE _id = $1 AND "userId" = $2
            FOR UPDATE`,
          [id, userId],
        );
        const row = result.rows[0];
        if (!row) {
          await client.query('ROLLBACK');
          return 'not_found';
        }
        if (row.sent) {
          await client.query('ROLLBACK');
          return 'sent';
        }
        if (row.cancelledAt) {
          await client.query('COMMIT');
          return 'cancelled';
        }
        if (row.claimOwner && (parsePersistedEpochMillis(row.claimUntil) ?? 0) > now) {
          await client.query('ROLLBACK');
          return 'dispatching';
        }
        await client.query(
          `UPDATE scheduled_msgs
              SET "cancelledAt" = $3,
                  "claimOwner" = NULL,
                  "claimUntil" = NULL
            WHERE _id = $1 AND "userId" = $2 AND sent = FALSE`,
          [id, userId, now],
        );
        await client.query('COMMIT');
        return 'cancelled';
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }

    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const previous = testClaimSerial;
    testClaimSerial = previous.then(() => turn);
    await previous;
    try {
      const row = await db.scheduledMsgs.findOne({ _id: id, userId });
      if (!row) return 'not_found';
      if (row.sent) return 'sent';
      if (row.cancelledAt) return 'cancelled';
      if (row.claimOwner && (parsePersistedEpochMillis(row.claimUntil) ?? 0) > now) return 'dispatching';
      await db.scheduledMsgs.update(
        { _id: id, userId, sent: false },
        { $set: { cancelledAt: now, claimOwner: null, claimUntil: null } },
      );
      return 'cancelled';
    } finally {
      release();
    }
  }

  // Compatibility helpers retained for older callers/tests. The dispatcher no
  // longer uses read-then-markSent because that is not multi-node safe.
  async markSent(id: string, sentAt = Date.now()) {
    return db.scheduledMsgs.update({ _id: id }, { $set: { sent: true, sentAt } });
  }

  async findDueBefore(timestamp: number) {
    return db.scheduledMsgs.find({ sent: false, failedAt: null, cancelledAt: null, sendAt: { $lte: timestamp } });
  }
}

export default new ScheduledMessageRepository();
