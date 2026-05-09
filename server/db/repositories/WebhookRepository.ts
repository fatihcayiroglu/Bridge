// Kanal webhook kayıtları (Discord-benzeri; gelen POST bots.js'de)

'use strict';
const db = require('../loader');

class WebhookRepository {
  async findByChannel(channelId) {
    return db.webhooks?.find({ channelId }) ?? [];
  }

  async findOne(query) {
    return db.webhooks?.findOne(query);
  }

  async insert(doc) {
    return db.webhooks?.insert(doc);
  }

  async remove(filter) {
    return db.webhooks?.remove(filter);
  }
}

module.exports = new WebhookRepository();
export {};
