// server/db/repositories/BotRepository.ts
// Bot ve sunucu-bot ilişkisi sorgularını tek noktada toplar.

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';
import type { Bot } from './types/entities';

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

  async findByTokenHash(tokenHash: string) {
    return db.bots.findOne({ tokenHash, active: true });
  }

  async findByServer(serverId: string) {
    return db.bots.find({ serverId });
  }

  async findPublic(query = {}) {
    const rows = await db.bots.find({ ...query, isPublic: true });
    if (!Array.isArray(rows)) throw new Error('Bot store returned an invalid public-bot result');
    return rows;
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


  // ── Server-Bot links ───────────────────────────────────────

  async findServerBot(botId: string, serverId: string) {
    return db.serverBots.findOne({ botId, serverId });
  }

  async findServerBots(serverId: string) {
    return db.serverBots.find({ serverId }) ?? [];
  }

  /**
   * Executable bots available in a server. Server-owned credentials are
   * installed by definition; marketplace/portable bots are represented by
   * server_bots links. The union is deduplicated and inactive bots are never
   * surfaced to command discovery.
   */
  async findInstalledForServer(serverId: string) {
    const [owned, links] = await Promise.all([
      db.bots.find({ serverId, active: true }),
      db.serverBots.find({ serverId }),
    ]);
    const linkedIds = [...new Set((links ?? []).map((row) => String(row.botId ?? '')).filter(Boolean))];
    const linked = linkedIds.length ? await db.bots.find({ _id: { $in: linkedIds }, active: true }) : [];
    const byId = new Map<string, Bot>();
    for (const row of [...(owned ?? []), ...(linked ?? [])]) {
      if (row?._id) byId.set(String(row._id), row);
    }
    return [...byId.values()];
  }

  async countServerInstalls(botId: string) {
    const count = await db.serverBots.count({ botId });
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Server-bot store returned an invalid install count');
    return count;
  }

  /** `grantedScopes` is what the installing admin consented to (see lib/botScopes.ts). */
  async addToServer(botId: string, serverId: string, addedBy: string, grantedScopes: readonly string[] = ['commands']) {
    return db.serverBots.insert({ _id: uuidv4(), botId, serverId, addedBy, addedAt: Date.now(), grantedScopes: [...grantedScopes] });
  }

  /** Re-consent after a listing changed what it asks for. */
  async updateServerGrant(botId: string, serverId: string, grantedScopes: readonly string[]) {
    return db.serverBots.update({ botId, serverId }, { $set: { grantedScopes: [...grantedScopes] } });
  }

  async removeFromServer(botId: string, serverId: string) {
    return db.serverBots.remove({ botId, serverId });
  }

  // ── Ratings ────────────────────────────────────────────────

  async findRating(botId: string, userId: string) {
    return db.botRatings.findOne({ botId, userId });
  }

  async findAllRatings(botId: string) {
    return db.botRatings.find({ botId }) ?? [];
  }

  async insertRating(botId: string, userId: string, rating: number) {
    return db.botRatings.insert({ _id: uuidv4(), botId, userId, rating, createdAt: Date.now() });
  }

  async updateRating(id: string, rating: number) {
    return db.botRatings.update({ _id: id }, { $set: { rating, updatedAt: Date.now() } });
  }

  /** Gelen Discord-benzeri webhook kaydı (bots.js POST /webhooks/:id). */
  async findIncomingWebhook(id: string) {
    return db.webhooks.findOne({ _id: id });
  }

  async findWhere(query: Record<string, unknown>) {
    return db.bots.find(query);
  }
}

export default new BotRepository();
