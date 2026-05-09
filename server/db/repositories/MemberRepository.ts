// server/db/repositories/MemberRepository.js
// Sunucu üyeliği sorgularını tek noktada toplar.

'use strict';
const db = require('../loader');

class MemberRepository {
  async findOne(userId, serverId) {
    return db.members.findOne({ userId, serverId });
  }

  async findByServer(serverId) {
    return db.members.find({ serverId });
  }

  async findByUser(userId) {
    return db.members.find({ userId });
  }

  async countByServer(serverId) {
    return db.members.count({ serverId });
  }

  async insert(userId, serverId, extra = {}) {
    return db.members.insert({ userId, serverId, joinedAt: Date.now(), ...extra });
  }

  async update(userId, serverId, fields) {
    return db.members.update({ userId, serverId }, { $set: fields });
  }

  async remove(userId, serverId) {
    return db.members.remove({ userId, serverId });
  }

  async removeAllFromServer(serverId) {
    return db.members.remove({ serverId });
  }

  async removeAllForUser(userId) {
    return db.members.remove({ userId });
  }

  async findByServerIds(serverIds, projection) {
    if (!serverIds?.length) return [];
    return db.members.find({ serverId: { $in: serverIds } }, projection);
  }

  async findWhere(query) {
    return db.members.find(query);
  }

  async countWhere(query = {}) {
    return db.members.count(query);
  }

  async isTimedOut(userId, serverId) {
    const m = await this.findOne(userId, serverId);
    return m?.timeoutUntil && m.timeoutUntil > Date.now();
  }

  /** Üye rollerini JSON string olarak günceller. */
  async setRoles(userId, serverId, roles) {
    return this.update(userId, serverId, { roles: JSON.stringify(roles) });
  }
}

module.exports = new MemberRepository();
export {};
