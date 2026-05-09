'use strict';
const { v4: uuidv4 } = require('uuid');
const db = require('../loader');

class VoiceRepository {
  async insert(doc) {
    if (doc._id) return db.voiceMessages?.insert(doc);
    return db.voiceMessages?.insert({ _id: uuidv4(), createdAt: Date.now(), ...doc });
  }

  async findOne(query) {
    return db.voiceMessages?.findOne(query);
  }

  async update(filter, modifier) {
    return db.voiceMessages?.update(filter, modifier);
  }
}

module.exports = new VoiceRepository();
export {};
