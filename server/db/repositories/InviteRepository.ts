// server/db/repositories/InviteRepository.js
// Davet kodu sorgularını tek noktada toplar.

'use strict';
const { v4: uuidv4 } = require('uuid');
const db = require('../loader');

class InviteRepository {
  async findByCode(code) {
    return db.invites.findOne({ code });
  }

  async findByServer(serverId) {
    return db.invites.find({ serverId });
  }

  async create({ serverId, createdBy, maxUses = 0, ttlMs = 7 * 24 * 60 * 60 * 1000 }) {
    const code      = uuidv4().split('-')[0];
    const expiresAt = Date.now() + ttlMs;
    await db.invites.insert({ _id: uuidv4(), code, serverId, createdBy, expiresAt, maxUses, uses: 0 });
    return { code, expiresAt, maxUses };
  }

  async incrementUses(id) {
    return db.invites.update({ _id: id }, { $inc: { uses: 1 } });
  }

  async removeByServer(serverId) {
    return db.invites.remove({ serverId });
  }

  /** Daveti doğrular ve kullanılamaz ise hata mesajı döndürür. */
  isValid(invite) {
    if (!invite)                                         return 'Invalid invite code';
    if (invite.expiresAt < Date.now())                   return 'Invite has expired';
    if (invite.maxUses > 0 && invite.uses >= invite.maxUses) return 'Invite has reached its maximum uses';
    return null; // geçerli
  }
}

module.exports = new InviteRepository();
export {};
