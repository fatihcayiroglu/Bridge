// Personal Saved / Follow-up identifiers. No message metadata is persisted.

import db from '../loader';

export type SavedDestinationType = 'channel' | 'dm' | 'gdm';

class SavedMessageRepository {
  async save(input: {
    userId: string;
    destinationType: SavedDestinationType;
    destinationId: string;
    messageId: string;
  }): Promise<{ row: Record<string, unknown>; created: boolean }> {
    const _id = `saved:${input.userId}:${input.destinationType}:${input.messageId}`;
    const existing = await db.savedMessages.findOne({ _id });
    if (existing) return { row: existing as Record<string, unknown>, created: false };

    try {
      const row = await db.savedMessages.insert({ _id, ...input, createdAt: Date.now() });
      return { row: row as Record<string, unknown>, created: true };
    } catch (error) {
      const code = String((error as { code?: unknown })?.code ?? '');
      if (code !== '23505' && !/duplicate|unique/i.test(String((error as Error)?.message ?? ''))) throw error;
      const raced = await db.savedMessages.findOne({
        userId: input.userId,
        destinationType: input.destinationType,
        messageId: input.messageId,
      });
      if (!raced) throw error;
      return { row: raced as Record<string, unknown>, created: false };
    }
  }

  async findForUser(userId: string, limit = 100) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('Invalid saved-message limit');
    return db.savedMessages
      .find({ userId })
      .sort({ createdAt: -1, _id: -1 })
      .limit(Math.min(limit, 200));
  }

  async findByIdForUser(userId: string, id: string) {
    return db.savedMessages.findOne({ _id: id, userId }) as Promise<Record<string, unknown> | null>;
  }

  async setReminder(userId: string, id: string, remindAt: number) {
    return db.savedMessages.update(
      { _id: id, userId },
      { $set: { remindAt, remindedAt: null } },
    );
  }

  async clearReminder(userId: string, id: string) {
    return db.savedMessages.update(
      { _id: id, userId },
      { $set: { remindAt: null, remindedAt: null } },
    );
  }

  async findDueReminders(now: number, limit = 100): Promise<Record<string, unknown>[]> {
    if (!Number.isSafeInteger(now) || now <= 0) throw new TypeError('Invalid reminder clock');
    return db.savedMessages.find({ remindAt: { $lte: now }, remindedAt: null })
      .sort({ remindAt: 1, _id: 1 }).limit(Math.min(Math.max(limit, 1), 500)) as unknown as Promise<Record<string, unknown>[]>;
  }

  async markReminded(id: string, remindAt: number, deliveredAt: number) {
    return db.savedMessages.update(
      { _id: id, remindAt, remindedAt: null },
      { $set: { remindedAt: deliveredAt } },
    );
  }

  async removeForUser(userId: string, id: string) {
    return db.savedMessages.remove({ _id: id, userId });
  }
}

export default new SavedMessageRepository();
