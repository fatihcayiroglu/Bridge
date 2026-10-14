// server/db/repositories/RoleRepository.ts
// Rol sorgularını tek noktada toplar.

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';
import { parsePermissionMask } from '../../lib/permissionMaskInvariant';
import { postgresPoolOrTestFallback } from './postgresInvariant';

class RoleRepository {
  async findById(id: string) {
    return db.roles.findOne({ _id: id });
  }

  async findByIdAndServer(id: string, serverId: string) {
    return db.roles.findOne({ _id: id, serverId });
  }

  async findByServer(serverId: string) {
    return db.roles.find({ serverId }).sort({ position: 1 });
  }

  async insert(data: Record<string, unknown>) {
    const normalized = { ...data };
    if (normalized.permissions !== undefined) {
      normalized.permissions = parsePermissionMask(normalized.permissions, 'role permissions');
    }
    return db.roles.insert({ _id: uuidv4(), createdAt: Date.now(), ...normalized });
  }

  async update(id: string, serverId: string, fields: Record<string, unknown>) {
    const normalized = { ...fields };
    if (normalized.permissions !== undefined) {
      normalized.permissions = parsePermissionMask(normalized.permissions, 'role permissions');
    }
    return db.roles.update({ _id: id, serverId }, { $set: normalized });
  }

  /**
   * Deletes a role AND everything it granted, in one transaction: its channel
   * permission rows and its id in every member's role list. Removing only the
   * role row left both behind, so the role's channel ALLOW kept applying to
   * its former members, and the stale rows made the community's portable
   * permission export fail ("Permission references foreign role").
   * Returns false when the role does not exist in this server.
   */
  async delete(id: string, serverId: string): Promise<boolean> {
    const pool = postgresPoolOrTestFallback(
      (db as unknown as { _pool?: import('pg').Pool })._pool,
      'role deletion',
    );
    if (!pool?.connect) {
      const removed = await db.roles.remove({ _id: id, serverId });
      if (!removed?.deleted) return false;
      await db.channelPermissions.remove({ roleId: id });
      const members = await db.members.find({ serverId }) as Array<{ userId: string; roles?: unknown }>;
      for (const member of members) {
        if (Array.isArray(member.roles) && member.roles.includes(id)) {
          await db.members.update({ userId: member.userId, serverId },
            { $set: { roles: member.roles.filter((roleId) => roleId !== id) } });
        }
      }
      return true;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const removed = await client.query('DELETE FROM roles WHERE _id=$1 AND "serverId"=$2', [id, serverId]);
      if (!removed.rowCount) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query('DELETE FROM channel_permissions WHERE "roleId"=$1', [id]);
      await client.query(
        `UPDATE members SET roles = roles - $1::text WHERE "serverId"=$2 AND roles ? $1::text`, [id, serverId]);
      await client.query('COMMIT');
      return true;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
      throw err;
    } finally { client.release(); }
  }

  async deleteByServer(serverId: string) {
    return db.roles.remove({ serverId });
  }

  async findWhere(query: Record<string, unknown>) {
    return db.roles.find(query);
  }

  /** Üye rolleri için sunucu içi sıralı liste (yüksek position önce). */
  findByIdsInServer(roleIds: string[], serverId: string) {
    if (!roleIds?.length) return Promise.resolve([]);
    return db.roles.find({ _id: { $in: roleIds }, serverId }).sort({ position: -1 });
  }
}

export default new RoleRepository();
