// server/db/repositories/OutgoingWebhookRepository.ts
// Giden webhook sorgularını tek noktada toplar.

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';

class OutgoingWebhookRepository {
  hasCollection() {
    return !!db.outgoingWebhooks;
  }

  async findById(id: string) {
    return db.outgoingWebhooks?.findOne({ _id: id });
  }

  async findByIdAndServer(id: string, serverId: string) {
    return db.outgoingWebhooks?.findOne({ _id: id, serverId });
  }

  async findByServer(serverId: string) {
    return db.outgoingWebhooks?.find({ serverId }) ?? [];
  }

  async findActive(serverId: string) {
    return db.outgoingWebhooks?.find({ serverId, active: true }) ?? [];
  }

  async findEnabledByServer(serverId: string) {
    return db.outgoingWebhooks?.find({ serverId, enabled: 1 }) ?? [];
  }

  async insert(data: Record<string, unknown>) {
    return db.outgoingWebhooks?.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async update(id: string, fields: Record<string, unknown>) {
    return db.outgoingWebhooks?.update({ _id: id }, { $set: fields });
  }

  async updateByIdRaw(id: string, modifier: Record<string, unknown>) {
    return db.outgoingWebhooks?.update({ _id: id }, modifier);
  }

  async delete(id: string) {
    return db.outgoingWebhooks?.remove({ _id: id });
  }
}

export default new OutgoingWebhookRepository();
