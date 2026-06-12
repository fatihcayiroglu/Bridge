// server/db/repositories/PollRepository.ts
// Anket sorgularını tek noktada toplar.

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';

class PollRepository {
  async findById(id: string) {
    return db.polls?.findOne({ _id: id });
  }

  async findByChannel(channelId: string) {
    return db.polls?.find({ channelId }) ?? [];
  }

  async insert(data: Record<string, unknown>) {
    return db.polls?.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async update(id: string, fields: Record<string, unknown>) {
    return db.polls?.update({ _id: id }, { $set: fields });
  }

  async delete(id: string) {
    return db.polls?.remove({ _id: id });
  }
}

export default new PollRepository();
