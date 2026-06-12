// server/db/repositories/InviteRepository.ts
// Davet kodu sorgularını tek noktada toplar.

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';

class InviteRepository {
  async findByCode(code: string) {
    return db.invites.findOne({ code });
  }

  async findByServer(serverId: string) {
    return db.invites.find({ serverId });
  }

  async create({ serverId, createdBy, maxUses = 0, ttlMs = 7 * 24 * 60 * 60 * 1000 }: { serverId: string; createdBy: string; maxUses?: number; ttlMs?: number }) {
    const code      = uuidv4().split('-')[0];
    const expiresAt = Date.now() + ttlMs;
    await db.invites.insert({ _id: uuidv4(), code, serverId, createdBy, expiresAt, maxUses, uses: 0 });
    return { code, expiresAt, maxUses };
  }

  async incrementUses(id: string) {
    return db.invites.update({ _id: id }, { $inc: { uses: 1 } });
  }

  async removeByServer(serverId: string) {
    return db.invites.remove({ serverId });
  }

  /** Daveti doğrular ve kullanılamaz ise hata mesajı döndürür. */
  isValid(invite: { expiresAt: number; maxUses: number; uses: number } | null | undefined) {
    if (!invite)                                         return 'Invalid invite code';
    if (invite.expiresAt < Date.now())                   return 'Invite has expired';
    if (invite.maxUses > 0 && invite.uses >= invite.maxUses) return 'Invite has reached its maximum uses';
    return null; // geçerli
  }
}

export default new InviteRepository();
