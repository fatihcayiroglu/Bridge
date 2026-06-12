import { v4 as uuidv4 } from 'uuid';
import db from '../loader';

class VoiceRepository {
  async insert(doc: Record<string, unknown>) {
    if (doc._id) return db.voiceMessages?.insert(doc);
    return db.voiceMessages?.insert({ _id: uuidv4(), createdAt: Date.now(), ...doc });
  }

  async findOne(query: Record<string, unknown>) {
    return db.voiceMessages?.findOne(query);
  }

  async update(filter: Record<string, unknown>, modifier: Record<string, unknown>) {
    return db.voiceMessages?.update(filter, modifier);
  }
}

export default new VoiceRepository();
