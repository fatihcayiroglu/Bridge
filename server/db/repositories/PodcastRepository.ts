// Podcast ayarları ve bölümler

'use strict';
const { v4: uuidv4 } = require('uuid');
const db = require('../loader');

class PodcastRepository {
  async findSettingsByChannel(channelId) {
    return db.podcastSettings?.findOne({ channelId });
  }

  async upsertSettings(channelId, updates) {
    const existing = await this.findSettingsByChannel(channelId);
    if (existing) {
      return db.podcastSettings?.update({ channelId }, { $set: updates });
    }
    return db.podcastSettings?.insert({ _id: uuidv4(), channelId, ...updates, createdAt: Date.now() });
  }

  async findPublishedEpisodes(channelId) {
    return db.podcastEpisodes?.find({ channelId, published: true }) ?? [];
  }

  async findEpisodes(filter) {
    return db.podcastEpisodes?.find(filter) ?? [];
  }

  async findEpisodeOne(query) {
    return db.podcastEpisodes?.findOne(query);
  }

  async insertEpisode(doc) {
    return db.podcastEpisodes?.insert(doc);
  }

  async removeEpisode(filter) {
    return db.podcastEpisodes?.remove(filter);
  }
}

module.exports = new PodcastRepository();
export {};
