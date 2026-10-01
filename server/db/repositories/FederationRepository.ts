// server/db/repositories/FederationRepository.ts
// Federation peers, ActivityPub koleksiyonları ve ACL listeleri.

import db from '../loader';

import { postgresPoolOrTestFallback } from './postgresInvariant';
import { parsePersistedEpochMillis } from '../../lib/persistedEpoch';
import { parsePersistedNonNegativeInteger } from '../../lib/persistedInteger';

/**
 * P5 FED-02: federation_whitelist / federation_blacklist are
 * (_id, domain, reason, "createdAt"). The admin routes build entries with
 * `addedAt` / `addedBy`, columns that do not exist in PostgreSQL — every
 * domain block or allow answered 500, so the federation ACL could not be
 * administered at all. Entries are mapped onto the real columns here; who added
 * an entry is recorded by the admin audit log (`logAction`).
 */
function toAclRow(entry: Record<string, unknown>): Record<string, unknown> {
  const createdAt = typeof entry.createdAt === 'number' ? entry.createdAt
    : typeof entry.addedAt === 'number' ? entry.addedAt : Date.now();
  const row: Record<string, unknown> = { domain: entry.domain, createdAt };
  if (entry._id !== undefined) row._id = entry._id;
  if (entry.reason !== undefined) row.reason = entry.reason;
  return row;
}

let deliveryClaimSerial: Promise<void> = Promise.resolve();

function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new TypeError(`Invalid ${label}`);
  return value;
}

function normalizeDeliveryDoc(doc: Record<string, unknown>) {
  const payload = doc.payload;
  let attempts: number;
  let nextAt: number;
  let createdAt: number;
  try {
    attempts = parsePersistedNonNegativeInteger(doc.attempts, 'ActivityPub delivery attempts', { max: 2_147_483_647 });
    nextAt = parsePersistedEpochMillis(doc.nextAt) as number;
    createdAt = parsePersistedEpochMillis(doc.createdAt) as number;
    if (nextAt === null || createdAt === null) throw new TypeError('missing timestamp');
  } catch {
    throw new TypeError('Invalid ActivityPub delivery queue document');
  }
  if (!payload || (typeof payload !== 'object' && typeof payload !== 'string')) {
    throw new TypeError('Invalid ActivityPub delivery queue document');
  }
  return { payload, attempts, nextAt, createdAt };
}

class FederationRepository {
  // ── Peers ─────────────────────────────────────────────────

  async findPeers() {
    return await db.federationPeers.find({}) ?? [];
  }

  async findPeerByUrl(url: string) {
    return db.federationPeers.findOne({ url });
  }

  async getPeerByUrl(url: string) {
    return this.findPeerByUrl(url);
  }

  async insertPeer(peer: Record<string, unknown>) {
    return db.federationPeers.insert(peer);
  }

  async removePeerById(id: string) {
    return db.federationPeers.remove({ _id: id });
  }

  async updatePeer(id: string, modifier: Record<string, unknown>) {
    return db.federationPeers.update({ _id: id }, modifier);
  }

  async updatePeersWhere(filter: Record<string, unknown>, modifier: Record<string, unknown>) {
    return db.federationPeers.update(filter, modifier);
  }

  // ── ACL (admin + middleware) ──────────────────────────────

  async findWhitelist() {
    return await db.federationWhitelist.find({}) ?? [];
  }

  async findWhitelistOne(query: Record<string, unknown>) {
    return db.federationWhitelist.findOne(query);
  }

  async insertWhitelist(entry: Record<string, unknown>) {
    return db.federationWhitelist.insert(toAclRow(entry));
  }

  async removeWhitelistByDomain(domain: string) {
    return db.federationWhitelist.remove({ domain });
  }

  async findBlacklist() {
    return await db.federationBlacklist.find({}) ?? [];
  }

  async findBlacklistOne(query: Record<string, unknown>) {
    return db.federationBlacklist.findOne(query);
  }

  async insertBlacklist(entry: Record<string, unknown>) {
    return db.federationBlacklist.insert(toAclRow(entry));
  }

  async removeBlacklistByDomain(domain: string) {
    return db.federationBlacklist.remove({ domain });
  }

  // ── ActivityPub: Activities ───────────────────────────────

  async insertActivity(doc: Record<string, unknown>) {
    return db.apActivities.insert(doc);
  }

  async updateActivity(filter: Record<string, unknown>, modifier: Record<string, unknown>) {
    return db.apActivities.update(filter, modifier);
  }

  /**
   * Atomically claim a signed inbound ActivityPub activity.
   * Real PostgreSQL uses a partial-unique-key UPSERT + lease. Unit-test/mock DB
   * uses an equivalent single-process fallback; concurrency proof remains a
   * real-PostgreSQL responsibility.
   */
  async claimInboundActivity(input: {
    id: string;
    targetUserId: string;
    actorUrl: string;
    activityId: string;
    type: string;
    activity: Record<string, unknown>;
    claimOwner: string;
    claimUntil: number;
    createdAt: number;
  }): Promise<{ status: 'claimed' | 'processed' | 'busy'; id: string }> {
    requiredId(input.id, 'ActivityPub journal id');
    requiredId(input.targetUserId, 'ActivityPub target user id');
    requiredId(input.actorUrl, 'ActivityPub actor URL');
    requiredId(input.activityId, 'ActivityPub activity id');
    requiredId(input.type, 'ActivityPub activity type');
    requiredId(input.claimOwner, 'ActivityPub claim owner');
    if (!input.activity || typeof input.activity !== 'object' || Array.isArray(input.activity) ||
        !Number.isSafeInteger(input.createdAt) || input.createdAt < 0 ||
        !Number.isSafeInteger(input.claimUntil) || input.claimUntil <= input.createdAt) {
      throw new TypeError('Invalid ActivityPub inbox claim');
    }
    const rawPool = db._pool as { query?: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> } | undefined;
    const pool = postgresPoolOrTestFallback(rawPool?.query ? rawPool : null, 'FederationRepository inbox journal');
    if (pool?.query) {
      const result = await pool.query(
        `INSERT INTO ap_activities
           (_id, "targetUserId", "actorUrl", type, "activityId", activity,
            processed, "claimOwner", "claimUntil", attempts, "createdAt")
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,FALSE,$7,$8,1,$9)
         ON CONFLICT ("targetUserId", "actorUrl", "activityId")
           WHERE "targetUserId" IS NOT NULL AND "actorUrl" IS NOT NULL AND "activityId" IS NOT NULL
         DO UPDATE SET
           "claimOwner" = EXCLUDED."claimOwner",
           "claimUntil" = EXCLUDED."claimUntil",
           attempts = ap_activities.attempts + 1,
           "lastError" = NULL
         WHERE ap_activities.processed = FALSE
           AND (ap_activities."claimUntil" IS NULL
             OR ap_activities."claimUntil" < $9
             OR ap_activities."claimOwner" = EXCLUDED."claimOwner")
         RETURNING _id, processed`,
        [input.id, input.targetUserId, input.actorUrl, input.type, input.activityId,
          JSON.stringify(input.activity), input.claimOwner, input.claimUntil, input.createdAt],
      );
      if (result.rows[0]) return { status: 'claimed', id: String(result.rows[0]._id) };

      const existing = await pool.query(
        `SELECT _id, processed, "claimUntil" FROM ap_activities
          WHERE "targetUserId"=$1 AND "actorUrl"=$2 AND "activityId"=$3 LIMIT 1`,
        [input.targetUserId, input.actorUrl, input.activityId],
      );
      const row = existing.rows[0];
      if (!row) throw new Error('ActivityPub inbox claim disappeared after conflict');
      return { status: row.processed === true ? 'processed' : 'busy', id: String(row._id) };
    }

    const existing = await db.apActivities.findOne({
      targetUserId: input.targetUserId, actorUrl: input.actorUrl, activityId: input.activityId,
    });
    if (existing) {
      if (existing.processed === true) return { status: 'processed', id: String(existing._id) };
      if (typeof existing.claimUntil === 'number' && existing.claimUntil >= input.createdAt &&
          existing.claimOwner !== input.claimOwner) {
        return { status: 'busy', id: String(existing._id) };
      }
      await db.apActivities.update({ _id: existing._id }, { $set: {
        claimOwner: input.claimOwner, claimUntil: input.claimUntil, lastError: null,
      }, $inc: { attempts: 1 } });
      return { status: 'claimed', id: String(existing._id) };
    }

    await db.apActivities.insert({
      _id: input.id, targetUserId: input.targetUserId, actorUrl: input.actorUrl,
      type: input.type, activityId: input.activityId, activity: input.activity,
      processed: false, claimOwner: input.claimOwner, claimUntil: input.claimUntil,
      attempts: 1, createdAt: input.createdAt,
    });
    return { status: 'claimed', id: input.id };
  }

  async completeInboundActivity(id: string, claimOwner: string, processedAt = Date.now()): Promise<void> {
    requiredId(id, 'ActivityPub journal id');
    requiredId(claimOwner, 'ActivityPub claim owner');
    if (!Number.isSafeInteger(processedAt) || processedAt < 0) throw new TypeError('Invalid ActivityPub processed timestamp');
    const rawPool = db._pool as { query?: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> } | undefined;
    const pool = postgresPoolOrTestFallback(rawPool?.query ? rawPool : null, 'FederationRepository inbox journal');
    if (pool?.query) {
      const result = await pool.query(
        `UPDATE ap_activities SET processed=TRUE, "processedAt"=$3,
           "claimOwner"=NULL, "claimUntil"=NULL, "lastError"=NULL
         WHERE _id=$1 AND "claimOwner"=$2 AND processed=FALSE RETURNING _id`,
        [id, claimOwner, processedAt],
      );
      if (!result.rows[0]) throw new Error('ActivityPub inbox claim ownership lost before completion');
      return;
    }
    const row = await db.apActivities.findOne({ _id: id, claimOwner, processed: false });
    if (!row) throw new Error('ActivityPub inbox claim ownership lost before completion');
    await db.apActivities.update({ _id: id, claimOwner, processed: false }, { $set: {
      processed: true, processedAt, claimOwner: null, claimUntil: null, lastError: null,
    } });
  }

  async failInboundActivity(id: string, claimOwner: string, error: string): Promise<void> {
    requiredId(id, 'ActivityPub journal id');
    requiredId(claimOwner, 'ActivityPub claim owner');
    if (typeof error !== 'string' || !error) throw new TypeError('Invalid ActivityPub failure reason');
    const safeError = error.slice(0, 1000);
    const rawPool = db._pool as { query?: (sql: string, values?: unknown[]) => Promise<unknown> } | undefined;
    const pool = postgresPoolOrTestFallback(rawPool?.query ? rawPool : null, 'FederationRepository inbox failure');
    if (pool?.query) {
      await pool.query(
        `UPDATE ap_activities SET "claimOwner"=NULL, "claimUntil"=NULL, "lastError"=$3
          WHERE _id=$1 AND "claimOwner"=$2 AND processed=FALSE`,
        [id, claimOwner, safeError],
      );
      return;
    }
    await db.apActivities.update({ _id: id, claimOwner, processed: false }, { $set: {
      claimOwner: null, claimUntil: null, lastError: safeError,
    } });
  }

  /** Sıralama/limit zinciri için ham find döndürür. */
  apActivitiesFind(query: Record<string, unknown>) {
    return db.apActivities.find(query);
  }

  async findActivities(query: Record<string, unknown>) {
    return db.apActivities.find(query);
  }

  async countActivities(query: Record<string, unknown>) {
    return db.apActivities.count(query);
  }

  // ── AP Follows (remote → local user) ──────────────────────

  async findApFollows(query: Record<string, unknown>) {
    return await db.apFollows.find(query) ?? [];
  }

  async findApFollowOne(query: Record<string, unknown>) {
    return db.apFollows.findOne(query);
  }

  async insertApFollow(doc: Record<string, unknown>) {
    return db.apFollows.insert(doc);
  }

  async updateApFollow(filter: Record<string, unknown>, modifier: Record<string, unknown>) {
    return db.apFollows.update(filter, modifier);
  }

  async removeApFollow(filter: Record<string, unknown>, opts: Record<string, unknown>) {
    return db.apFollows.remove(filter, opts ?? {});
  }

  // ── AP Outgoing follows ───────────────────────────────────

  async findApOutgoingFollows(query: Record<string, unknown>) {
    return await db.apOutgoingFollows.find(query) ?? [];
  }

  async findApOutgoingFollowOne(query: Record<string, unknown>) {
    return db.apOutgoingFollows.findOne(query);
  }

  async insertApOutgoingFollow(doc: Record<string, unknown>) {
    return db.apOutgoingFollows.insert(doc);
  }

  async updateApOutgoingFollow(filter: Record<string, unknown>, modifier: Record<string, unknown>) {
    return db.apOutgoingFollows.update(filter, modifier);
  }

  async removeApOutgoingFollow(filter: Record<string, unknown>, opts: Record<string, unknown>) {
    return db.apOutgoingFollows.remove(filter, opts ?? {});
  }

  // ── AP federated messages ─────────────────────────────────

  async findApMessageOne(query: Record<string, unknown>) {
    return db.apMessages.findOne(query);
  }

  async insertApMessage(doc: Record<string, unknown>) {
    return db.apMessages.insert(doc);
  }

  async updateApMessage(filter: Record<string, unknown>, modifier: Record<string, unknown>) {
    return db.apMessages.update(filter, modifier);
  }

  async removeApMessage(filter: Record<string, unknown>, opts: Record<string, unknown>) {
    return db.apMessages.remove(filter, opts ?? {});
  }

  async findApMessages(query: Record<string, unknown>) {
    return await db.apMessages.find(query) ?? [];
  }

  apMessagesFind(query: Record<string, unknown>) {
    return db.apMessages.find(query);
  }

  async countApMessages(query: Record<string, unknown>) {
    return db.apMessages.count(query);
  }

  // ── AP likes / announces ──────────────────────────────────

  async insertApLike(doc: Record<string, unknown>) {
    return db.apLikes.insert(doc);
  }

  async removeApLike(filter: Record<string, unknown>, opts: Record<string, unknown>) {
    return db.apLikes.remove(filter, opts ?? {});
  }

  async findApLikeOne(query: Record<string, unknown>) {
    return db.apLikes.findOne(query);
  }

  async insertApAnnounce(doc: Record<string, unknown>) {
    return db.apAnnounces.insert(doc);
  }

  async removeApAnnounce(filter: Record<string, unknown>, opts: Record<string, unknown>) {
    return db.apAnnounces.remove(filter, opts ?? {});
  }

  // ── AP Delivery Queue (persistent retry) ─────────────────────
  // Koleksiyon: ap_delivery_queue
  // { _id, payload: {inboxUrl,activity,fromUser}, attempts, nextAt, createdAt }

  async insertDeliveryEntry(doc: Record<string, unknown>) {
    return db.apDeliveryQueue.insert(doc);
  }

  async upsertDeliveryEntry(id: string, doc: Record<string, unknown>) {
    const rawPool = (db as unknown as { _pool?: { query?: (sql: string, values?: unknown[]) => Promise<unknown> } })._pool;
    const pool = postgresPoolOrTestFallback(rawPool?.query ? rawPool : null, 'FederationRepository delivery upsert');
    requiredId(id, 'ActivityPub delivery id');
    const { payload, attempts, nextAt, createdAt } = normalizeDeliveryDoc(doc);
    if (pool?.query) {
      await pool.query(
        `INSERT INTO ap_delivery_queue (_id, payload, attempts, "nextAt", "createdAt", "claimOwner", "claimUntil")
         VALUES ($1,$2::jsonb,$3,$4,$5,NULL,NULL)
         ON CONFLICT (_id) DO UPDATE SET
           payload=EXCLUDED.payload, attempts=EXCLUDED.attempts, "nextAt"=EXCLUDED."nextAt",
           "createdAt"=EXCLUDED."createdAt", "claimOwner"=NULL, "claimUntil"=NULL`,
        [id, JSON.stringify(payload), attempts, nextAt, createdAt],
      );
      return;
    }
    const existing = await db.apDeliveryQueue.findOne({ _id: id });
    if (existing) return db.apDeliveryQueue.update({ _id: id }, { $set: doc });
    return db.apDeliveryQueue.insert({ ...doc, _id: id });
  }

  async findPendingDeliveries(beforeTs: number) {
    if (!Number.isSafeInteger(beforeTs) || beforeTs < 0) throw new TypeError('Invalid ActivityPub delivery deadline');
    return (await db.apDeliveryQueue.find({ nextAt: { $lte: beforeTs } })) ?? [];
  }

  /**
   * Atomically lease due ActivityPub deliveries. Multi-node production uses
   * FOR UPDATE SKIP LOCKED; the collection fallback serializes the same claim
   * decision for deterministic unit tests/single-process adapters.
   */
  async claimPendingDeliveries(beforeTs: number, claimOwner: string, leaseMs = 120_000, limit = 50) {
    if (!Number.isSafeInteger(beforeTs) || beforeTs < 0 ||
        typeof claimOwner !== 'string' || !claimOwner.trim() || claimOwner.length > 200 ||
        !Number.isSafeInteger(leaseMs) || leaseMs <= 0 ||
        !Number.isSafeInteger(limit) || limit <= 0) {
      throw new TypeError('Invalid ActivityPub delivery claim parameters');
    }
    const boundedLimit = Math.min(limit, 100);
    const claimUntil = beforeTs + Math.max(30_000, Math.min(leaseMs, 10 * 60_000));
    if (!Number.isSafeInteger(claimUntil)) throw new TypeError('Invalid ActivityPub delivery claim deadline');
    const rawPool = (db as unknown as { _pool?: import('pg').Pool })._pool;
    const pool = postgresPoolOrTestFallback(rawPool?.connect ? rawPool : null, 'FederationRepository delivery claim');

    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(
          `WITH due AS (
             SELECT _id
               FROM ap_delivery_queue
              WHERE "nextAt" <= $1
                AND ("claimUntil" IS NULL OR "claimUntil" <= $1)
              ORDER BY "nextAt" ASC, "createdAt" ASC
              FOR UPDATE SKIP LOCKED
              LIMIT $4
           )
           UPDATE ap_delivery_queue q
              SET "claimOwner" = $2,
                  "claimUntil" = $3
             FROM due
            WHERE q._id = due._id
          RETURNING q.*`,
          [beforeTs, claimOwner, claimUntil, boundedLimit],
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
    const previous = deliveryClaimSerial;
    deliveryClaimSerial = previous.then(() => turn);
    await previous;
    try {
      const dueRows = await db.apDeliveryQueue.find({ nextAt: { $lte: beforeTs } }).sort({ nextAt: 1 }) ?? [];
      const due = dueRows.filter((row) => (parsePersistedEpochMillis(row.claimUntil) ?? 0) <= beforeTs).slice(0, boundedLimit);
      const claimed: Record<string, unknown>[] = [];
      for (const row of due) {
        await db.apDeliveryQueue.update(
          { _id: row._id },
          { $set: { claimOwner, claimUntil } },
        );
        claimed.push({ ...row, claimOwner, claimUntil });
      }
      return claimed;
    } finally {
      release();
    }
  }

  async releaseDeliveryClaim(id: string, claimOwner: string, doc: Record<string, unknown>) {
    requiredId(id, 'ActivityPub delivery id');
    requiredId(claimOwner, 'ActivityPub claim owner');
    const normalized = normalizeDeliveryDoc(doc);
    return db.apDeliveryQueue.update(
      { _id: id, claimOwner },
      { $set: { ...normalized, claimOwner: null, claimUntil: null } },
    );
  }

  async removeDeliveryEntry(id: string, claimOwner?: string) {
    requiredId(id, 'ActivityPub delivery id');
    if (claimOwner !== undefined) requiredId(claimOwner, 'ActivityPub claim owner');
    return db.apDeliveryQueue.remove(claimOwner ? { _id: id, claimOwner } : { _id: id });
  }

  async countPendingDeliveries() {
    const rows = await db.apDeliveryQueue.find({});
    if (!Array.isArray(rows)) throw new Error('ActivityPub delivery queue returned an invalid result');
    return rows.length;
  }
}

export default new FederationRepository();
