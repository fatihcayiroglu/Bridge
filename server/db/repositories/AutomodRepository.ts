// server/db/repositories/AutomodRepository.ts
// Otomatik moderasyon kuralları sorgularını tek noktada toplar.

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';

class AutomodRepository {
  async findById(id: string) {
    return db.automodRules.findOne({ _id: id });
  }

  async findByIdAndServer(id: string, serverId: string) {
    return db.automodRules.findOne({ _id: id, serverId });
  }

  async findByServer(serverId: string) {
    return db.automodRules.find({ serverId });
  }

  async count(serverId: string) {
    return db.automodRules.count({ serverId });
  }

  async insert(data: Record<string, unknown>) {
    return db.automodRules.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async update(id: string, fields: Record<string, unknown>) {
    return db.automodRules.update({ _id: id }, { $set: fields });
  }

  async delete(id: string) {
    return db.automodRules.remove({ _id: id });
  }
}

export default new AutomodRepository();
