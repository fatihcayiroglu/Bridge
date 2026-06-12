// Podcast ayarları ve bölümler

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';
import type { Podcast, PodcastEpisode } from './types/entities';

class PodcastRepository {
  async findSettingsByChannel(channelId: string): Promise<Podcast | null> {
    return db.podcastSettings?.findOne({ channelId });
  }

  async upsertSettings(channelId: string, updates: Partial<Podcast>): Promise<Podcast | { updated: number | null } | undefined> {
    const existing = await this.findSettingsByChannel(channelId);
    if (existing) {
      return db.podcastSettings?.update({ channelId }, { $set: updates });
    }
    return db.podcastSettings?.insert({ _id: uuidv4(), channelId, ...updates, createdAt: Date.now() });
  }

  async findPublishedEpisodes(channelId: string): Promise<PodcastEpisode[]> {
    return db.podcastEpisodes?.find({ channelId, published: true }) ?? [];
  }

  async findEpisodes(filter: Partial<PodcastEpisode>): Promise<PodcastEpisode[]> {
    return db.podcastEpisodes?.find(filter) ?? [];
  }

  async findEpisodeOne(query: Partial<PodcastEpisode>): Promise<PodcastEpisode | null | undefined> {
    return db.podcastEpisodes?.findOne(query);
  }

  async insertEpisode(doc: Partial<PodcastEpisode>): Promise<PodcastEpisode | undefined> {
    return db.podcastEpisodes?.insert(doc);
  }

  async removeEpisode(filter: Partial<PodcastEpisode>): Promise<{ deleted: number | null } | undefined> {
    return db.podcastEpisodes?.remove(filter);
  }
}

export default new PodcastRepository();
