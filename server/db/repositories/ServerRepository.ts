// server/db/repositories/ServerRepository.js (loader + $in fix)

const db = require('../loader');

class ServerRepository {
  async findById(id) {
    return db.servers.findOne({ _id: id });
  }

  async findByOwner(ownerId) {
    return db.servers.find({ ownerId });
  }

  async findJoinedByUser(userId) {
    const memberships = await db.members.find({ userId });
    if (!memberships.length) return [];
    const serverIds = memberships.map(m => m.serverId);
    return db.servers.find({ _id: { $in: serverIds } });
  }

  async find(query) {
    return db.servers.find(query);
  }

  async findOne(query) {
    return db.servers.findOne(query);
  }

  async create(data) {
    return db.servers.insert(data);
  }

  async update(id, fields) {
    return db.servers.update({ _id: id }, { $set: fields });
  }

  async delete(id) {
    return db.servers.remove({ _id: id });
  }

  async getMember(userId, serverId) {
    return db.members.findOne({ userId, serverId });
  }

  async addMember(userId, serverId, roles = []) {
    return db.members.insert({ userId, serverId, roles: JSON.stringify(roles), joinedAt: Date.now() });
  }

  async removeMember(userId, serverId) {
    return db.members.remove({ userId, serverId });
  }

  async getMembers(serverId) {
    return db.members.find({ serverId });
  }

  async count(query = {}) {
    return db.servers.count(query);
  }

  async findRecentSorted(limit = 100) {
    return db.servers.find({}).sort({ createdAt: -1 }).limit(limit);
  }
}

module.exports = new ServerRepository();
export {};
