// server/db/repositories/ChannelRepository.ts
// Kanal ve kanal kategorisi sorgularını tek noktada toplar.

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';

class ChannelRepository {
  // ── Channels ────────────────────────────────────────────────

  async findById(id: string) {
    return db.channels.findOne({ _id: id });
  }

  async findByServer(serverId: string) {
    return db.channels.find({ serverId }).sort({ order: 1 });
  }

  async findByIdAndServer(id: string, serverId: string) {
    return db.channels.findOne({ _id: id, serverId });
  }

  async insert(data: Record<string, unknown>) {
    return db.channels.insert(data);
  }

  async update(id: string, fields: Record<string, unknown>) {
    return db.channels.update({ _id: id }, { $set: fields });
  }

  async updateByIdAndServer(id: string, serverId: string, fields: Record<string, unknown>) {
    return db.channels.update({ _id: id, serverId }, { $set: fields });
  }

  async delete(id: string) {
    return db.channels.remove({ _id: id });
  }

  async deleteByServer(serverId: string) {
    return db.channels.remove({ serverId });
  }

  async count(serverId: string) {
    return db.channels.count({ serverId });
  }

  async findWhere(query: Record<string, unknown>) {
    return db.channels.find(query);
  }

  async findOneWhere(query: Record<string, unknown>) {
    return db.channels.findOne(query);
  }

  /** Bir sunucuya ait tüm kanal ID'lerini döndürür. */
  async findIdsByServer(serverId: string) {
    const channels = await db.channels.find({ serverId });
    return channels.map((ch) => ch._id);
  }

  // ── Channel Categories ────────────────────────────────────

  async findCategoryById(id: string) {
    return db.channelCategories.findOne({ _id: id });
  }

  async findCategoriesByServer(serverId: string) {
    return db.channelCategories.find({ serverId }).sort({ position: 1 });
  }

  async findCategoryByIdAndServer(id: string, serverId: string) {
    return db.channelCategories.findOne({ _id: id, serverId });
  }

  async countCategories(serverId: string) {
    return db.channelCategories.count({ serverId });
  }

  async insertCategory(data: Record<string, unknown>) {
    return db.channelCategories.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async updateCategory(id: string, serverId: string, fields: Record<string, unknown>) {
    return db.channelCategories.update({ _id: id, serverId }, { $set: fields });
  }

  async deleteCategory(id: string, serverId: string) {
    return db.channelCategories.remove({ _id: id, serverId });
  }

  /** Bir kategoriye bağlı kanalların categoryId'sini null yapar. */
  async unlinkCategory(catId: string, serverId: string) {
    return db.channels.update({ serverId, categoryId: catId }, { $set: { categoryId: null } });
  }

  /** Discord-benzeri kanal izin override'ları (@everyone / rol / kullanıcı). */
  async findOverridesByChannel(channelId: string) {
    return db.channelOverrides?.find({ channelId }) ?? [];
  }
}

export default new ChannelRepository();
