// server/db/repositories/SocialRepository.ts
// Arkadaşlık, blok ve kullanıcı bağlantısı sorgularını tek noktada toplar.

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';
import { postgresPoolOrTestFallback } from './postgresInvariant';
import type { FriendshipStatus } from './types/entities';

class SocialRepository {
  private friendshipMutationSerial: Promise<void> = Promise.resolve();
  private connectionMutationSerial: Promise<void> = Promise.resolve();

  private async serializeFallback<T>(kind: 'friendship' | 'connection', fn: () => Promise<T>): Promise<T> {
    const prior = kind === 'friendship' ? this.friendshipMutationSerial : this.connectionMutationSerial;
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    if (kind === 'friendship') this.friendshipMutationSerial = prior.then(() => current);
    else this.connectionMutationSerial = prior.then(() => current);
    await prior;
    try { return await fn(); } finally { release(); }
  }

  private blockStore() {
    if (!db.blocks) throw new Error('blocks store unavailable');
    return db.blocks;
  }

  private connectionStore() {
    if (!db.userConnections) throw new Error('userConnections store unavailable');
    return db.userConnections;
  }

  // ── Friendships ────────────────────────────────────────────

  async findFriendship(userId: string, otherId: string) {
    return db.friendships.findOne({ $or: [
      { userId, friendId: otherId },
      { userId: otherId, friendId: userId },
    ]});
  }

  async findFriendshipById(friendshipId: string) {
    return db.friendships.findOne({ _id: friendshipId });
  }

  async findFriendships(userId: string) {
    return db.friendships.find({ $or: [{ userId }, { friendId: userId }] });
  }

  async insertFriendship(userId: string, friendId: string, status: FriendshipStatus = 'pending') {
    return db.friendships.insert({ _id: uuidv4(), userId, friendId, status, createdAt: Date.now() });
  }

  async createFriendship(userId: string, friendId: string) {
    if (!userId || !friendId || userId === friendId) throw new RangeError('invalid friendship pair');

    const pgPool = postgresPoolOrTestFallback(
      (db as unknown as { _pool?: import('pg').Pool })._pool,
      'atomic friendship creation',
    );
    if (!pgPool) {
      // Mock/non-PostgreSQL fallback: serialize the check+insert window in this
      // process. Production uses a database transaction below, so multi-node
      // correctness does not depend on this in-memory lock.
      return this.serializeFallback('friendship', async () => {
        const existing = await this.findFriendship(userId, friendId);
        if (existing) return existing;
        return this.insertFriendship(userId, friendId, 'pending');
      });
    }

    const client = await pgPool.connect();
    const pairKey = JSON.stringify([userId, friendId].sort());
    try {
      await client.query('BEGIN');
      // Cross-node serialization for BOTH orientations (A→B and B→A). A
      // directional UNIQUE(userId, friendId) alone cannot prevent that race.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [pairKey]);
      const existing = await client.query(
        `SELECT * FROM friendships
          WHERE ("userId"=$1 AND "friendId"=$2)
             OR ("userId"=$2 AND "friendId"=$1)
          LIMIT 1`,
        [userId, friendId],
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return existing.rows[0];
      }

      const createdAt = Date.now();
      const id = uuidv4();
      const inserted = await client.query(
        `INSERT INTO friendships (_id, "userId", "friendId", status, "createdAt")
         VALUES ($1,$2,$3,'pending',$4) RETURNING *`,
        [id, userId, friendId, createdAt],
      );
      await client.query('COMMIT');
      return inserted.rows[0];
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original DB failure */ }
      throw err;
    } finally {
      client.release();
    }
  }

  // Faz 10 — `acceptedAt` / `declinedAt` HAYALET ALANLARDI.
  //
  // friendships şeması (db/postgres/schema.ts:264 ve CANLI Postgres'te
  // doğrulandı) yalnız şunları taşır:
  //   _id, userId, friendId, status, createdAt
  //
  // Bu kolonları yazmak PostgreSQL'de "Unknown column name" hatası veriyordu:
  // arkadaşlık KABULÜ ve REDDİ üretimde 500 dönüyordu. Kodun başka hiçbir yeri
  // bu alanları okumuyor (`acceptedAt`in diğer geçtiği yer federation'daki
  // ap_outgoing_follows tablosudur — farklı tablo). Alanlar kaldırıldı;
  // durum geçişi korunur. Migration GEREKMEZ.
  async acceptFriendship(id: string) {
    return this.updateFriendship(id, { status: 'accepted' });
  }

  async declineFriendship(id: string) {
    return this.updateFriendship(id, { status: 'declined' });
  }

  async updateFriendship(id: string, fields: Record<string, unknown>) {
    return db.friendships.update({ _id: id }, { $set: fields });
  }

  async removeFriendship(id: string) {
    return db.friendships.remove({ _id: id });
  }

  // ── Blocks ─────────────────────────────────────────────────

  async findBlock(blockerId: string, blockedId: string) {
    return this.blockStore().findOne({ blockerId, blockedId });
  }

  async findBlocksByUser(blockerId: string) {
    return await this.blockStore().find({ blockerId }) ?? [];
  }

  /** All block edges involving a user, used to keep derived friendship views fail-closed. */
  async findBlocksInvolvingUser(userId: string) {
    return await this.blockStore().find({ $or: [{ blockerId: userId }, { blockedId: userId }] }) ?? [];
  }

  async insertBlock(blockerId: string, blockedId: string) {
    return this.blockStore().insert({ _id: uuidv4(), blockerId, blockedId, createdAt: Date.now() });
  }

  async removeBlock(blockerId: string, blockedId: string) {
    return this.blockStore().remove({ blockerId, blockedId });
  }

  // ── User Connections ───────────────────────────────────────

  async findConnection(userId: string, platform: string) {
    return this.connectionStore().findOne({ userId, platform });
  }

  async findConnectionsByUser(userId: string) {
    return await this.connectionStore().find({ userId }) ?? [];
  }

  async insertConnection(data: Record<string, unknown>) {
    const userId = typeof data.userId === 'string' ? data.userId : '';
    const platform = typeof data.platform === 'string' ? data.platform : '';
    if (!userId || !platform) throw new TypeError('connection userId/platform required');
    // Repository-owned identity fields are written LAST so caller data can
    // never replace the canonical owner/id/timestamp.
    const fields = { ...data };
    delete fields._id;
    delete fields.createdAt;
    delete fields.userId;
    delete fields.platform;
    return this.connectionStore().insert({
      ...fields, userId, platform, _id: uuidv4(), createdAt: Date.now(),
    });
  }

  async upsertConnectionWithinLimit(
    userId: string,
    platform: string,
    fields: { username: string; url: string; verified?: boolean | number },
    maxConnections = 10,
  ): Promise<{ status: 'ok'; connection: Record<string, unknown> } | { status: 'limit' }> {
    if (!userId || !platform) throw new TypeError('connection userId/platform required');
    if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 100) {
      throw new RangeError('maxConnections must be a safe integer between 1 and 100');
    }

    const writeFallback = async () => this.serializeFallback('connection', async () => {
      const existing = await this.findConnection(userId, platform);
      if (existing) {
        await this.updateConnection({ userId, platform }, { $set: { username: fields.username, url: fields.url } });
        const updated = await this.findConnection(userId, platform);
        if (!updated) throw new Error('connection disappeared after update');
        return { status: 'ok' as const, connection: updated as unknown as Record<string, unknown> };
      }
      const count = await this.countConnections({ userId });
      if (count >= maxConnections) return { status: 'limit' as const };
      const connection = await this.insertConnection({
        userId, platform, username: fields.username, url: fields.url, verified: fields.verified ?? 0,
      });
      return { status: 'ok' as const, connection: connection as unknown as Record<string, unknown> };
    });

    const pgPool = postgresPoolOrTestFallback(
      (db as unknown as { _pool?: import('pg').Pool })._pool,
      'atomic block creation',
    );
    if (!pgPool) return writeFallback();

    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      // User-row lock serializes connection mutations for this account across
      // every application node, closing count→insert capacity races.
      const owner = await client.query('SELECT _id FROM users WHERE _id=$1 FOR UPDATE', [userId]);
      if (!owner.rows.length) throw new Error('connection owner not found');

      const existing = await client.query(
        'SELECT * FROM user_connections WHERE "userId"=$1 AND platform=$2 FOR UPDATE',
        [userId, platform],
      );
      if (existing.rows[0]) {
        const updated = await client.query(
          `UPDATE user_connections SET username=$3, url=$4
            WHERE "userId"=$1 AND platform=$2 RETURNING *`,
          [userId, platform, fields.username, fields.url],
        );
        await client.query('COMMIT');
        return { status: 'ok', connection: updated.rows[0] as Record<string, unknown> };
      }

      const counted = await client.query<{ count: string }>(
        'SELECT COUNT(*) AS count FROM user_connections WHERE "userId"=$1',
        [userId],
      );
      const count = Number.parseInt(counted.rows[0]?.count ?? '0', 10);
      if (count >= maxConnections) {
        await client.query('ROLLBACK');
        return { status: 'limit' };
      }

      const id = uuidv4();
      const createdAt = Date.now();
      const inserted = await client.query(
        `INSERT INTO user_connections (_id, "userId", platform, username, url, verified, "createdAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [id, userId, platform, fields.username, fields.url, Boolean(fields.verified), createdAt],
      );
      await client.query('COMMIT');
      return { status: 'ok', connection: inserted.rows[0] as Record<string, unknown> };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original DB failure */ }
      throw err;
    } finally {
      client.release();
    }
  }

  async removeConnection(userId: string, platform: string) {
    return this.connectionStore().remove({ userId, platform });
  }

  async updateConnection(filter: Record<string, unknown>, modifier: Record<string, unknown>) {
    return this.connectionStore().update(filter, modifier);
  }

  async countConnections(query: Record<string, unknown>) {
    // This count enforces the per-user connection cap. Treating a storage
    // failure as zero would fail open and allow the cap to be bypassed.
    return this.connectionStore().count(query);
  }
}

export default new SocialRepository();
