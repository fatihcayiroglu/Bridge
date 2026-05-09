// server/db/repositories/OutgoingWebhookRepository.js
// Giden webhook sorgularını tek noktada toplar.

'use strict';
const { v4: uuidv4 } = require('uuid');
const db = require('../loader');

class OutgoingWebhookRepository {
  hasCollection() {
    return !!db.outgoingWebhooks;
  }

  async findById(id) {
    return db.outgoingWebhooks?.findOne({ _id: id });
  }

  async findByIdAndServer(id, serverId) {
    return db.outgoingWebhooks?.findOne({ _id: id, serverId });
  }

  async findByServer(serverId) {
    return db.outgoingWebhooks?.find({ serverId }) ?? [];
  }

  async findActive(serverId) {
    return db.outgoingWebhooks?.find({ serverId, active: true }) ?? [];
  }

  async findEnabledByServer(serverId) {
    return db.outgoingWebhooks?.find({ serverId, enabled: 1 }) ?? [];
  }

  async insert(data) {
    return db.outgoingWebhooks?.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async update(id, fields) {
    return db.outgoingWebhooks?.update({ _id: id }, { $set: fields });
  }

  async updateByIdRaw(id, modifier) {
    return db.outgoingWebhooks?.update({ _id: id }, modifier);
  }

  async delete(id) {
    return db.outgoingWebhooks?.remove({ _id: id });
  }
}

module.exports = new OutgoingWebhookRepository();
export {};
