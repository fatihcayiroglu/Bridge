// server/db/repositories/BotRepository.ts
// Bot ve sunucu-bot ilişkisi sorgularını tek noktada toplar.

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';

class BotRepository {
  // ── Bots ───────────────────────────────────────────────────

  async findById(id: string) {
    return db.bots.findOne({ _id: id });
  }

  async findByIdAndServer(id: string, serverId: string) {
    return db.bots.findOne({ _id: id, serverId });
  }

  async findByIdAndToken(id: string, serverId: string, tokenHash: string) {
    return db.bots.findOne({ _id: id, serverId, tokenHash });
  }

  async findByServer(serverId: string) {
    return db.bots.find({ serverId });
  }

  async findPublic(query = {}) {
    return db.bots.find({ ...query, public: true }).catch(() => []);
  }

  async findByIds(ids: string[]) {
    return Promise.all(ids.map((id: string) => db.bots.findOne({ _id: id, active: true })));
  }

  async insert(data: Record<string, unknown>) {
    return db.bots.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async create(data: Record<string, unknown>) {
    return this.insert(data);
  }

  async update(id: string, fields: Record<string, unknown>) {
    return db.bots.update({ _id: id }, { $set: fields });
  }

  async updateByIdAndServer(id: string, serverId: string, fields: Record<string, unknown>) {
    return db.bots.update({ _id: id, serverId }, { $set: fields });
  }

  async deactivate(id: string, serverId: string) {
    return this.updateByIdAndServer(id, serverId, { active: false });
  }

  async delete(id: string, serverId?: string) {
    return db.bots.remove(serverId ? { _id: id, serverId } : { _id: id });
  }

  async updateToken(id: string, serverIdOrTokenHash: string, maybeTokenHash?: string) {
    const fields = maybeTokenHash ? { tokenHash: maybeTokenHash } : { tokenHash: serverIdOrTokenHash };
    return maybeTokenHash ? this.updateByIdAndServer(id, serverIdOrTokenHash, fields) : this.update(id, fields);
  }

  async findByWebhookId(webhookId: string) {
    return db.bots.findOne({ webhookId });
  }

  // ── Server-Bot links ───────────────────────────────────────

  async findServerBot(botId: string, serverId: string) {
    return db.serverBots?.findOne({ botId, serverId });
  }

  async findServerBots(serverId: string) {
    return db.serverBots?.find({ serverId }) ?? [];
  }

  async countServerInstalls(botId: string) {
    return db.serverBots?.count({ botId }).catch(() => 0) ?? 0;
  }

  async addToServer(botId: string, serverId: string, addedBy: string) {
    return db.serverBots?.insert({ _id: uuidv4(), botId, serverId, addedBy, addedAt: Date.now() });
  }

  // ── Ratings ────────────────────────────────────────────────

  async findRating(botId: string, userId: string) {
    return db.botRatings?.findOne({ botId, userId });
  }

  async findAllRatings(botId: string) {
    return db.botRatings?.find({ botId }) ?? [];
  }

  async insertRating(botId: string, userId: string, rating: number) {
    return db.botRatings?.insert({ _id: uuidv4(), botId, userId, rating, createdAt: Date.now() });
  }

  async updateRating(id: string, rating: number) {
    return db.botRatings?.update({ _id: id }, { $set: { rating, updatedAt: Date.now() } });
  }

  /** Gelen Discord-benzeri webhook kaydı (bots.js POST /webhooks/:id). */
  async findIncomingWebhook(id: string) {
    return db.webhooks?.findOne({ _id: id });
  }

  async findWhere(query: Record<string, unknown>) {
    return db.bots.find(query);
  }
}

export default new BotRepository();
