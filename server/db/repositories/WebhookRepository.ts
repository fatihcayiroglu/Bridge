// Kanal webhook kayıtları (Discord-benzeri; gelen POST bots.js'de)

import db from '../loader';

class WebhookRepository {
  async findByChannel(channelId: string) {
    return db.webhooks?.find({ channelId }) ?? [];
  }

  async findOne(query: Record<string, unknown>) {
    return db.webhooks?.findOne(query);
  }

  async insert(doc: Record<string, unknown>) {
    return db.webhooks?.insert(doc);
  }

  async create(doc: Record<string, unknown>) {
    return this.insert(doc);
  }

  async findById(id: string) {
    return db.webhooks?.findOne({ _id: id });
  }

  async remove(filter: Record<string, unknown>) {
    return db.webhooks?.remove(filter);
  }

  async delete(id: string, channelId?: string) {
    return db.webhooks?.remove(channelId ? { _id: id, channelId } : { _id: id });
  }
}

export default new WebhookRepository();
