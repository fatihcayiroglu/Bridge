// server/db/repositories/ScheduledMessageRepository.ts
// Zamanlanmış mesaj sorgularını tek noktada toplar.

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';

class ScheduledMessageRepository {
  async findPending(userId: string) {
    return db.scheduledMsgs.find({ userId, sent: false }).sort({ sendAt: 1 });
  }

  async findById(id: string, userId: string) {
    return db.scheduledMsgs.findOne({ _id: id, userId });
  }

  async insert(data: Record<string, unknown>) {
    return db.scheduledMsgs.insert({ _id: uuidv4(), createdAt: Date.now(), sent: false, ...data });
  }

  async delete(id: string) {
    return db.scheduledMsgs.remove({ _id: id });
  }

  async deleteByServer(serverId: string) {
    return db.scheduledMsgs?.remove({ serverId });
  }

  async markSent(id: string, sentAt = Date.now()) {
    return db.scheduledMsgs.update({ _id: id }, { $set: { sent: true, sentAt } });
  }

  async findDueBefore(timestamp: number) {
    return db.scheduledMsgs.find({ sent: false, sendAt: { $lte: timestamp } });
  }
}

export default new ScheduledMessageRepository();
