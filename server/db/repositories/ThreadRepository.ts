// server/db/repositories/ThreadRepository.ts
// Thread ve thread mesajı sorgularını tek noktada toplar.

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';

class ThreadRepository {
  // ── Threads ────────────────────────────────────────────────

  async findById(id: string) {
    return db.threads.findOne({ _id: id });
  }

  async findByParentMessage(parentMessageId: string) {
    return db.threads.findOne({ parentMessageId });
  }

  async findByChannel(channelId: string) {
    return db.threads.find({ channelId });
  }

  async insert(data: Record<string, unknown>) {
    return db.threads.insert({ _id: uuidv4(), createdAt: Date.now(), messageCount: 0, ...data });
  }

  async update(id: string, fields: Record<string, unknown>) {
    return db.threads.update({ _id: id }, { $set: fields });
  }

  async delete(id: string) {
    return db.threads.remove({ _id: id });
  }

  async setPinned(id: string, pinned: boolean) {
    return this.update(id, { pinned: pinned ? 1 : 0 });
  }

  async setLocked(id: string, locked: boolean) {
    return this.update(id, { locked: locked ? 1 : 0 });
  }

  // ── Thread Messages ────────────────────────────────────────

  async findMessages(threadId: string, { limit = 50, before }: { limit?: number; before?: number } = {}) {
    const query: Record<string, unknown> = { threadId };
    if (before) query.createdAt = { $lt: before };
    return db.threadMessages.find(query).sort({ createdAt: -1 }).limit(Math.min(limit, 100));
  }

  async insertMessage(data: Record<string, unknown>) {
    return db.threadMessages.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async removeMessages(threadId: string) {
    return db.threadMessages.remove({ threadId });
  }

  /** Bildirim için thread içindeki tüm mesajları döndürür. */
  async listAllMessages(threadId: string) {
    return db.threadMessages.find({ threadId });
  }

  /** Yanıt sonrası thread ve isteğe bağlı ana mesaj sayaçlarını günceller. */
  async recordReply(threadId: string, parentMessageId?: string | null) {
    await db.threads.update(
      { _id: threadId },
      { $set: { lastMessageAt: Date.now() }, $inc: { messageCount: 1 } }
    );
    if (parentMessageId) {
      await db.messages.update({ _id: parentMessageId }, { $inc: { threadCount: 1 } });
    }
  }

  /** Thread ve tüm mesajlarını birlikte siler. */
  async deleteThread(id: string) {
    await this.removeMessages(id);
    await this.delete(id);
  }
}

export default new ThreadRepository();
