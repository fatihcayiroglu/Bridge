// server/db/repositories/GroupDmRepository.ts
// Grup DM konuşmaları, üyelikleri ve mesajlarını tek noktada toplar.

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';
import { withTransaction } from '../postgres/transaction';

class GroupDmRepository {
  // ── Conversations ──────────────────────────────────────────

  async findById(id: string) {
    return db.groupDmConversations.findOne({ _id: id });
  }

  /**
   * ══════════════════════════════════════════════════════════════════════════
   * ATOMIK GRUP DM OLUSTURMA (canli kusurdan sonra eklendi)
   * ══════════════════════════════════════════════════════════════════════════
   * BULUNAN KUSUR: rota UC AYRI yazma yapiyordu — grup satiri, uyelik
   * satirlari, sistem mesaji — ve ARDINDAN zenginlestirme (okuma) yapiyordu.
   * Zenginlestirme patlayinca istek 500 donuyor ama UC YAZMA DA KALICI
   * kaliyordu. Sonuc: yetim/yinelenen grup; kullanici tekrar denedikce
   * yenisi olusuyordu. (Canli olcumde tam olarak bu gerceklesti.)
   *
   * NEDEN HAM SQL: `withTransaction` bir PoolClient verir, ancak
   * `PgCollection._query` her cagrida havuzdan KENDI baglantisini alir
   * (postgres/pgCollection.ts). Yani `db.groupDmMembers.insert(...)` gibi
   * repository cagrilari transaction'in BEGIN'ine KATILMAZ ve rollback
   * onlari geri almaz. Ayni gerekce `ServerAssetRepository` icin de
   * belgelenmistir; oradaki desen birebir izlenir.
   *
   * DEGISMEZ: ya UCU DE kalici olur, ya da HICBIRI kalmaz.
   */
  async createAtomic(input: {
    group: { _id: string; name: string; ownerId: string; icon: string | null; createdAt: number; lastMessageAt: number };
    memberIds: string[];
    systemMessage: { _id: string; userId: string; displayName: string; avatarColor: string; content: string; type: string; createdAt: number };
  }): Promise<Record<string, unknown>> {
    const { group, memberIds, systemMessage } = input;

    return withTransaction(async (client) => {
      const g = await client.query(
        `INSERT INTO group_dm_conversations (_id, name, "ownerId", icon, "createdAt", "lastMessageAt")
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [group._id, group.name, group.ownerId, group.icon, group.createdAt, group.lastMessageAt],
      );

      // Toplu uyelik — tek sorgu, unnest ile.
      const ids = memberIds.map(() => uuidv4());
      const joined = memberIds.map(() => Date.now());
      await client.query(
        `INSERT INTO group_dm_members (_id, "groupId", "userId", "joinedAt")
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::bigint[])`,
        [ids, memberIds.map(() => group._id), memberIds, joined],
      );

      await client.query(
        `INSERT INTO group_dm_messages (_id, "groupId", "userId", "displayName", "avatarColor", content, type, reactions, "createdAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, $8)`,
        [systemMessage._id, group._id, systemMessage.userId, systemMessage.displayName,
         systemMessage.avatarColor, systemMessage.content, systemMessage.type, systemMessage.createdAt],
      );

      return g.rows[0] as Record<string, unknown>;
    });
  }

  async create(data: Record<string, unknown>) {
    return db.groupDmConversations.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async update(id: string, fields: Record<string, unknown>) {
    return db.groupDmConversations.update({ _id: id }, { $set: fields });
  }

  async delete(id: string) {
    return db.groupDmConversations.remove({ _id: id });
  }

  // ── Members ────────────────────────────────────────────────

  async findMember(groupId: string, userId: string) {
    return db.groupDmMembers.findOne({ groupId, userId });
  }

  async findMembers(groupId: string) {
    return db.groupDmMembers.find({ groupId });
  }

  async findGroupsByUser(userId: string) {
    return db.groupDmMembers.find({ userId });
  }

  /** Only a current member may advance their own canonical read cursor. */
  async markRead(groupId: string, userId: string): Promise<boolean> {
    const member = await this.findMember(groupId, userId);
    if (!member) return false;
    await db.groupDmMembers.update({ groupId, userId }, { $set: { readAt: Date.now() } });
    return true;
  }

  async countUnread(groupId: string, userId: string, after?: number): Promise<number> {
    const query: Record<string, unknown> = { groupId, userId: { $ne: userId }, type: { $ne: 'system' } };
    if (typeof after === 'number' && after > 0) query.createdAt = { $gt: after };
    return db.groupDmMessages.count(query);
  }

  async findLatestUnread(groupId: string, userId: string, after?: number) {
    const query: Record<string, unknown> = { groupId, userId: { $ne: userId }, type: { $ne: 'system' } };
    if (typeof after === 'number' && after > 0) query.createdAt = { $gt: after };
    const rows = await db.groupDmMessages.find(query).sort({ createdAt: -1, _id: -1 }).limit(1);
    return rows[0] ?? null;
  }

  async countMembers(groupId: string) {
    return db.groupDmMembers.count({ groupId });
  }

  async addMember(groupId: string, userId: string) {
    return db.groupDmMembers.insert({ _id: uuidv4(), groupId, userId, joinedAt: Date.now() });
  }

  /** Çoklu üyeleri tek sorguda ekle — N+1 optimizasyonu */
  async addMembersMany(groupId: string, userIds: string[]): Promise<void> {
    if (!userIds || userIds.length === 0) return;
    const docs = userIds.map(userId => ({
      _id: uuidv4(),
      groupId,
      userId,
      joinedAt: Date.now(),
    }));
    // insertMany varsa kullan, yoksa loop'ta yapıştır ama en azından batch halinde
    if (typeof db.groupDmMembers.insertMany === 'function') {
      await db.groupDmMembers.insertMany(docs);
    } else {
      // Fallback: tek sorguda tüm docs'ları insert et
      for (const doc of docs) {
        await db.groupDmMembers.insert(doc);
      }
    }
  }

  async removeMember(groupId: string, userId: string) {
    return db.groupDmMembers.remove({ groupId, userId });
  }

  /** Çoklu üyeleri kaldır */
  async removeMembersMany(groupId: string, userIds: string[]): Promise<void> {
    if (!userIds || userIds.length === 0) return;
    for (const userId of userIds) {
      await db.groupDmMembers.remove({ groupId, userId });
    }
  }

  async removeAllMembers(groupId: string) {
    return db.groupDmMembers.remove({ groupId });
  }

  /** Sahipliği ilk kalan üyeye devreder; üye yoksa null döner. */
  async transferOwnership(groupId: string) {
    const next = await db.groupDmMembers.findOne({ groupId });
    if (next) await this.update(groupId, { ownerId: next.userId });
    return next;
  }

  // ── Messages ───────────────────────────────────────────────

  /**
   * Grup DM geçmişini en yeniden eskiye sayfalar.
   *
   * CURSOR BÜTÜNLÜĞÜ (Faz 10.6B): Eskiden yalnız `createdAt < before`
   * kullanılıyordu. `createdAt` milisaniye çözünürlüklü olduğu için aynı ms
   * içinde yazılan mesajlar (grup sohbetinde eşzamanlı gönderim çok olası)
   * aynı damgayı paylaşır; sayfa sınırı böyle bir grubun içine düştüğünde
   * `$lt` o damgadaki TÜM kayıtları eler ve geçmişte kalıcı boşluk oluşur.
   * DM tarafında kanıtlanan hatanın aynısıydı (bkz. DmRepository).
   *
   * Çözüm: (createdAt, _id) kompozit cursor; sıralama da aynı çifte göre.
   * `beforeId` verilmezse eski davranış korunur (geriye dönük uyumluluk).
   */
  async findMessages(
    groupId: string,
    { limit = 50, before, beforeId }: { limit?: number; before?: number; beforeId?: string } = {},
  ) {
    const query: Record<string, unknown> = { groupId };
    if (before) {
      query.$or = beforeId
        ? [{ createdAt: { $lt: before } }, { createdAt: before, _id: { $lt: beforeId } }]
        : [{ createdAt: { $lt: before } }];
    }
    return db.groupDmMessages
      .find(query)
      .sort({ createdAt: -1, _id: -1 })
      .limit(Math.min(limit, 100));
  }

  async insertMessage(data: Record<string, unknown>) {
    return db.groupDmMessages.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async findMessage(id: string, groupId: string) {
    return db.groupDmMessages.findOne({ _id: id, groupId });
  }

  /** Durable idempotency owner for optimistic group-DM sends. */
  async findByClientNonce(userId: string, clientNonce: string) {
    if (!userId || !clientNonce) return null;
    return db.groupDmMessages.findOne({ userId, clientNonce });
  }

  async removeMessages(groupId: string) {
    return db.groupDmMessages.remove({ groupId });
  }

  /** Grup ve tüm bağlı verisini (üyeler + mesajlar) siler. */
  async deleteGroup(groupId: string) {
    await this.removeMessages(groupId);
    await this.removeAllMembers(groupId);
    await this.delete(groupId);
  }
}

export default new GroupDmRepository();
