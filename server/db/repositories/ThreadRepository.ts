// server/db/repositories/ThreadRepository.ts
// Thread ve thread mesajı sorgularını tek noktada toplar.

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';
import { postgresPoolOrTestFallback } from './postgresInvariant';

class ThreadRepository {
  private parentCreateTail: Promise<void> = Promise.resolve();

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

  /**
   * Create the single thread for a parent message and tag the parent in the
   * same PostgreSQL transaction. Locking the parent row serializes concurrent
   * creates without requiring callers to rely on a racy find-then-insert.
   */
  async createForParentAtomic(data: Record<string, unknown>): Promise<{ thread: Record<string, unknown>; created: boolean }> {
    const parentMessageId = typeof data.parentMessageId === 'string' ? data.parentMessageId.trim() : '';
    const channelId = typeof data.channelId === 'string' ? data.channelId.trim() : '';
    const serverId = typeof data.serverId === 'string' ? data.serverId.trim() : '';
    if (!parentMessageId || !channelId || !serverId) throw new TypeError('invalid parent thread scope');

    const pool = postgresPoolOrTestFallback(
      (db as unknown as { _pool?: import('pg').Pool })._pool,
      'atomic thread creation',
    );
    if (!pool?.connect) {
      let release!: () => void;
      const previous = this.parentCreateTail;
      this.parentCreateTail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        // Keep the compatibility path faithful to the PostgreSQL transaction:
        // a thread may only be created while its parent still exists in the
        // requested channel/server scope. Without this check, local/test
        // runtimes could durably create an orphan that production rejects.
        const parent = await db.messages.findOne({ _id: parentMessageId, channelId, serverId });
        if (!parent) throw new Error('Parent message disappeared or changed scope');
        const existing = await db.threads.findOne({ parentMessageId });
        if (existing) return { thread: existing as unknown as Record<string, unknown>, created: false };
        const thread = await this.insert(data) as unknown as Record<string, unknown>;
        const threadId = typeof thread._id === 'string' ? thread._id : '';
        if (!threadId) throw new TypeError('thread insert returned no id');
        try {
          const tagged = await db.messages.update(
            { _id: parentMessageId, channelId, serverId },
            { $set: { threadId } },
          );
          if (tagged.updated !== 1) throw new Error('Parent message disappeared or changed scope');
        } catch (err) {
          // The in-memory adapter has no transaction engine. Compensate the
          // just-created row so callers still observe all-or-nothing creation.
          await db.threads.remove({ _id: threadId }).catch(() => undefined);
          throw err;
        }
        return { thread, created: true };
      } finally {
        release();
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<Record<string, unknown>>(
        'SELECT _id,"channelId","serverId" FROM messages WHERE _id=$1 AND "channelId"=$2 AND "serverId"=$3 FOR UPDATE',
        [parentMessageId, channelId, serverId],
      );
      if (!locked.rows[0]) {
        await client.query('ROLLBACK');
        throw new Error('Parent message disappeared or changed scope');
      }
      const existing = await client.query<Record<string, unknown>>(
        'SELECT * FROM threads WHERE "parentMessageId"=$1 ORDER BY "createdAt" ASC LIMIT 1',
        [parentMessageId],
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return { thread: existing.rows[0], created: false };
      }

      const thread = {
        _id: uuidv4(),
        channelId,
        serverId,
        parentMessageId,
        name: typeof data.name === 'string' ? data.name : '',
        createdBy: String(data.createdBy ?? ''),
        createdAt: Number(data.createdAt ?? Date.now()),
        lastMessageAt: Number(data.lastMessageAt ?? Date.now()),
        messageCount: 0,
        firstMessage: typeof data.firstMessage === 'string' ? data.firstMessage : '',
        tags: Array.isArray(data.tags) ? data.tags : [],
        participantCount: 1,
        pinned: false,
        locked: false,
      };
      if (!thread.createdBy || !Number.isSafeInteger(thread.createdAt) || !Number.isSafeInteger(thread.lastMessageAt)) {
        throw new TypeError('invalid parent thread fields');
      }
      await client.query(
        `INSERT INTO threads (_id,"channelId","serverId","parentMessageId",name,"createdBy","createdAt","lastMessageAt","messageCount","firstMessage",tags,"participantCount",pinned,locked)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10::jsonb,1,FALSE,FALSE)`,
        [thread._id, channelId, serverId, parentMessageId, thread.name, thread.createdBy,
          thread.createdAt, thread.lastMessageAt, thread.firstMessage, JSON.stringify(thread.tags)],
      );
      await client.query(
        'UPDATE messages SET "threadId"=$2 WHERE _id=$1 AND "channelId"=$3 AND "serverId"=$4',
        [parentMessageId, thread._id, channelId, serverId],
      );
      await client.query('COMMIT');
      return { thread, created: true };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      throw err;
    } finally {
      client.release();
    }
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

  async findMessageByClientNonce(threadId: string, userId: string, clientNonce: string) {
    if (!threadId || !userId || !clientNonce) return null;
    return db.threadMessages.findOne({ threadId, userId, clientNonce });
  }

  async insertMessageIdempotent(data: Record<string, unknown>) {
    const threadId = String(data.threadId ?? '');
    const userId = String(data.userId ?? '');
    const clientNonce = typeof data.clientNonce === 'string' ? data.clientNonce : '';
    if (!clientNonce) return { message: await this.insertMessage(data), created: true };

    const existing = await this.findMessageByClientNonce(threadId, userId, clientNonce);
    if (existing) return { message: existing, created: false };
    try {
      return { message: await this.insertMessage(data), created: true };
    } catch (error) {
      const code = String((error as { code?: unknown })?.code ?? '');
      const text = String((error as Error)?.message ?? '');
      if (code !== '23505' && !/duplicate|unique/i.test(text)) throw error;
      const raced = await this.findMessageByClientNonce(threadId, userId, clientNonce);
      if (!raced) throw error;
      return { message: raced, created: false };
    }
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
