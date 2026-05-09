// server/db/repositories/PollRepository.js
// Anket sorgularını tek noktada toplar.

'use strict';
const { v4: uuidv4 } = require('uuid');
const db = require('../loader');

class PollRepository {
  async findById(id) {
    return db.polls?.findOne({ _id: id });
  }

  async findByChannel(channelId) {
    return db.polls?.find({ channelId }) ?? [];
  }

  async insert(data) {
    return db.polls?.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async update(id, fields) {
    return db.polls?.update({ _id: id }, { $set: fields });
  }

  async delete(id) {
    return db.polls?.remove({ _id: id });
  }
}

module.exports = new PollRepository();
export {};
