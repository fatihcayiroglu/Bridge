// server/db/repositories/ServerAssetRepository.ts
// Sunucu varlıkları (emoji, gif, soundboard, template, onboarding) sorgularını toplar.

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';

class ServerAssetRepository {
  // ── Emojis ─────────────────────────────────────────────────

  async findEmojis(serverId: string) {
    return db.serverEmojis?.find({ serverId }) ?? [];
  }

  async findEmojisSorted(serverId: string) {
    return db.serverEmojis?.find({ serverId }).sort({ createdAt: 1 }) ?? [];
  }

  async findEmoji(id: string) {
    return db.serverEmojis?.findOne({ _id: id });
  }

  async findEmojiByIdAndServer(id: string, serverId: string) {
    return db.serverEmojis?.findOne({ _id: id, serverId });
  }

  async insertEmoji(data: Record<string, unknown>) {
    return db.serverEmojis?.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async updateEmoji(id: string, serverId: string, fields: Record<string, unknown>) {
    return db.serverEmojis?.update({ _id: id, serverId }, { $set: fields });
  }

  async deleteEmoji(id: string, serverId: string) {
    return db.serverEmojis?.remove({ _id: id, serverId });
  }

  async deleteEmojisByServer(serverId: string) {
    return db.serverEmojis?.remove({ serverId });
  }

  async findEmojiByServerAndName(serverId: string, name: string) {
    return db.serverEmojis?.findOne({ serverId, name });
  }

  // ── GIFs ───────────────────────────────────────────────────

  async findGifs(serverId: string) {
    return db.serverGifs?.find({ serverId }) ?? [];
  }

  async findGifsByServerIds(serverIds: string | string[]) {
    const ids = Array.isArray(serverIds) ? serverIds : [serverIds];
    if (!ids.length) return [];
    return db.serverGifs?.find({ serverId: { $in: ids } }) ?? [];
  }

  async findGifByIdAndServer(id: string, serverId: string) {
    return db.serverGifs?.findOne({ _id: id, serverId });
  }

  async insertGif(data: Record<string, unknown>) {
    return db.serverGifs?.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async deleteGif(id: string, serverId: string) {
    return db.serverGifs?.remove({ _id: id, serverId });
  }

  async deleteGifsByServer(serverId: string) {
    return db.serverGifs?.remove({ serverId });
  }

  // ── Soundboard ─────────────────────────────────────────────

  async findSounds(serverId: string) {
    return db.soundboard?.find({ serverId }) ?? [];
  }

  async findSoundsSorted(serverId: string) {
    return db.soundboard?.find({ serverId }).sort({ createdAt: 1 }) ?? [];
  }

  async insertSound(data: Record<string, unknown>) {
    return db.soundboard?.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async findSoundByIdAndServer(id: string, serverId: string) {
    return db.soundboard?.findOne({ _id: id, serverId });
  }

  async deleteSound(id: string, serverId: string) {
    return db.soundboard?.remove({ _id: id, serverId });
  }

  // ── Server Templates ───────────────────────────────────────

  async findTemplate(id: string) {
    return db.serverTemplates?.findOne({ _id: id });
  }

  async findTemplates(query = {}) {
    return db.serverTemplates?.find(query) ?? [];
  }

  async insertTemplate(data: Record<string, unknown>) {
    const row = {
      createdAt: Date.now(),
      ...data,
      _id:       data._id || uuidv4(),
    };
    return db.serverTemplates?.insert(row);
  }

  async updateTemplate(id: string, fields: Record<string, unknown>) {
    return db.serverTemplates?.update({ _id: id }, { $set: fields });
  }

  async deleteTemplate(id: string) {
    return db.serverTemplates?.remove({ _id: id });
  }

  // ── Onboarding ─────────────────────────────────────────────

  async findOnboarding(serverId: string) {
    return db.serverOnboarding?.findOne({ serverId });
  }

  async upsertOnboarding(serverId: string, fields: Record<string, unknown>) {
    const existing = await this.findOnboarding(serverId);
    if (existing) {
      return db.serverOnboarding?.update({ serverId }, { $set: fields });
    }
    return db.serverOnboarding?.insert({ _id: uuidv4(), serverId, createdAt: Date.now(), ...fields });
  }

  async findOnboardingCompletions(serverId: string) {
    return db.onboardingCompletions?.find({ serverId }) ?? [];
  }

  async markOnboardingComplete(userId: string, serverId: string) {
    return db.onboardingCompletions?.insert({ _id: `${userId}_${serverId}`, userId, serverId, completedAt: Date.now() });
  }

  async findOnboardingCompletion(serverId: string, userId: string) {
    return db.onboardingCompletions?.findOne({ serverId, userId });
  }

  async insertOnboardingCompletion(doc: Record<string, unknown>) {
    return db.onboardingCompletions?.insert(doc);
  }

  async findMemberRole(userId: string, roleId: string, serverId: string) {
    return db.memberRoles?.findOne({ userId, roleId, serverId });
  }

  async insertMemberRole(doc: Record<string, unknown>) {
    return db.memberRoles?.insert(doc);
  }
}

export default new ServerAssetRepository();
