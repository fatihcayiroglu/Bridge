// server/db/repositories/RoleRepository.ts
// Rol sorgularını tek noktada toplar.

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';

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
    return db.roles.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async update(id: string, serverId: string, fields: Record<string, unknown>) {
    return db.roles.update({ _id: id, serverId }, { $set: fields });
  }

  async delete(id: string, serverId: string) {
    return db.roles.remove({ _id: id, serverId });
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
