// server/db/repositories/MemberRepository.ts
// Sunucu üyeliği sorgularını tek noktada toplar.

import db from '../loader';

class MemberRepository {
  async findOne(userIdOrQuery: string | Record<string, unknown>, serverId?: string) {
    const query = typeof userIdOrQuery === 'string' ? { userId: userIdOrQuery, serverId } : userIdOrQuery;
    return db.members.findOne(query);
  }

  async findByServer(serverId: string) {
    return db.members.find({ serverId });
  }

  async findByUser(userId: string) {
    return db.members.find({ userId });
  }

  async countByServer(serverId: string) {
    return db.members.count({ serverId });
  }

  async insert(userId: string, serverId: string, extra: Record<string, unknown> = {}) {
    return db.members.insert({ userId, serverId, joinedAt: Date.now(), ...extra });
  }

  async update(userId: string, serverId: string, fields: Record<string, unknown>) {
    return db.members.update({ userId, serverId }, { $set: fields });
  }

  async remove(userId: string, serverId: string) {
    return db.members.remove({ userId, serverId });
  }

  async removeMember(userId: string, serverId: string) {
    return this.remove(userId, serverId);
  }

  async getBans(serverId: string) {
    return db.members.find({ serverId, banned: true });
  }

  async banMember(serverId: string, userId: string, reasonOrFields: string | Record<string, unknown> = {}) {
    const fields = typeof reasonOrFields === 'string' ? { banReason: reasonOrFields } : reasonOrFields;
    return db.members.insert({ userId, serverId, banned: true, joinedAt: Date.now(), ...fields });
  }

  async unbanMember(serverId: string, userId: string) {
    return db.members.remove({ userId, serverId, banned: true });
  }

  async removeAllFromServer(serverId: string) {
    return db.members.remove({ serverId });
  }

  async removeAllForUser(userId: string) {
    return db.members.remove({ userId });
  }

  async findByServerIds(serverIds: string[], projection?: object) {
    if (!serverIds?.length) return [];
    return db.members.find({ serverId: { $in: serverIds } }, projection);
  }

  async findWhere(query: Record<string, unknown>) {
    return db.members.find(query);
  }

  async countWhere(query: Record<string, unknown> = {}) {
    return db.members.count(query);
  }

  async setTimeout(serverId: string, userId: string, until: Date | number | null) {
    const timeoutUntil = until instanceof Date ? until.getTime() : until;
    return this.update(userId, serverId, { timeoutUntil });
  }

  async isTimedOut(userId: string, serverId: string) {
    const m = await this.findOne(userId, serverId);
    return m?.timeoutUntil && m.timeoutUntil > Date.now();
  }

  /** Üye rollerini JSON string olarak günceller. */
  async setRoles(userId: string, serverId: string, roles: string[]) {
    return this.update(userId, serverId, { roles: JSON.stringify(roles) });
  }
}

export default new MemberRepository();
