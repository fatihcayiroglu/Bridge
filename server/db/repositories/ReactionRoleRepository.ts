// server/db/repositories/ReactionRoleRepository.js
// Reaksiyon-rol eşleşmesi sorgularını tek noktada toplar.

'use strict';
const { v4: uuidv4 } = require('uuid');
const db = require('../loader');

class ReactionRoleRepository {
  async findByServer(serverId) {
    return db.reactionRoles.find({ serverId });
  }

  async findByIdAndServer(id, serverId) {
    return db.reactionRoles.findOne({ _id: id, serverId });
  }

  async findByMessageAndEmoji(messageId, emoji) {
    return db.reactionRoles.find({ messageId, emoji });
  }

  async findDuplicate(messageId, emoji, roleId) {
    return db.reactionRoles.findOne({ messageId, emoji, roleId });
  }

  async insert(data) {
    return db.reactionRoles.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async delete(id) {
    return db.reactionRoles.remove({ _id: id });
  }
}

module.exports = new ReactionRoleRepository();
export {};
