// server/db/repositories/BotRepository.js
// Bot ve sunucu-bot ilişkisi sorgularını tek noktada toplar.

'use strict';
const { v4: uuidv4 } = require('uuid');
const db = require('../loader');

class BotRepository {
  // ── Bots ───────────────────────────────────────────────────

  async findById(id) {
    return db.bots.findOne({ _id: id });
  }

  async findByIdAndServer(id, serverId) {
    return db.bots.findOne({ _id: id, serverId });
  }

  async findByIdAndToken(id, serverId, tokenHash) {
    return db.bots.findOne({ _id: id, serverId, tokenHash });
  }

  async findByServer(serverId) {
    return db.bots.find({ serverId });
  }

  async findPublic(query = {}) {
    return db.bots.find({ ...query, public: true }).catch(() => []);
  }

  async findByIds(ids) {
    return Promise.all(ids.map(id => db.bots.findOne({ _id: id, active: true })));
  }

  async insert(data) {
    return db.bots.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async update(id, fields) {
    return db.bots.update({ _id: id }, { $set: fields });
  }

  async updateByIdAndServer(id, serverId, fields) {
    return db.bots.update({ _id: id, serverId }, { $set: fields });
  }

  async deactivate(id, serverId) {
    return this.updateByIdAndServer(id, serverId, { active: false });
  }

  // ── Server-Bot links ───────────────────────────────────────

  async findServerBot(botId, serverId) {
    return db.serverBots?.findOne({ botId, serverId });
  }

  async findServerBots(serverId) {
    return db.serverBots?.find({ serverId }) ?? [];
  }

  async countServerInstalls(botId) {
    return db.serverBots?.count({ botId }).catch(() => 0) ?? 0;
  }

  async addToServer(botId, serverId, addedBy) {
    return db.serverBots?.insert({ _id: uuidv4(), botId, serverId, addedBy, addedAt: Date.now() });
  }

  // ── Ratings ────────────────────────────────────────────────

  async findRating(botId, userId) {
    return db.botRatings?.findOne({ botId, userId });
  }

  async findAllRatings(botId) {
    return db.botRatings?.find({ botId }) ?? [];
  }

  async insertRating(botId, userId, rating) {
    return db.botRatings?.insert({ _id: uuidv4(), botId, userId, rating, createdAt: Date.now() });
  }

  async updateRating(id, rating) {
    return db.botRatings?.update({ _id: id }, { $set: { rating, updatedAt: Date.now() } });
  }

  /** Gelen Discord-benzeri webhook kaydı (bots.js POST /webhooks/:id). */
  async findIncomingWebhook(id) {
    return db.webhooks?.findOne({ _id: id });
  }

  async findWhere(query) {
    return db.bots.find(query);
  }
}

module.exports = new BotRepository();
export {};
