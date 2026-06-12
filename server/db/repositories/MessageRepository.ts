// server/db/repositories/MessageRepository.ts
// Mesaj sorgularını tek bir yerde toplar.
// SQLite ve PostgreSQL loader ile uyumludur — db.messages Collection API'sini kullanır.
// NOT: db/index.js buildWhere() $gt/$lt/$regex syntax'ını destekler, bu syntax kasıtlıdır.

import db from '../loader';

class MessageRepository {
  hasFtsSearch() {
    return !!db._ftsSearch;
  }

  /** FTS5 / PG arama adaptörü — loader üzerinden. */
  async ftsSearch(searchTerm: string, serverIds: string | string[], limit: number | string) {
    if (!db._ftsSearch) return [];
    return db._ftsSearch(searchTerm, Array.isArray(serverIds) ? serverIds : [serverIds], Number(limit));
  }

  /**
   * Kanal mesajlarını cursor tabanlı getirir.
   * @param {string} channelId
   * @param {object} opts - { limit, before, after, search }
   */
  async findByChannel(channelId: string, { limit = 50, before, after, search }: { limit?: number; before?: number; after?: number; search?: string } = {}) {
    const query: Record<string,unknown> = { channelId };
    if (after)       query.createdAt = { $gt: after };
    else if (before) query.createdAt = { $lt: before };
    if (search) {
      // $regex ile LIKE sorgusuna dönüştürülür (db/index.js buildWhere)
      const escaped = search.replace(/[%_\\]/g, (c: string) => `\\${c}`);
      query.content = { $regex: escaped };
    }
    const messages = await db.messages
      .find(query)
      .sort({ createdAt: -1 })
      .limit(Math.min(limit, 100));
    return messages.reverse();
  }

  async findById(id: string) {
    return db.messages.findOne({ _id: id });
  }

  async create(data: Record<string, unknown>) {
    return db.messages.insert(data);
  }

  async update(id: string, fields: Record<string, unknown>) {
    return db.messages.update({ _id: id }, { $set: fields });
  }

  /**
   * Sprint 121 FIX 17: Soft delete — mesajı fiziksel olarak silmez.
   * İçeriği '[Mesaj silindi]' ile değiştirir, deletedAt timestamp'ini ekler.
   * Moderasyon / audit trail için içerik geri getirilebilir (admin paneli).
   */
  async softDelete(id: string, deletedBy: string) {
    return db.messages.update({ _id: id }, {
      $set: {
        content:   '[Mesaj silindi]',
        deletedAt: Date.now(),
        deletedBy,
        embeds:    null,
        fileUrl:   null,
        fileName:  null,
      },
    });
  }

  /**
   * Sprint 121 FIX 18: Toplu soft delete — moderatör spam temizleme için.
   * En fazla 100 mesaj tek seferde silinebilir.
   * ids: string[] (max 100), deletedBy: moderatör userId
   */
  async bulkSoftDelete(ids: string[], deletedBy: string): Promise<number> {
    if (!ids.length) return 0;
    const limited = ids.slice(0, 100);
    let count = 0;
    for (const id of limited) {
      await this.softDelete(id, deletedBy);
      count++;
    }
    return count;
  }

  async delete(id: string) {
    return db.messages.remove({ _id: id });
  }

  async deleteByChannel(channelId: string) {
    return db.messages.remove({ channelId });
  }

  async count(query = {}) {
    return db.messages.count(query);
  }

  async removeByUser(userId: string) {
    return db.messages.remove({ userId });
  }

  async deleteUserMessages(userId: string, serverId?: string, since?: Date | number) {
    const query: Record<string, unknown> = { userId };
    if (serverId) query.serverId = serverId;
    if (since) query.createdAt = { $gt: since instanceof Date ? since.getTime() : since };
    return db.messages.remove(query);
  }

  async removeByServer(serverId: string) {
    return db.messages.remove({ serverId });
  }

  async findProjected(query: Record<string, unknown>, options?: Record<string, unknown>) {
    return db.messages.find(query, options);
  }

  async findWhere(query: Record<string, unknown>) {
    return db.messages.find(query);
  }

  /** Zincir (.sort/.skip/.limit) için ham find. */
  messagesFind(query: Record<string, unknown>) {
    return db.messages.find(query);
  }

  async findPinsInChannel(channelId: string, limit = 50) {
    return db.messages.find({ channelId, pinned: true }).sort({ createdAt: -1 }).limit(limit);
  }

  /** Ana kanal mesajındaki thread bağlantısını sıfırlar (forum thread silindiğinde). */
  async clearThreadFromParent(parentMessageId?: string | null) {
    if (!parentMessageId) return null;
    return db.messages.update({ _id: parentMessageId }, { $set: { threadId: null, threadCount: 0 } });
  }

  async countByChannel(channelId: string) {
    return db.messages.count({ channelId });
  }

  async findPinned(channelId: string) {
    return db.messages.find({ channelId, pinned: 1 }).sort({ createdAt: -1 });
  }

  /**
   * Birden fazla kanal için son mesaj timestamp'lerini getirir.
   * Kanal listesi sidebar'ı için unread göstergesi hesaplamada kullanılır.
   * @param {string[]} channelIds
   * @returns {Promise<{channelId: string, lastAt: number}[]>}
   */
  async findLastTimestamps(channelIds: string) {
    if (!channelIds?.length) return [];
    if (db._pool?.query) {
      const { rows } = await db._pool.query(
        `SELECT "channelId", MAX("createdAt") AS "lastAt"
         FROM messages
         WHERE "channelId" = ANY($1)
         GROUP BY "channelId"`,
        [channelIds]
      );
      return rows.map((r: Record<string,unknown>) => ({ channelId: r.channelId, lastAt: Number(r.lastAt) }));
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

export default new MessageRepository();
