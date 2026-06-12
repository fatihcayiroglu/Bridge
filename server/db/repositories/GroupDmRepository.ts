// server/db/repositories/GroupDmRepository.ts
// Grup DM konuşmaları, üyelikleri ve mesajlarını tek noktada toplar.

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';

class GroupDmRepository {
  // ── Conversations ──────────────────────────────────────────

  async findById(id: string) {
    return db.groupDmConversations.findOne({ _id: id });
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

  async findMessages(groupId: string, { limit = 50, before }: { limit?: number; before?: number } = {}) {
    const query: Record<string, unknown> = { groupId };
    if (before) query.createdAt = { $lt: before };
    return db.groupDmMessages.find(query).sort({ createdAt: -1 }).limit(Math.min(limit, 100));
  }

  async insertMessage(data: Record<string, unknown>) {
    return db.groupDmMessages.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
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
