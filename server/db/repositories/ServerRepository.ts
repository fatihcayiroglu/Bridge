// server/db/repositories/ServerRepository.ts (loader + $in fix)

import db from '../loader';

class ServerRepository {
  async findById(id: string) {
    return db.servers.findOne({ _id: id });
  }

  async findByOwner(ownerId: string) {
    return db.servers.find({ ownerId });
  }

  async findJoinedByUser(userId: string) {
    const memberships = await db.members.find({ userId });
    if (!memberships.length) return [];
    const serverIds = memberships.map((m) => m.serverId);
    return db.servers.find({ _id: { $in: serverIds } });
  }

  async findByIds(ids: string[]) {
    if (!ids || ids.length === 0) return [];
    return db.servers.find({ _id: { $in: ids } });
  }

  async find(query: Record<string, unknown>) {
    return db.servers.find(query);
  }

  async findOne(query: Record<string, unknown>) {
    return db.servers.findOne(query);
  }

  async create(data: Record<string, unknown>) {
    return db.servers.insert(data);
  }

  async update(id: string, fields: Record<string, unknown>) {
    return db.servers.update({ _id: id }, { $set: fields });
  }

  async delete(id: string) {
    return db.servers.remove({ _id: id });
  }

  async getMember(userId: string, serverId: string) {
    return db.members.findOne({ userId, serverId });
  }

  async addMember(userId: string, serverId: string, roles: string[] = []) {
    return db.members.insert({ userId, serverId, roles: JSON.stringify(roles), joinedAt: Date.now() });
  }

  async removeMember(userId: string, serverId: string) {
    return db.members.remove({ userId, serverId });
  }

  async getMembers(serverId: string) {
    return db.members.find({ serverId });
  }

  async count(query = {}) {
    return db.servers.count(query);
  }

  async findRecentSorted(limit = 100) {
    return db.servers.find({}).sort({ createdAt: -1 }).limit(limit);
  }
}

export default new ServerRepository();
