// server/db/repositories/AnnouncementRepository.ts
// Sprint 98 — announcement route pool.query() çağrıları repository katmanına taşındı.

import { pool } from '../postgres/pool';

export interface ChannelFollowRow {
  targetChannelId: string;
  targetServerId:  string;
}

class AnnouncementRepository {
  async followChannel(
    sourceChannelId: string,
    sourceServerId:  string,
    targetChannelId: string,
    targetServerId:  string,
    followedByUserId: string,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO channel_follows
         ("sourceChannelId","sourceServerId","targetChannelId","targetServerId","followedByUserId")
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT("sourceChannelId","targetChannelId") DO NOTHING`,
      [sourceChannelId, sourceServerId, targetChannelId, targetServerId, followedByUserId]
    );
  }

  async unfollowChannel(sourceChannelId: string, targetChannelId: string): Promise<void> {
    await pool.query(
      `DELETE FROM channel_follows WHERE "sourceChannelId"=$1 AND "targetChannelId"=$2`,
      [sourceChannelId, targetChannelId]
    );
  }

  async getFollowers(sourceChannelId: string): Promise<Array<{ targetChannelId: string; targetServerId: string }>> {
    const res = await pool.query<{ targetChannelId: string; targetServerId: string }>(
      `SELECT "targetChannelId", "targetServerId" FROM channel_follows WHERE "sourceChannelId"=$1`,
      [sourceChannelId]
    );
    return res.rows;
  }

  async recordCrosspost(
    messageId:       string,
    sourceChannelId: string,
    sourceServerId:  string,
    targetChannelId: string,
    targetServerId:  string,
    bridgeMessageId: string,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO crosspost_log
         ("messageId","sourceChannelId","sourceServerId","targetChannelId","targetServerId","bridgeMessageId","crosspostedAt")
       VALUES($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT DO NOTHING`,
      [messageId, sourceChannelId, sourceServerId, targetChannelId, targetServerId, bridgeMessageId]
    );
  }
}

export const Announcements = new AnnouncementRepository();
