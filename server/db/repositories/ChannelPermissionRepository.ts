// Kanal izin matrisi (rol bazlı channel_permissions)

'use strict';
const { v4: uuidv4 } = require('uuid');
const db = require('../loader');

class ChannelPermissionRepository {
  async findByChannel(channelId) {
    return db.channelPermissions?.find({ channelId }) ?? [];
  }

  async findOne(query) {
    return db.channelPermissions?.findOne(query);
  }

  async find(query) {
    return db.channelPermissions?.find(query) ?? [];
  }

  async remove(query) {
    return db.channelPermissions?.remove(query);
  }

  async removeByChannel(channelId) {
    return db.channelPermissions?.remove({ channelId });
  }

  async insert(doc) {
    if (doc._id) return db.channelPermissions?.insert(doc);
    return db.channelPermissions?.insert({ _id: uuidv4(), ...doc });
  }

  async update(filter, modifier) {
    return db.channelPermissions?.update(filter, modifier);
  }
}

module.exports = new ChannelPermissionRepository();
export {};
