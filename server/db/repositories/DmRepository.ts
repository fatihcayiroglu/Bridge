// @ts-nocheck
// server/db/repositories/DmRepository.js
// DM konuşmaları ve mesajlarını tek noktada toplar.

'use strict';
const { v4: uuidv4 } = require('uuid');
const db = require('../loader');

class DmRepository {
  // ── Conversations ──────────────────────────────────────────

  async findConversation(id) {
    return db.dmConversations.findOne({ _id: id });
  }

  /** İki kullanıcı arasındaki deterministik DM ID'sini üretir. */
  static buildDmId(a, b) {
    return [a, b].sort().join('_');
  }

  async findConversationsByUser(userId) {
    return db.dmConversations.find({ participants: userId });
  }

  /** İki kullanıcı arasındaki konuşmayı getirir; yoksa oluşturur. */
  async findOrCreateConversation(userId, toUserId) {
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

  async touchConversation(id) {
    return db.dmConversations.update({ _id: id }, { $set: { lastMessageAt: Date.now() } });
  }

  // ── Messages ───────────────────────────────────────────────

  async findMessages(dmId, { limit = 50, before } = {}) {
    const query = { dmId };
    if (before) query.createdAt = { $lt: before };
    return db.dmMessages.find(query).sort({ createdAt: -1 }).limit(Math.min(limit, 100));
  }

  async findMessage(id, dmId) {
    return db.dmMessages.findOne({ _id: id, dmId });
  }

  async insertMessage(data) {
    return db.dmMessages.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async updateMessage(id, fields) {
    return db.dmMessages.update({ _id: id }, { $set: fields });
  }

  async countMessages() {
    return db.dmMessages.count({});
  }

  async findMessagesWhere(query) {
    return db.dmMessages?.find(query) ?? [];
  }
}

module.exports = new DmRepository();
export {};
