// @ts-nocheck
// server/db/repositories/MessageRepository.js
// Mesaj sorgularını tek bir yerde toplar.
// SQLite ve PostgreSQL loader ile uyumludur — db.messages Collection API'sini kullanır.
// NOT: db/index.js buildWhere() $gt/$lt/$regex syntax'ını destekler, bu syntax kasıtlıdır.

const db = require('../loader');

class MessageRepository {
  hasFtsSearch() {
    return !!db._ftsSearch;
  }

  /** FTS5 / PG arama adaptörü — loader üzerinden. */
  async ftsSearch(searchTerm, serverIds, limit) {
    if (!db._ftsSearch) return [];
    return db._ftsSearch(searchTerm, serverIds, limit);
  }

  /**
   * Kanal mesajlarını cursor tabanlı getirir.
   * @param {string} channelId
   * @param {object} opts - { limit, before, after, search }
   */
  async findByChannel(channelId, { limit = 50, before, after, search } = {}) {
    const query = { channelId };
    if (after)       query.createdAt = { $gt: after };
    else if (before) query.createdAt = { $lt: before };
    if (search) {
      // $regex ile LIKE sorgusuna dönüştürülür (db/index.js buildWhere)
      const escaped = search.replace(/[%_\\]/g, c => `\\${c}`);
      query.content = { $regex: escaped };
    }
    const messages = await db.messages
      .find(query)
      .sort({ createdAt: -1 })
      .limit(Math.min(limit, 100));
    return messages.reverse();
  }

  async findById(id) {
    return db.messages.findOne({ _id: id });
  }

  async create(data) {
    return db.messages.insert(data);
  }

  async update(id, fields) {
    return db.messages.update({ _id: id }, { $set: fields });
  }

  async delete(id) {
    return db.messages.remove({ _id: id });
  }

  async deleteByChannel(channelId) {
    return db.messages.remove({ channelId });
  }

  async count(query = {}) {
    return db.messages.count(query);
  }

  async removeByUser(userId) {
    return db.messages.remove({ userId });
  }

  async removeByServer(serverId) {
    return db.messages.remove({ serverId });
  }

  async findProjected(query, options) {
    return db.messages.find(query, options);
  }

  async findWhere(query) {
    return db.messages.find(query);
  }

  /** Zincir (.sort/.skip/.limit) için ham find. */
  messagesFind(query) {
    return db.messages.find(query);
  }

  async findPinsInChannel(channelId, limit = 50) {
    return db.messages.find({ channelId, pinned: true }).sort({ createdAt: -1 }).limit(limit);
  }

  /** Ana kanal mesajındaki thread bağlantısını sıfırlar (forum thread silindiğinde). */
  async clearThreadFromParent(parentMessageId) {
    if (!parentMessageId) return null;
    return db.messages.update({ _id: parentMessageId }, { $set: { threadId: null, threadCount: 0 } });
  }

  async countByChannel(channelId) {
    return db.messages.count({ channelId });
  }

  async findPinned(channelId) {
    return db.messages.find({ channelId, pinned: 1 }).sort({ createdAt: -1 });
  }

  /**
   * Birden fazla kanal için son mesaj timestamp'lerini getirir.
   * Kanal listesi sidebar'ı için unread göstergesi hesaplamada kullanılır.
   * @param {string[]} channelIds
   * @returns {Promise<{channelId: string, lastAt: number}[]>}
   */
  async findLastTimestamps(channelIds) {
    if (!channelIds?.length) return [];
    if (db._pool?.query) {
      const { rows } = await db._pool.query(
        `SELECT "channelId", MAX("createdAt") AS "lastAt"
         FROM messages
         WHERE "channelId" = ANY($1)
         GROUP BY "channelId"`,
        [channelIds]
      );
      return rows.map(r => ({ channelId: r.channelId, lastAt: Number(r.lastAt) }));
    }
    // $in destekli toplu sorgu — N ayrı findOne yerine tek sorgu
    const rows = await db.messages.find({ channelId: { $in: channelIds } })
      .sort({ createdAt: -1 });
    // Her kanal için ilk (en son) mesajı al
    const seen = new Set();
    const result = [];
    for (const m of rows) {
      if (!seen.has(m.channelId)) {
        seen.add(m.channelId);
        result.push({ channelId: m.channelId, lastAt: m.createdAt });
      }
    }
    return result;
  }
}

module.exports = new MessageRepository();
export {};
