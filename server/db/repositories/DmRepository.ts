// server/db/repositories/DmRepository.ts
// DM konuşmaları ve mesajlarını tek noktada toplar.

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';

class DmRepository {
  // ── Conversations ──────────────────────────────────────────

  async findConversation(id: string) {
    return db.dmConversations.findOne({ _id: id });
  }

  /** İki kullanıcı arasındaki deterministik DM ID'sini üretir. */
  static buildDmId(a: string, b: string) {
    return [a, b].sort().join('_');
  }

  /** Instance-level access for canonical callers that receive the repository singleton. */
  buildDmId(a: string, b: string) {
    return DmRepository.buildDmId(a, b);
  }

  async findConversationsByUser(userId: string) {
    // `participants` JSONB bir DİZİDİR. Skaler eşitlik PostgreSQL'de
    // "invalid input syntax for type json" ile patlıyordu (bu uç üretimde
    // 500 dönüyordu). Üyelik açıkça containment ile sorgulanır.
    return db.dmConversations.find({ participants: { $contains: userId } });
  }

  /**
   * Faz 10 — OKUNDU İMLECİ.
   *
   * Faz 10.3 okunmamış sayacını `readAt` imlecinden TÜRETİYORDU, ancak imleci
   * YAZAN taraf hiç uygulanmamıştı: istemci `dm:read` yayıyor, sunucuda
   * karşılığı yoktu. Sonuç: okunmamış sayacı hiçbir zaman sıfırlanamıyordu.
   *
   * Yetki burada uygulanır: yalnız KONUŞMANIN KATILIMCISI kendi imlecini
   * güncelleyebilir. Başka bir kullanıcının imleci hiçbir koşulda yazılmaz.
   */
  async markReadWithReceipt(
    dmId: string,
    userId: string,
  ): Promise<{ participants: string[]; readAt: number } | null> {
    if (!dmId || !userId) return null;

    // Unit tests use the isolated in-memory collection. Production takes a
    // PostgreSQL row lock so two participants marking the same DM read at the
    // same time cannot overwrite each other's JSONB cursor entry.
    if (process.env.NODE_ENV === 'test') {
      const conv = await db.dmConversations.findOne({ _id: dmId });
      if (!conv) return null;
      const participants = Array.isArray(conv.participants) ? conv.participants.map(String) : [];
      if (!participants.includes(userId)) return null;
      const now = Date.now();
      const current = (conv.readAt && typeof conv.readAt === 'object')
        ? conv.readAt as Record<string, number>
        : {};
      await db.dmConversations.update({ _id: dmId }, { $set: { readAt: { ...current, [userId]: now } } });
      return { participants, readAt: now };
    }

    const pool = (db as unknown as { _pool?: import('pg').Pool })._pool;
    if (!pool) throw new Error('PostgreSQL pool unavailable for atomic DM read receipt');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query<{
        participants: string[];
        readAt: Record<string, number> | null;
      }>(
        'SELECT participants, "readAt" FROM dm_conversations WHERE _id = $1 FOR UPDATE',
        [dmId],
      );
      if (!found.rows.length) {
        await client.query('ROLLBACK');
        return null;
      }

      const row = found.rows[0]!;
      const participants = Array.isArray(row.participants) ? row.participants.map(String) : [];
      if (!participants.includes(userId)) {
        await client.query('ROLLBACK');
        return null;
      }

      const now = Date.now();
      const current = row.readAt && typeof row.readAt === 'object' ? row.readAt : {};
      const nextReadAt = { ...current, [userId]: now };
      const updated = await client.query(
        'UPDATE dm_conversations SET "readAt" = $2::jsonb WHERE _id = $1',
        [dmId, JSON.stringify(nextReadAt)],
      );
      if ((updated.rowCount ?? 0) !== 1) throw new Error('DM conversation disappeared while row lock was held');
      await client.query('COMMIT');
      return { participants, readAt: now };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async markRead(dmId: string, userId: string): Promise<boolean> {
    return Boolean(await this.markReadWithReceipt(dmId, userId));
  }

  /** İki kullanıcı arasındaki konuşmayı getirir; yoksa oluşturur. */
  async findConversationByParticipants(userId: string, toUserId: string) {
    const dmId = DmRepository.buildDmId(userId, toUserId);
    return db.dmConversations.findOne({ _id: dmId });
  }

  async findOrCreateConversation(userId: string, toUserId: string) {
    const dmId = DmRepository.buildDmId(userId, toUserId);
    let conv   = await db.dmConversations.findOne({ _id: dmId });
    if (!conv) {
      conv = await db.dmConversations.insert({
        _id: dmId,
        participants: [userId, toUserId],
        createdAt: Date.now(),
        lastMessageAt: Date.now(),
      });
    } else {
      await db.dmConversations.update({ _id: dmId }, { $set: { lastMessageAt: Date.now() } });
    }
    return { conv, dmId };
  }

  async touchConversation(id: string) {
    return db.dmConversations.update({ _id: id }, { $set: { lastMessageAt: Date.now() } });
  }

  // ── Messages ───────────────────────────────────────────────

  /**
   * DM geçmişini en yeniden eskiye doğru sayfalar.
   *
   * CURSOR BÜTÜNLÜĞÜ (Faz 10.2): Eskiden yalnız `createdAt < before`
   * kullanılıyordu. `createdAt` milisaniye çözünürlüğünde olduğu için aynı
   * ms içinde yazılan mesajlar (iki kullanıcının eşzamanlı gönderimi, mesaj
   * patlaması, içe aktarma) aynı damgayı paylaşır. Sayfa sınırı böyle bir
   * grubun içine düştüğünde `$lt` o damgadaki TÜM kayıtları eler ve kalanlar
   * geçmişte SESSİZCE KAYBOLUR.
   *
   * Çözüm: (createdAt, _id) kompozit cursor. `_id` yalnızca eşitlik
   * durumunda ayırıcıdır; sıralama da aynı çifte göre yapılır, böylece
   * sayfalar bitişik kalır.
   *
   * `beforeId` verilmezse eski davranış korunur (geriye dönük uyumluluk).
   */
  async findMessages(
    dmId: string,
    { limit = 50, before, beforeId }: { limit?: number; before?: number; beforeId?: string } = {},
  ) {
    const query: Record<string, unknown> = { dmId };
    if (before) {
      query.$or = beforeId
        ? [{ createdAt: { $lt: before } }, { createdAt: before, _id: { $lt: beforeId } }]
        : [{ createdAt: { $lt: before } }];
    }
    return db.dmMessages
      .find(query)
      .sort({ createdAt: -1, _id: -1 })
      .limit(Math.min(limit, 100));
  }

  /**
   * Bir konuşmadaki okunmamış GELEN mesaj sayısını TÜRETİR.
   *
   * Faz 10.3 — yeni tablo/kolon yok. Mevcut kalıcı veriden hesaplanır:
   *   - okundu imleci: dmConversations.readAt[userId]  (bu repository yazar)
   *   - mesaj zamanı : dmMessages.createdAt
   *   - gönderen     : dmMessages.userId
   *
   * Kurallar:
   *   - yalnız KARŞI tarafın mesajları sayılır (kendi mesajın okunmamış olmaz)
   *   - readAt'ten SONRA gelenler sayılır (`$gt`, sınırdaki okunan tekrar sayılmaz)
   *   - readAt yoksa gelen mesajların tamamı sayılır
   *
   * SALT OKUMA: hiçbir durum değiştirmez; GET yolları güvenle çağırabilir.
   */
  async countUnread(dmId: string, userId: string, readAt?: number): Promise<number> {
    if (!dmId || !userId) return 0;
    const query: Record<string, unknown> = { dmId, userId: { $ne: userId } };
    if (typeof readAt === 'number' && readAt > 0) query.createdAt = { $gt: readAt };
    return db.dmMessages.count(query);
  }

  /** Latest incoming unread message for the unified inbox preview. */
  async findLatestUnread(dmId: string, userId: string, readAt?: number) {
    const query: Record<string, unknown> = { dmId, userId: { $ne: userId } };
    if (typeof readAt === 'number' && readAt > 0) query.createdAt = { $gt: readAt };
    const rows = await db.dmMessages.find(query).sort({ createdAt: -1, _id: -1 }).limit(1);
    return rows[0] ?? null;
  }

  async findMessage(id: string, dmId: string) {
    return db.dmMessages.findOne({ _id: id, dmId });
  }

  /** Durable idempotency owner for optimistic DM sends. */
  async findByClientNonce(userId: string, clientNonce: string) {
    if (!userId || !clientNonce) return null;
    return db.dmMessages.findOne({ userId, clientNonce });
  }

  async insertMessage(data: Record<string, unknown>) {
    return db.dmMessages.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async updateMessage(id: string, fields: Record<string, unknown>) {
    return db.dmMessages.update({ _id: id }, { $set: fields });
  }

  async countMessages() {
    return db.dmMessages.count({});
  }

  async findMessagesWhere(query: Record<string, unknown>) {
    return db.dmMessages.find(query) ?? [];
  }
}

export default new DmRepository();
