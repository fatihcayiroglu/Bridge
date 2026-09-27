// server/db/repositories/ChannelRepository.ts
// Kanal ve kanal kategorisi sorgularını tek noktada toplar.

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';
import { postgresPoolOrTestFallback } from './postgresInvariant';
import type { ChannelType } from './types/entities';

/**
 * `createUnderCapAtomic` girdisi.
 *
 * Satir ici nesne edebisiydi; testler ayni sekli ELDE yeniden kurmak zorunda
 * kaldiklari icin tip denetimini kapatan bir donusum yaziyorlardi. Adlandirilmis tip, ikizin urun
 * sozlesmesine BAGLANMASINI mumkun kilar.
 */
export interface CreateChannelUnderCapInput {
  id: string;
  serverId: string;
  name: string;
  type: ChannelType;
  topic: string;
  category: string;
  nsfw: number;
  bitrate: number;
  slowmode: number;
  forumTags: Array<{ id?: string; name?: string; color?: string }>;
  createdAt: number;
  cap: number;
}

class ChannelRepository {
  private createUnderCapTail: Promise<void> = Promise.resolve();
  // ── Channels ────────────────────────────────────────────────

  async findById(id: string) {
    return db.channels.findOne({ _id: id });
  }

  async findByServer(serverId: string) {
    return db.channels.find({ serverId }).sort({ order: 1 });
  }

  async findByIdAndServer(id: string, serverId: string) {
    return db.channels.findOne({ _id: id, serverId });
  }

  async insert(data: Record<string, unknown>) {
    return db.channels.insert(data);
  }

  /**
   * Create one channel under the per-server cap with winner-safe ordering.
   * PostgreSQL locks the parent server row so concurrent creates cannot both
   * observe the same count/order and exceed the resource limit.
   */
  async createUnderCapAtomic(input: CreateChannelUnderCapInput): Promise<
    | { status: 'created'; channel: Record<string, unknown> }
    | { status: 'limit' }
    | { status: 'server_not_found' }
  > {
    const { id, serverId, name, type, topic, category, nsfw, bitrate, slowmode, forumTags, createdAt, cap } = input;
    for (const [field, value] of Object.entries({ id, serverId, name, type, category })) {
      if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`);
    }
    for (const [field, value] of Object.entries({ nsfw, bitrate, slowmode, createdAt, cap })) {
      if (!Number.isSafeInteger(value)) throw new TypeError(`${field} must be a safe integer`);
    }
    if (cap < 1 || createdAt <= 0) throw new RangeError('cap and createdAt must be positive');
    const supportedTypes = new Set<ChannelType>(['text', 'voice', 'announcement', 'forum', 'stage']);
    if (!supportedTypes.has(type)) throw new TypeError('unsupported channel type');
    if (!Array.isArray(forumTags)) throw new TypeError('forumTags must be an array');
    for (const tag of forumTags) {
      if (!tag || typeof tag !== 'object' || Array.isArray(tag)) throw new TypeError('malformed forum tag');
      for (const field of ['id', 'name', 'color'] as const) {
        const value = tag[field];
        if (value !== undefined && typeof value !== 'string') throw new TypeError('malformed forum tag');
      }
    }

    const rawPool = (db as unknown as { _pool?: import('pg').Pool })._pool;
    const pool = postgresPoolOrTestFallback(rawPool?.connect ? rawPool : null, 'ChannelRepository atomic operation');
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const server = await client.query<{ _id: string }>(
          'SELECT _id FROM servers WHERE _id=$1 FOR UPDATE',
          [serverId],
        );
        if (!server.rows.length) {
          await client.query('ROLLBACK');
          return { status: 'server_not_found' };
        }
        const siblings = await client.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM channels WHERE "serverId"=$1',
          [serverId],
        );
        const count = Number(siblings.rows[0]?.count ?? '0');
        if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid channel count returned by PostgreSQL');
        if (count >= cap) {
          await client.query('ROLLBACK');
          return { status: 'limit' };
        }
        const inserted = await client.query<Record<string, unknown>>(
          `INSERT INTO channels
             (_id, "serverId", name, type, topic, category, "order", position, nsfw, bitrate, slowmode, "forumTags", "createdAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)
           RETURNING *`,
          [id, serverId, name, type, topic, category, count, count, nsfw, bitrate, slowmode, JSON.stringify(forumTags), createdAt],
        );
        const channel = inserted.rows[0];
        if (!channel) throw new Error('Channel insert returned no row');
        await client.query('COMMIT');
        return { status: 'created', channel };
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
        throw err;
      } finally {
        client.release();
      }
    }

    const previous = this.createUnderCapTail;
    let release!: () => void;
    this.createUnderCapTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (!await db.servers.findOne({ _id: serverId })) return { status: 'server_not_found' };
      const existing = await db.channels.find({ serverId });
      if (existing.length >= cap) return { status: 'limit' };
      const order = existing.length;
      const channel = await db.channels.insert({
        _id: id, serverId, name, type, topic, category,
        order, position: order, nsfw, bitrate, slowmode, forumTags, createdAt,
      });
      return { status: 'created', channel: channel as unknown as Record<string, unknown> };
    } finally {
      release();
    }
  }

  async update(id: string, fields: Record<string, unknown>) {
    return db.channels.update({ _id: id }, { $set: fields });
  }

  async updateByIdAndServer(id: string, serverId: string, fields: Record<string, unknown>) {
    return db.channels.update({ _id: id, serverId }, { $set: fields });
  }

  async delete(id: string) {
    return db.channels.remove({ _id: id });
  }

  /**
   * Delete one channel and its durable channel-owned graph atomically on
   * PostgreSQL. Bridge historically deleted only messages + the channel row,
   * leaving permission, unread, webhook, federation and other channel-scoped
   * rows orphaned; a mid-delete error could also expose a half-deleted channel.
   *
   * The production path discovers optional migration tables/columns from the
   * catalog so cleanup remains compatible with supported older schemas. The
   * in-memory test adapter mirrors the same ownership graph but is not claimed
   * to provide transaction durability.
   */
  async deleteGraphAtomic(id: string, serverId: string): Promise<'deleted' | 'not_found' | 'last_channel'> {
    const rawPool = (db as unknown as { _pool?: import('pg').Pool })._pool;
    const pool = postgresPoolOrTestFallback(rawPool?.connect ? rawPool : null, 'ChannelRepository atomic operation');
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const locked = await client.query<{ _id: string }>(
          'SELECT _id FROM channels WHERE _id=$1 AND "serverId"=$2 FOR UPDATE',
          [id, serverId],
        );
        if (!locked.rows.length) {
          await client.query('ROLLBACK');
          return 'not_found';
        }
        // Lock the complete sibling set so two concurrent deletes cannot both
        // observe "2 channels" and race the tenant down to zero channels.
        const siblings = await client.query<{ _id: string }>(
          'SELECT _id FROM channels WHERE "serverId"=$1 FOR UPDATE',
          [serverId],
        );
        if (siblings.rows.length <= 1) {
          await client.query('ROLLBACK');
          return 'last_channel';
        }

        const columnRows = await client.query<{ table_name: string; column_name: string }>(
          `SELECT table_name, column_name FROM information_schema.columns
             WHERE table_schema = current_schema()`,
        );
        const cols = new Map<string, Set<string>>();
        for (const row of columnRows.rows) {
          if (!cols.has(row.table_name)) cols.set(row.table_name, new Set());
          cols.get(row.table_name)!.add(row.column_name);
        }
        const has = (table: string, col: string) => cols.get(table)?.has(col) === true;

        // Edges can point at the channel from either side and therefore are not
        // covered by a simple channelId cleanup.
        for (const table of ['channel_bridges', 'channel_follows', 'crosspost_log']) {
          const c = cols.get(table);
          if (!c) continue;
          const predicates: string[] = [];
          for (const col of ['sourceChannelId', 'targetChannelId']) {
            if (c.has(col)) predicates.push(`"${col}"=$1`);
          }
          if (predicates.length) await client.query(`DELETE FROM "${table}" WHERE ${predicates.join(' OR ')}`, [id]);
        }

        // Saved-message channel destinations use a polymorphic destinationId.
        if (has('saved_messages', 'destinationType') && has('saved_messages', 'destinationId')) {
          await client.query(
            `DELETE FROM saved_messages WHERE "destinationType"='channel' AND "destinationId"=$1`,
            [id],
          );
        }

        // Thread messages normally key by threadId rather than channelId.
        if (has('threads', 'channelId') && has('thread_messages', 'threadId')) {
          const threads = await client.query<{ _id: string }>('SELECT _id FROM threads WHERE "channelId"=$1', [id]);
          const threadIds = threads.rows.map((r) => String(r._id));
          if (threadIds.length) {
            await client.query('DELETE FROM thread_messages WHERE "threadId" = ANY($1::text[])', [threadIds]);
          }
        }

        // Every remaining table with a canonical channelId column is owned by
        // that channel for deletion purposes. Delete children before channels.
        for (const [table, tableCols] of cols.entries()) {
          if (table === 'channels' || !tableCols.has('channelId')) continue;
          await client.query(`DELETE FROM "${table}" WHERE "channelId"=$1`, [id]);
        }

        await client.query('DELETE FROM channels WHERE _id=$1 AND "serverId"=$2', [id, serverId]);
        await client.query('COMMIT');
        return 'deleted';
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
        throw err;
      } finally {
        client.release();
      }
    }

    // Temizlik, koleksiyon adlarını ÇALIŞMA ZAMANINDA gezer (adapter'a göre
    // bazıları yoktur). Dizin erişimi bu yüzden `unknown` üzerinden yapılır ve
    // her koleksiyon kullanılmadan önce `remove` yeteneği için sınanır.
    interface CleanupCollection {
      remove?: (filter: Record<string, unknown>) => Promise<unknown>;
      find?: (filter: Record<string, unknown>) => Promise<Array<{ _id?: unknown }>>;
    }
    const collections = db as unknown as Record<string, CleanupCollection | undefined>;
    const current = await db.channels.findOne({ _id: id, serverId });
    if (!current) return 'not_found';
    const siblings = await db.channels.find({ serverId });
    if (siblings.length <= 1) return 'last_channel';
    const remove = async (key: string, filter: Record<string, unknown>) => {
      const col = collections[key];
      if (col?.remove) await col.remove(filter);
    };

    for (const key of ['channelBridges', 'channelFollows']) {
      await remove(key, { $or: [{ sourceChannelId: id }, { targetChannelId: id }] });
    }
    await remove('savedMessages', { destinationType: 'channel', destinationId: id });

    const threads = collections.threads?.find ? await collections.threads.find({ channelId: id }) : [];
    const threadIds = (threads ?? []).map((t: { _id?: unknown }) => String(t._id ?? '')).filter(Boolean);
    if (threadIds.length) await remove('threadMessages', { threadId: { $in: threadIds } });

    const channelOwnedKeys = [
      'messages', 'scheduledMsgs', 'polls', 'soundboard', 'notificationPrefs',
      'unreadCounts', 'voiceMessages', 'threads', 'webhooks', 'channelOverrides',
      'channelPermissions', 'apMessages', 'reactionRoles', 'canvasStrokes',
      'podcastSettings', 'podcastEpisodes',
    ];
    for (const key of channelOwnedKeys) await remove(key, { channelId: id });
    await db.channels.remove({ _id: id, serverId });
    return 'deleted';
  }

  async deleteByServer(serverId: string) {
    return db.channels.remove({ serverId });
  }

  async count(serverId: string) {
    return db.channels.count({ serverId });
  }

  async findWhere(query: Record<string, unknown>) {
    return db.channels.find(query);
  }

  async findOneWhere(query: Record<string, unknown>) {
    return db.channels.findOne(query);
  }

  /** Bir sunucuya ait tüm kanal ID'lerini döndürür. */
  async findIdsByServer(serverId: string) {
    const channels = await db.channels.find({ serverId });
    return channels.map((ch) => ch._id);
  }

  // ── Channel Categories ────────────────────────────────────

  async findCategoryById(id: string) {
    return db.channelCategories.findOne({ _id: id });
  }

  async findCategoriesByServer(serverId: string) {
    return db.channelCategories.find({ serverId }).sort({ position: 1 });
  }

  async findCategoryByIdAndServer(id: string, serverId: string) {
    return db.channelCategories.findOne({ _id: id, serverId });
  }

  async countCategories(serverId: string) {
    return db.channelCategories.count({ serverId });
  }

  async insertCategory(data: Record<string, unknown>) {
    return db.channelCategories.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async updateCategory(id: string, serverId: string, fields: Record<string, unknown>) {
    return db.channelCategories.update({ _id: id, serverId }, { $set: fields });
  }

  async deleteCategory(id: string, serverId: string) {
    return db.channelCategories.remove({ _id: id, serverId });
  }

  /**
   * Unlink channels and delete the category as one PostgreSQL transaction.
   * Returns false when the scoped category does not exist.
   */
  async deleteCategoryAtomic(id: string, serverId: string): Promise<boolean> {
    const rawPool = (db as unknown as { _pool?: import('pg').Pool })._pool;
    const pool = postgresPoolOrTestFallback(rawPool?.connect ? rawPool : null, 'ChannelRepository atomic operation');
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const locked = await client.query(
          'SELECT _id FROM channel_categories WHERE _id=$1 AND "serverId"=$2 FOR UPDATE',
          [id, serverId],
        );
        if (!locked.rows.length) {
          await client.query('ROLLBACK');
          return false;
        }
        await client.query('UPDATE channels SET "categoryId"=NULL WHERE "serverId"=$1 AND "categoryId"=$2', [serverId, id]);
        await client.query('DELETE FROM channel_categories WHERE _id=$1 AND "serverId"=$2', [id, serverId]);
        await client.query('COMMIT');
        return true;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
        throw err;
      } finally {
        client.release();
      }
    }

    const existing = await db.channelCategories.findOne({ _id: id, serverId });
    if (!existing) return false;
    await this.unlinkCategory(id, serverId);
    await this.deleteCategory(id, serverId);
    return true;
  }

  /** Atomically apply a complete validated category position set. */
  async reorderCategoriesAtomic(serverId: string, order: Array<{ id: string; position: number }>): Promise<boolean> {
    const rawPool = (db as unknown as { _pool?: import('pg').Pool })._pool;
    const pool = postgresPoolOrTestFallback(rawPool?.connect ? rawPool : null, 'ChannelRepository atomic operation');
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const ids = order.map((item) => item.id);
        const locked = await client.query<{ _id: string }>(
          'SELECT _id FROM channel_categories WHERE "serverId"=$1 AND _id = ANY($2::text[]) FOR UPDATE',
          [serverId, ids],
        );
        if (locked.rows.length !== ids.length) {
          await client.query('ROLLBACK');
          return false;
        }
        for (const item of order) {
          await client.query(
            'UPDATE channel_categories SET position=$1 WHERE _id=$2 AND "serverId"=$3',
            [item.position, item.id, serverId],
          );
        }
        await client.query('COMMIT');
        return true;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
        throw err;
      } finally {
        client.release();
      }
    }

    for (const item of order) {
      const existing = await db.channelCategories.findOne({ _id: item.id, serverId });
      if (!existing) return false;
    }
    for (const item of order) await this.updateCategory(item.id, serverId, { position: item.position });
    return true;
  }

  /** Bir kategoriye bağlı kanalların categoryId'sini null yapar. */
  async unlinkCategory(catId: string, serverId: string) {
    return db.channels.update({ serverId, categoryId: catId }, { $set: { categoryId: null } });
  }

  /** Discord-benzeri kanal izin override'ları (@everyone / rol / kullanıcı). */
  async findOverridesByChannel(channelId: string) {
    return db.channelOverrides.find({ channelId }) ?? [];
  }
}

export default new ChannelRepository();
