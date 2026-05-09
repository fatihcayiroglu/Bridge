// server/db/repositories/ChannelRepository.js
// Kanal ve kanal kategorisi sorgularını tek noktada toplar.

'use strict';
const { v4: uuidv4 } = require('uuid');
const db = require('../loader');

class ChannelRepository {
  // ── Channels ────────────────────────────────────────────────

  async findById(id) {
    return db.channels.findOne({ _id: id });
  }

  async findByServer(serverId) {
    return db.channels.find({ serverId }).sort({ order: 1 });
  }

  async findByIdAndServer(id, serverId) {
    return db.channels.findOne({ _id: id, serverId });
  }

  async insert(data) {
    return db.channels.insert(data);
  }

  async update(id, fields) {
    return db.channels.update({ _id: id }, { $set: fields });
  }

  async updateByIdAndServer(id, serverId, fields) {
    return db.channels.update({ _id: id, serverId }, { $set: fields });
  }

  async delete(id) {
    return db.channels.remove({ _id: id });
  }

  async deleteByServer(serverId) {
    return db.channels.remove({ serverId });
  }

  async count(serverId) {
    return db.channels.count({ serverId });
  }

  async findWhere(query) {
    return db.channels.find(query);
  }

  async findOneWhere(query) {
    return db.channels.findOne(query);
  }

  /** Bir sunucuya ait tüm kanal ID'lerini döndürür. */
  async findIdsByServer(serverId) {
    const channels = await db.channels.find({ serverId });
    return channels.map(ch => ch._id);
  }

  // ── Channel Categories ────────────────────────────────────

  async findCategoryById(id) {
    return db.channelCategories.findOne({ _id: id });
  }

  async findCategoriesByServer(serverId) {
    return db.channelCategories.find({ serverId }).sort({ position: 1 });
  }

  async findCategoryByIdAndServer(id, serverId) {
    return db.channelCategories.findOne({ _id: id, serverId });
  }

  async countCategories(serverId) {
    return db.channelCategories.count({ serverId });
  }

  async insertCategory(data) {
    return db.channelCategories.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async updateCategory(id, serverId, fields) {
    return db.channelCategories.update({ _id: id, serverId }, { $set: fields });
  }

  async deleteCategory(id, serverId) {
    return db.channelCategories.remove({ _id: id, serverId });
  }

  /** Bir kategoriye bağlı kanalların categoryId'sini null yapar. */
  async unlinkCategory(catId, serverId) {
    return db.channels.update({ serverId, categoryId: catId }, { $set: { categoryId: null } });
  }

  /** Discord-benzeri kanal izin override'ları (@everyone / rol / kullanıcı). */
  async findOverridesByChannel(channelId) {
    return db.channelOverrides?.find({ channelId }) ?? [];
  }
}

module.exports = new ChannelRepository();
export {};
