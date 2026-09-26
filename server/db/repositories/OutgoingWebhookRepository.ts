// server/db/repositories/OutgoingWebhookRepository.ts
// Giden webhook sorgularını tek noktada toplar.

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';
import { postgresPoolOrTestFallback } from './postgresInvariant';
import { parsePersistedEpochMillis } from '../../lib/persistedEpoch';
import { parsePersistedNonNegativeInteger } from '../../lib/persistedInteger';

let deliveryQueueSerial: Promise<void> = Promise.resolve();

function requirePositiveSafeInt(value: number, label: string, max: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw new TypeError(`Invalid ${label}`);
  return value;
}
function requireNonNegativeSafeInt(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`Invalid ${label}`);
  return value;
}
function requireClaimOwner(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new TypeError('Invalid outgoing webhook claim owner');
  return value;
}

class OutgoingWebhookRepository {
  hasCollection() {
    return !!db.outgoingWebhooks;
  }

  async findById(id: string) {
    return db.outgoingWebhooks.findOne({ _id: id });
  }

  async findByIdAndServer(id: string, serverId: string) {
    return db.outgoingWebhooks.findOne({ _id: id, serverId });
  }

  async findByServer(serverId: string) {
    return db.outgoingWebhooks.find({ serverId }) ?? [];
  }

  async findActive(serverId: string) {
    return db.outgoingWebhooks.find({ serverId, enabled: true }) ?? [];
  }

  async findEnabledByServer(serverId: string) {
    return db.outgoingWebhooks.find({ serverId, enabled: true }) ?? [];
  }

  async insert(data: Record<string, unknown>) {
    return db.outgoingWebhooks.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async update(id: string, fields: Record<string, unknown>) {
    return db.outgoingWebhooks.update({ _id: id }, { $set: fields });
  }

  async updateInServer(id: string, serverId: string, fields: Record<string, unknown>) {
    return db.outgoingWebhooks.update({ _id: id, serverId }, { $set: fields });
  }

  async updateByIdRaw(id: string, modifier: Record<string, unknown>) {
    return db.outgoingWebhooks.update({ _id: id }, modifier);
  }

  async recordDeliverySuccess(id: string, status: number) {
    if (!Number.isSafeInteger(status) || status < 100 || status > 599) throw new TypeError('Invalid outgoing webhook status');
    const rawPool = (db as unknown as { _pool?: import('pg').Pool })._pool;
    const pool = postgresPoolOrTestFallback(rawPool?.query ? rawPool : null, 'OutgoingWebhookRepository state update');
    if (pool) {
      const result = await pool.query(
        `UPDATE outgoing_webhooks
            SET "lastFiredAt" = $2, "lastStatus" = $3,
                "consecutiveFailures" = 0, "lastError" = NULL
          WHERE _id = $1
        RETURNING *`,
        [id, Date.now(), status],
      );
      return result.rows[0] ?? null;
    }
    await db.outgoingWebhooks.update({ _id: id }, { $set: {
      lastFiredAt: Date.now(), lastStatus: status, consecutiveFailures: 0, lastError: null,
    } });
    return db.outgoingWebhooks.findOne({ _id: id });
  }

  async recordDeliveryFailure(id: string, status: number, error: string, disableAt = 10) {
    if (!Number.isSafeInteger(status) || status < 0 || status > 599) throw new TypeError('Invalid outgoing webhook status');
    requirePositiveSafeInt(disableAt, 'outgoing webhook disable threshold', 1000);
    if (typeof error !== 'string') throw new TypeError('Invalid outgoing webhook error');
    const now = Date.now();
    const rawPool = (db as unknown as { _pool?: import('pg').Pool })._pool;
    const pool = postgresPoolOrTestFallback(rawPool?.query ? rawPool : null, 'OutgoingWebhookRepository state update');
    if (pool) {
      const result = await pool.query(
        `UPDATE outgoing_webhooks
            SET "lastFiredAt" = $2, "lastStatus" = $3,
                "lastFailedAt" = $2, "lastError" = $4,
                "consecutiveFailures" = COALESCE("consecutiveFailures", 0) + 1,
                enabled = CASE
                  WHEN COALESCE("consecutiveFailures", 0) + 1 >= $5 THEN FALSE
                  ELSE enabled
                END
          WHERE _id = $1
        RETURNING *`,
        [id, now, status, error.slice(0, 200), disableAt],
      );
      return result.rows[0] ?? null;
    }
    const current = await db.outgoingWebhooks.findOne({ _id: id });
    if (!current) return null;
    const failures = parsePersistedNonNegativeInteger(current.consecutiveFailures, 'outgoing webhook failure count', { defaultWhenMissing: 0, max: 2_147_483_646 }) + 1;
    await db.outgoingWebhooks.update({ _id: id }, { $set: {
      lastFiredAt: now, lastStatus: status, lastFailedAt: now, lastError: error.slice(0, 200),
      consecutiveFailures: failures, ...(failures >= disableAt ? { enabled: false } : {}),
    } });
    return db.outgoingWebhooks.findOne({ _id: id });
  }

  async enqueueDeliveryBounded(
    webhookId: string, serverId: string, eventName: string, payload: Record<string, unknown>,
    maxPending = 1000,
  ): Promise<string | null> {
    requirePositiveSafeInt(maxPending, 'outgoing webhook pending cap', 100_000);
    if (!webhookId || !serverId || !eventName) throw new TypeError('Invalid outgoing webhook delivery identity');
    const id = uuidv4();
    const now = Date.now();
    const rawPool = (db as unknown as { _pool?: import('pg').Pool })._pool;
    const pool = postgresPoolOrTestFallback(rawPool?.connect ? rawPool : null, 'OutgoingWebhookRepository queue transaction');
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`outgoing-webhook:${webhookId}`]);
        const count = await client.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM outgoing_webhook_deliveries WHERE "webhookId" = $1',
          [webhookId],
        );
        if (Number(count.rows[0]?.count ?? 0) >= maxPending) {
          await client.query('ROLLBACK');
          return null;
        }
        await client.query(
          `INSERT INTO outgoing_webhook_deliveries
             (_id, "webhookId", "serverId", "eventName", payload, attempts, "nextAt", "createdAt")
           VALUES ($1,$2,$3,$4,$5::jsonb,0,$6,$6)`,
          [id, webhookId, serverId, eventName, JSON.stringify(payload), now],
        );
        await client.query('COMMIT');
        return id;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally { client.release(); }
    }

    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const previous = deliveryQueueSerial; deliveryQueueSerial = previous.then(() => turn); await previous;
    try {
      const rows = await db.outgoingWebhookDeliveries.find({ webhookId });
      if ((rows?.length ?? 0) >= maxPending) return null;
      await db.outgoingWebhookDeliveries.insert({
        _id: id, webhookId, serverId, eventName, payload, attempts: 0, nextAt: now, createdAt: now,
      });
      return id;
    } finally { release(); }
  }

  async claimDueDeliveries(now: number, claimOwner: string, leaseMs = 120_000, limit = 100) {
    requireNonNegativeSafeInt(now, 'outgoing webhook claim timestamp');
    requireClaimOwner(claimOwner);
    requirePositiveSafeInt(leaseMs, 'outgoing webhook lease', 10 * 60_000);
    requirePositiveSafeInt(limit, 'outgoing webhook claim limit', 10_000);
    const boundedLimit = Math.min(limit, 200);
    const claimUntil = now + Math.max(30_000, leaseMs);
    if (!Number.isSafeInteger(claimUntil)) throw new TypeError('Invalid outgoing webhook claim deadline');
    const rawPool = (db as unknown as { _pool?: import('pg').Pool })._pool;
    const pool = postgresPoolOrTestFallback(rawPool?.connect ? rawPool : null, 'OutgoingWebhookRepository queue transaction');
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(
          `WITH due AS (
             SELECT _id FROM outgoing_webhook_deliveries
              WHERE "nextAt" <= $1 AND ("claimUntil" IS NULL OR "claimUntil" <= $1)
              ORDER BY "nextAt" ASC, "createdAt" ASC
              FOR UPDATE SKIP LOCKED LIMIT $4
           )
           UPDATE outgoing_webhook_deliveries d
              SET "claimOwner" = $2, "claimUntil" = $3
             FROM due WHERE d._id = due._id RETURNING d.*`,
          [now, claimOwner, claimUntil, boundedLimit],
        );
        await client.query('COMMIT');
        return result.rows;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally { client.release(); }
    }
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const previous = deliveryQueueSerial; deliveryQueueSerial = previous.then(() => turn); await previous;
    try {
      const rows = await db.outgoingWebhookDeliveries.find({ nextAt: { $lte: now } }).sort({ nextAt: 1 }) ?? [];
      const due = rows.filter((row) => (parsePersistedEpochMillis(row.claimUntil) ?? 0) <= now).slice(0, boundedLimit);
      const claimed: Record<string, unknown>[] = [];
      for (const row of due) {
        await db.outgoingWebhookDeliveries.update({ _id: row._id }, { $set: { claimOwner, claimUntil } });
        claimed.push({ ...row, claimOwner, claimUntil });
      }
      return claimed;
    } finally { release(); }
  }

  async retryDelivery(id: string, claimOwner: string, attempts: number, nextAt: number, error: string) {
    requireClaimOwner(claimOwner);
    requireNonNegativeSafeInt(attempts, 'outgoing webhook retry attempts');
    requireNonNegativeSafeInt(nextAt, 'outgoing webhook retry timestamp');
    if (typeof error !== 'string') throw new TypeError('Invalid outgoing webhook retry error');
    return db.outgoingWebhookDeliveries.update(
      { _id: id, claimOwner },
      { $set: { attempts, nextAt, lastError: error.slice(0, 200), claimOwner: null, claimUntil: null } },
    );
  }

  async completeDelivery(id: string, claimOwner: string) {
    requireClaimOwner(claimOwner);
    return db.outgoingWebhookDeliveries.remove({ _id: id, claimOwner });
  }

  async delete(id: string) {
    return db.outgoingWebhooks.remove({ _id: id });
  }

  async deleteInServer(id: string, serverId: string) {
    return db.outgoingWebhooks.remove({ _id: id, serverId });
  }
}

export default new OutgoingWebhookRepository();
