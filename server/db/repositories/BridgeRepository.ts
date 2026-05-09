// Channel bridges (cross-server forwarding)

'use strict';
const db = require('../loader');

class BridgeRepository {
  async findOne(query) {
    return db.channelBridges?.findOne(query);
  }

  async find(query) {
    return db.channelBridges?.find(query) ?? [];
  }

  async insert(doc) {
    return db.channelBridges?.insert(doc);
  }

  async update(filter, modifier) {
    return db.channelBridges?.update(filter, modifier);
  }

  async findActiveFromSourceChannel(channelId) {
    return db.channelBridges?.find({ sourceChannelId: channelId, active: true }) ?? [];
  }
}

module.exports = new BridgeRepository();
export {};
