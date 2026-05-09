// server/db/repositories/ServerAssetRepository.js
// Sunucu varlıkları (emoji, gif, soundboard, template, onboarding) sorgularını toplar.

'use strict';
const { v4: uuidv4 } = require('uuid');
const db = require('../loader');

class ServerAssetRepository {
  // ── Emojis ─────────────────────────────────────────────────

  async findEmojis(serverId) {
    return db.serverEmojis?.find({ serverId }) ?? [];
  }

  async findEmojisSorted(serverId) {
    return db.serverEmojis?.find({ serverId }).sort({ createdAt: 1 }) ?? [];
  }

  async findEmoji(id) {
    return db.serverEmojis?.findOne({ _id: id });
  }

  async findEmojiByIdAndServer(id, serverId) {
    return db.serverEmojis?.findOne({ _id: id, serverId });
  }

  async insertEmoji(data) {
    return db.serverEmojis?.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async updateEmoji(id, serverId, fields) {
    return db.serverEmojis?.update({ _id: id, serverId }, { $set: fields });
  }

  async deleteEmoji(id, serverId) {
    return db.serverEmojis?.remove({ _id: id, serverId });
  }

  async deleteEmojisByServer(serverId) {
    return db.serverEmojis?.remove({ serverId });
  }

  async findEmojiByServerAndName(serverId, name) {
    return db.serverEmojis?.findOne({ serverId, name });
  }

  // ── GIFs ───────────────────────────────────────────────────

  async findGifs(serverId) {
    return db.serverGifs?.find({ serverId }) ?? [];
  }

  async findGifsByServerIds(serverIds) {
    if (!serverIds?.length) return [];
    return db.serverGifs?.find({ serverId: { $in: serverIds } }) ?? [];
  }

  async findGifByIdAndServer(id, serverId) {
    return db.serverGifs?.findOne({ _id: id, serverId });
  }

  async insertGif(data) {
    return db.serverGifs?.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async deleteGif(id, serverId) {
    return db.serverGifs?.remove({ _id: id, serverId });
  }

  async deleteGifsByServer(serverId) {
    return db.serverGifs?.remove({ serverId });
  }

  // ── Soundboard ─────────────────────────────────────────────

  async findSounds(serverId) {
    return db.soundboard?.find({ serverId }) ?? [];
  }

  async findSoundsSorted(serverId) {
    return db.soundboard?.find({ serverId }).sort({ createdAt: 1 }) ?? [];
  }

  async insertSound(data) {
    return db.soundboard?.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async findSoundByIdAndServer(id, serverId) {
    return db.soundboard?.findOne({ _id: id, serverId });
  }

  async deleteSound(id, serverId) {
    return db.soundboard?.remove({ _id: id, serverId });
  }

  // ── Server Templates ───────────────────────────────────────

  async findTemplate(id) {
    return db.serverTemplates?.findOne({ _id: id });
  }

  async findTemplates(query = {}) {
    return db.serverTemplates?.find(query) ?? [];
  }

  async insertTemplate(data) {
    const row = {
      createdAt: Date.now(),
      ...data,
      _id:       data._id || uuidv4(),
    };
    return db.serverTemplates?.insert(row);
  }

  async updateTemplate(id, fields) {
    return db.serverTemplates?.update({ _id: id }, { $set: fields });
  }

  async deleteTemplate(id) {
    return db.serverTemplates?.remove({ _id: id });
  }

  // ── Onboarding ─────────────────────────────────────────────

  async findOnboarding(serverId) {
    return db.serverOnboarding?.findOne({ serverId });
  }

  async upsertOnboarding(serverId, fields) {
    const existing = await this.findOnboarding(serverId);
    if (existing) {
      return db.serverOnboarding?.update({ serverId }, { $set: fields });
    }
    return db.serverOnboarding?.insert({ _id: uuidv4(), serverId, createdAt: Date.now(), ...fields });
  }

  async findOnboardingCompletions(serverId) {
    return db.onboardingCompletions?.find({ serverId }) ?? [];
  }

  async markOnboardingComplete(userId, serverId) {
    return db.onboardingCompletions?.insert({ _id: `${userId}_${serverId}`, userId, serverId, completedAt: Date.now() });
  }

  async findOnboardingCompletion(serverId, userId) {
    return db.onboardingCompletions?.findOne({ serverId, userId });
  }

  async insertOnboardingCompletion(doc) {
    return db.onboardingCompletions?.insert(doc);
  }

  async findMemberRole(userId, roleId, serverId) {
    return db.memberRoles?.findOne({ userId, roleId, serverId });
  }

  async insertMemberRole(doc) {
    return db.memberRoles?.insert(doc);
  }
}

module.exports = new ServerAssetRepository();
export {};
