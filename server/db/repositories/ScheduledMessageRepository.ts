// server/db/repositories/ScheduledMessageRepository.js
// Zamanlanmış mesaj sorgularını tek noktada toplar.

'use strict';
const { v4: uuidv4 } = require('uuid');
const db = require('../loader');

class ScheduledMessageRepository {
  async findPending(userId) {
    return db.scheduledMsgs.find({ userId, sent: false }).sort({ sendAt: 1 });
  }

  async findById(id, userId) {
    return db.scheduledMsgs.findOne({ _id: id, userId });
  }

  async insert(data) {
    return db.scheduledMsgs.insert({ _id: uuidv4(), createdAt: Date.now(), sent: false, ...data });
  }

  async delete(id) {
    return db.scheduledMsgs.remove({ _id: id });
  }

  async deleteByServer(serverId) {
    return db.scheduledMsgs?.remove({ serverId });
  }

  async markSent(id, sentAt = Date.now()) {
    return db.scheduledMsgs.update({ _id: id }, { $set: { sent: true, sentAt } });
  }

  async findDueBefore(timestamp) {
    return db.scheduledMsgs.find({ sent: false, sendAt: { $lte: timestamp } });
  }
}

module.exports = new ScheduledMessageRepository();
export {};
