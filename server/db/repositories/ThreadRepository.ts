// @ts-nocheck
// server/db/repositories/ThreadRepository.js
// Thread ve thread mesajı sorgularını tek noktada toplar.

'use strict';
const { v4: uuidv4 } = require('uuid');
const db = require('../loader');

class ThreadRepository {
  // ── Threads ────────────────────────────────────────────────

  async findById(id) {
    return db.threads.findOne({ _id: id });
  }

  async findByParentMessage(parentMessageId) {
    return db.threads.findOne({ parentMessageId });
  }

  async findByChannel(channelId) {
    return db.threads.find({ channelId });
  }

  async insert(data) {
    return db.threads.insert({ _id: uuidv4(), createdAt: Date.now(), messageCount: 0, ...data });
  }

  async update(id, fields) {
    return db.threads.update({ _id: id }, { $set: fields });
  }

  async delete(id) {
    return db.threads.remove({ _id: id });
  }

  async setPinned(id, pinned) {
    return this.update(id, { pinned: pinned ? 1 : 0 });
  }

  async setLocked(id, locked) {
    return this.update(id, { locked: locked ? 1 : 0 });
  }

  // ── Thread Messages ────────────────────────────────────────

  async findMessages(threadId, { limit = 50, before } = {}) {
    const query = { threadId };
    if (before) query.createdAt = { $lt: before };
    return db.threadMessages.find(query).sort({ createdAt: -1 }).limit(Math.min(limit, 100));
  }

  async insertMessage(data) {
    return db.threadMessages.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async removeMessages(threadId) {
    return db.threadMessages.remove({ threadId });
  }

  /** Bildirim için thread içindeki tüm mesajları döndürür. */
  async listAllMessages(threadId) {
    return db.threadMessages.find({ threadId });
  }

  /** Yanıt sonrası thread ve isteğe bağlı ana mesaj sayaçlarını günceller. */
  async recordReply(threadId, parentMessageId) {
    await db.threads.update(
      { _id: threadId },
      { $set: { lastMessageAt: Date.now() }, $inc: { messageCount: 1 } }
    );
    if (parentMessageId) {
      await db.messages.update({ _id: parentMessageId }, { $inc: { threadCount: 1 } });
    }
  }

  /** Thread ve tüm mesajlarını birlikte siler. */
  async deleteThread(id) {
    await this.removeMessages(id);
    await this.delete(id);
  }
}

module.exports = new ThreadRepository();
export {};
