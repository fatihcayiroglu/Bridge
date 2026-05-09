// server/db/repositories/SocialRepository.js
// Arkadaşlık, blok ve kullanıcı bağlantısı sorgularını tek noktada toplar.

'use strict';
const { v4: uuidv4 } = require('uuid');
const db = require('../loader');

class SocialRepository {
  // ── Friendships ────────────────────────────────────────────

  async findFriendship(userId, otherId) {
    return db.friendships.findOne({ $or: [
      { userId, friendId: otherId },
      { userId: otherId, friendId: userId },
    ]});
  }

  async findFriendships(userId) {
    return db.friendships.find({ $or: [{ userId }, { friendId: userId }] });
  }

  async insertFriendship(userId, friendId, status = 'pending') {
    return db.friendships.insert({ _id: uuidv4(), userId, friendId, status, createdAt: Date.now() });
  }

  async updateFriendship(id, fields) {
    return db.friendships.update({ _id: id }, { $set: fields });
  }

  async removeFriendship(id) {
    return db.friendships.remove({ _id: id });
  }

  // ── Blocks ─────────────────────────────────────────────────

  async findBlock(blockerId, blockedId) {
    return db.blocks?.findOne({ blockerId, blockedId });
  }

  async findBlocksByUser(blockerId) {
    return db.blocks?.find({ blockerId }) ?? [];
  }

  async insertBlock(blockerId, blockedId) {
    return db.blocks?.insert({ _id: uuidv4(), blockerId, blockedId, createdAt: Date.now() });
  }

  async removeBlock(blockerId, blockedId) {
    return db.blocks?.remove({ blockerId, blockedId });
  }

  // ── User Connections ───────────────────────────────────────

  async findConnection(userId, platform) {
    return db.userConnections?.findOne({ userId, platform });
  }

  async findConnectionsByUser(userId) {
    return db.userConnections?.find({ userId }) ?? [];
  }

  async insertConnection(data) {
    return db.userConnections?.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async removeConnection(userId, platform) {
    return db.userConnections?.remove({ userId, platform });
  }

  async updateConnection(filter, modifier) {
    return db.userConnections?.update(filter, modifier);
  }

  async countConnections(query) {
    return db.userConnections?.count(query).catch(() => 0) ?? 0;
  }
}

module.exports = new SocialRepository();
export {};
