// server/db/repositories/UserRepository.js

const db = require('../loader');

class UserRepository {
  async findById(id) {
    return db.users.findOne({ _id: id });
  }

  async findByUsername(username) {
    return db.users.findOne({ username: username.toLowerCase() });
  }

  async findByEmail(email) {
    if (!email) return null;
    return db.users.findOne({ email: String(email).toLowerCase() });
  }

  async findByEmailToken(token) {
    return db.users.findOne({ emailToken: token });
  }

  async create(data) {
    return db.users.insert(data);
  }

  async update(id, fields) {
    return db.users.update({ _id: id }, { $set: fields });
  }

  async updateWhere(filter, modifier) {
    return db.users.update(filter, modifier);
  }

  async setStatus(id, status) {
    return db.users.update({ _id: id }, { $set: { status } });
  }

  async incrementTokenVersion(id) {
    return db.users.update({ _id: id }, { $inc: { tokenVersion: 1 } });
  }

  async findByIds(ids) {
    return db.users.find({ _id: { $in: ids } });
  }

  async findByUsernames(usernames) {
    const lower = usernames.map(u => u.toLowerCase());
    return db.users.find({ username: { $in: lower } });
  }

  async count(query = {}) {
    return db.users.count(query);
  }

  async delete(id) {
    return db.users.remove({ _id: id });
  }

  /** Admin listesi vb. için sıralı sayfalı arama. */
  async searchPaginated(query, { skip = 0, limit = 50 } = {}) {
    return db.users.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit);
  }

  async findWhere(query) {
    return db.users.find(query);
  }
}

module.exports = new UserRepository();
export {};
