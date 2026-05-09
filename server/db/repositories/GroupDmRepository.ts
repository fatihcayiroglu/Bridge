// @ts-nocheck
// server/db/repositories/GroupDmRepository.js
// Grup DM konuşmaları, üyelikleri ve mesajlarını tek noktada toplar.

'use strict';
const { v4: uuidv4 } = require('uuid');
const db = require('../loader');

class GroupDmRepository {
  // ── Conversations ──────────────────────────────────────────

  async findById(id) {
    return db.groupDmConversations.findOne({ _id: id });
  }

  async create(data) {
    return db.groupDmConversations.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async update(id, fields) {
    return db.groupDmConversations.update({ _id: id }, { $set: fields });
  }

  async delete(id) {
    return db.groupDmConversations.remove({ _id: id });
  }

  // ── Members ────────────────────────────────────────────────

  async findMember(groupId, userId) {
    return db.groupDmMembers.findOne({ groupId, userId });
  }

  async findMembers(groupId) {
    return db.groupDmMembers.find({ groupId });
  }

  async findGroupsByUser(userId) {
    return db.groupDmMembers.find({ userId });
  }

  async countMembers(groupId) {
    return db.groupDmMembers.count({ groupId });
  }

  async addMember(groupId, userId) {
    return db.groupDmMembers.insert({ _id: uuidv4(), groupId, userId, joinedAt: Date.now() });
  }

  async removeMember(groupId, userId) {
    return db.groupDmMembers.remove({ groupId, userId });
  }

  async removeAllMembers(groupId) {
    return db.groupDmMembers.remove({ groupId });
  }

  /** Sahipliği ilk kalan üyeye devreder; üye yoksa null döner. */
  async transferOwnership(groupId) {
    const next = await db.groupDmMembers.findOne({ groupId });
    if (next) await this.update(groupId, { ownerId: next.userId });
    return next;
  }

  // ── Messages ───────────────────────────────────────────────

  async findMessages(groupId, { limit = 50, before } = {}) {
    const query = { groupId };
    if (before) query.createdAt = { $lt: before };
    return db.groupDmMessages.find(query).sort({ createdAt: -1 }).limit(Math.min(limit, 100));
  }

  async insertMessage(data) {
    return db.groupDmMessages.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async removeMessages(groupId) {
    return db.groupDmMessages.remove({ groupId });
  }

  /** Grup ve tüm bağlı verisini (üyeler + mesajlar) siler. */
  async deleteGroup(groupId) {
    await this.removeMessages(groupId);
    await this.removeAllMembers(groupId);
    await this.delete(groupId);
  }
}

module.exports = new GroupDmRepository();
export {};
