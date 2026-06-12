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

  async findConversationsByUser(userId: string) {
    return db.dmConversations.find({ participants: userId });
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

  async findMessages(dmId: string, { limit = 50, before }: { limit?: number; before?: number } = {}) {
    const query: Record<string, unknown> = { dmId };
    if (before) query.createdAt = { $lt: before };
    return db.dmMessages.find(query).sort({ createdAt: -1 }).limit(Math.min(limit, 100));
  }

  async findMessage(id: string, dmId: string) {
    return db.dmMessages.findOne({ _id: id, dmId });
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
    return db.dmMessages?.find(query) ?? [];
  }
}

export default new DmRepository();
