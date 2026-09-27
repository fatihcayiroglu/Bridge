// server/db/repositories/ReactionRoleRepository.ts
// Reaksiyon-rol eşleşmesi sorgularını tek noktada toplar.

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';
import { postgresPoolOrTestFallback } from './postgresInvariant';

class ReactionRoleRepository {
  private createIfAbsentTail: Promise<void> = Promise.resolve();
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

  async createIfAbsent(data: {
    serverId: string;
    channelId: string;
    messageId: string;
    emoji: string;
    roleId: string;
    createdBy: string;
  }): Promise<{ created: boolean; rule: Record<string, unknown> }> {
    for (const [field, value] of Object.entries(data)) {
      if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`);
    }
    const id = uuidv4();
    const createdAt = Date.now();
    const rawPool = (db as unknown as { _pool?: import('pg').Pool })._pool;
    const pool = postgresPoolOrTestFallback(rawPool?.query ? rawPool : null, 'ReactionRoleRepository createIfAbsent');
    if (pool) {
      const inserted = await pool.query<Record<string, unknown>>(
        `INSERT INTO reaction_roles
           (_id, "serverId", "channelId", "messageId", emoji, "roleId", "createdBy", "createdAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT ("messageId", emoji, "roleId") DO NOTHING
         RETURNING *`,
        [id, data.serverId, data.channelId, data.messageId, data.emoji, data.roleId, data.createdBy, createdAt],
      );
      if (inserted.rows[0]) return { created: true, rule: inserted.rows[0] };
      const existing = await pool.query<Record<string, unknown>>(
        `SELECT * FROM reaction_roles
          WHERE "messageId"=$1 AND emoji=$2 AND "roleId"=$3
          LIMIT 1`,
        [data.messageId, data.emoji, data.roleId],
      );
      const rule = existing.rows[0];
      if (!rule) throw new Error('Reaction-role conflict winner could not be loaded');
      return { created: false, rule };
    }

    const previous = this.createIfAbsentTail;
    let release!: () => void;
    this.createIfAbsentTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const existing = await db.reactionRoles.findOne({
        messageId: data.messageId,
        emoji: data.emoji,
        roleId: data.roleId,
      });
      if (existing) return { created: false, rule: existing as unknown as Record<string, unknown> };
      const rule = await db.reactionRoles.insert({ _id: id, createdAt, ...data });
      return { created: true, rule: rule as unknown as Record<string, unknown> };
    } finally {
      release();
    }
  }

  async delete(id: string) {
    return db.reactionRoles.remove({ _id: id });
  }
}

export default new ReactionRoleRepository();
