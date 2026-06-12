// server/db/repositories/SocialRepository.ts
// Arkadaşlık, blok ve kullanıcı bağlantısı sorgularını tek noktada toplar.

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';
import type { FriendshipStatus } from './types/entities';

class SocialRepository {
  // ── Friendships ────────────────────────────────────────────

  async findFriendship(userId: string, otherId: string) {
    return db.friendships.findOne({ $or: [
      { userId, friendId: otherId },
      { userId: otherId, friendId: userId },
    ]});
  }

  async findFriendships(userId: string) {
    return db.friendships.find({ $or: [{ userId }, { friendId: userId }] });
  }

  async insertFriendship(userId: string, friendId: string, status: FriendshipStatus = 'pending') {
    return db.friendships.insert({ _id: uuidv4(), userId, friendId, status, createdAt: Date.now() });
  }

  async createFriendship(userId: string, friendId: string) {
    return this.insertFriendship(userId, friendId, 'pending');
  }

  async acceptFriendship(id: string) {
    return this.updateFriendship(id, { status: 'accepted', acceptedAt: Date.now() });
  }

  async declineFriendship(id: string) {
    return this.updateFriendship(id, { status: 'declined', declinedAt: Date.now() });
  }

  async updateFriendship(id: string, fields: Record<string, unknown>) {
    return db.friendships.update({ _id: id }, { $set: fields });
  }

  async removeFriendship(id: string) {
    return db.friendships.remove({ _id: id });
  }

  // ── Blocks ─────────────────────────────────────────────────

  async findBlock(blockerId: string, blockedId: string) {
    return db.blocks?.findOne({ blockerId, blockedId });
  }

  async findBlocksByUser(blockerId: string) {
    return db.blocks?.find({ blockerId }) ?? [];
  }

  async insertBlock(blockerId: string, blockedId: string) {
    return db.blocks?.insert({ _id: uuidv4(), blockerId, blockedId, createdAt: Date.now() });
  }

  async removeBlock(blockerId: string, blockedId: string) {
    return db.blocks?.remove({ blockerId, blockedId });
  }

  // ── User Connections ───────────────────────────────────────

  async findConnection(userId: string, platform: string) {
    return db.userConnections?.findOne({ userId, platform });
  }

  async findConnectionsByUser(userId: string) {
    return db.userConnections?.find({ userId }) ?? [];
  }

  async insertConnection(data: Record<string, unknown>) {
    return db.userConnections?.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async removeConnection(userId: string, platform: string) {
    return db.userConnections?.remove({ userId, platform });
  }

  async updateConnection(filter: Record<string, unknown>, modifier: Record<string, unknown>) {
    return db.userConnections?.update(filter, modifier);
  }

  async countConnections(query: Record<string, unknown>) {
    return db.userConnections?.count(query).catch(() => 0) ?? 0;
  }
}

export default new SocialRepository();
