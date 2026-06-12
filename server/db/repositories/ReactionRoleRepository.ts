// server/db/repositories/ReactionRoleRepository.ts
// Reaksiyon-rol eşleşmesi sorgularını tek noktada toplar.

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';

class ReactionRoleRepository {
  async findOne(query: Record<string, unknown>) { return db.reactionRoles.findOne(query); }
  async create(data: Record<string, unknown>) { return db.reactionRoles.insert(data); }
  async update(query: Record<string, unknown>, modifier: Record<string, unknown>) { return db.reactionRoles.update(query, modifier); }
  async findByServer(serverId: string) {
    return db.reactionRoles.find({ serverId });
  }

  async findByIdAndServer(id: string, serverId: string) {
    return db.reactionRoles.findOne({ _id: id, serverId });
  }

  async findByMessageAndEmoji(messageId: string, emoji: string) {
    return db.reactionRoles.find({ messageId, emoji });
  }

  async findDuplicate(messageId: string, emoji: string, roleId: string) {
    return db.reactionRoles.findOne({ messageId, emoji, roleId });
  }

  async insert(data: Record<string, unknown>) {
    return db.reactionRoles.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async delete(id: string) {
    return db.reactionRoles.remove({ _id: id });
  }
}

export default new ReactionRoleRepository();
