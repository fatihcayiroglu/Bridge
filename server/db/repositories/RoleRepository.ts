// server/db/repositories/RoleRepository.js
// Rol sorgularını tek noktada toplar.

'use strict';
const { v4: uuidv4 } = require('uuid');
const db = require('../loader');

class RoleRepository {
  async findById(id) {
    return db.roles.findOne({ _id: id });
  }

  async findByIdAndServer(id, serverId) {
    return db.roles.findOne({ _id: id, serverId });
  }

  async findByServer(serverId) {
    return db.roles.find({ serverId }).sort({ position: 1 });
  }

  async insert(data) {
    return db.roles.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async update(id, serverId, fields) {
    return db.roles.update({ _id: id, serverId }, { $set: fields });
  }

  async delete(id, serverId) {
    return db.roles.remove({ _id: id, serverId });
  }

  async deleteByServer(serverId) {
    return db.roles.remove({ serverId });
  }

  async findWhere(query) {
    return db.roles.find(query);
  }

  /** Üye rolleri için sunucu içi sıralı liste (yüksek position önce). */
  findByIdsInServer(roleIds, serverId) {
    if (!roleIds?.length) return Promise.resolve([]);
    return db.roles.find({ _id: { $in: roleIds }, serverId }).sort({ position: -1 });
  }
}

module.exports = new RoleRepository();
export {};
