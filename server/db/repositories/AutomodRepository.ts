// server/db/repositories/AutomodRepository.js
// Otomatik moderasyon kuralları sorgularını tek noktada toplar.

'use strict';
const { v4: uuidv4 } = require('uuid');
const db = require('../loader');

class AutomodRepository {
  async findById(id) {
    return db.automodRules.findOne({ _id: id });
  }

  async findByIdAndServer(id, serverId) {
    return db.automodRules.findOne({ _id: id, serverId });
  }

  async findByServer(serverId) {
    return db.automodRules.find({ serverId });
  }

  async count(serverId) {
    return db.automodRules.count({ serverId });
  }

  async insert(data) {
    return db.automodRules.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async update(id, fields) {
    return db.automodRules.update({ _id: id }, { $set: fields });
  }

  async delete(id) {
    return db.automodRules.remove({ _id: id });
  }
}

module.exports = new AutomodRepository();
export {};
