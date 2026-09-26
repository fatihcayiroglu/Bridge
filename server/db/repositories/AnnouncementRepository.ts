// server/db/repositories/AnnouncementRepository.ts
// Sprint 98 — announcement route pool.query() çağrıları repository katmanına taşındı.

import { pool } from '../postgres/pool';

export interface ChannelFollowRow {
  targetChannelId: string;
  targetServerId:  string;
}

export interface CrosspostMessageInput {
  bridgeMessageId: string;
  sourceMessageId: string;
  sourceChannelId: string;
  sourceServerId: string;
  targetChannelId: string;
  targetServerId: string;
  userId: string;
  username: string;
  displayName: string;
  avatarColor: string;
  avatarUrl?: string | null;
  content: string;
  fileUrl?: string | null;
  fileName?: string | null;
  fileType?: string | null;
  createdAt: number;
}

export interface PersistedCrosspost {
  bridgeMessageId: string;
  created: boolean;
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

  /**
   * Persist a follower-channel crosspost atomically with its idempotency log.
   *
   * The historical route wrote only `crosspost_log` and then emitted a socket
   * payload, so reloads lost the crosspost.  The unique (source message,
   * target channel) key also makes concurrent/retried publish requests safe.
   * If a legacy log row exists without the corresponding message, this method
   * heals it by inserting the missing message with the existing bridge id.
   */
  async persistCrosspost(input: CrosspostMessageInput): Promise<PersistedCrosspost> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const logInsert = await client.query<{ bridgeMessageId: string }>(
        `INSERT INTO crosspost_log
           ("messageId","sourceChannelId","sourceServerId","targetChannelId","targetServerId","bridgeMessageId","crosspostedAt")
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT("messageId","targetChannelId") DO NOTHING
         RETURNING "bridgeMessageId"`,
        [
          input.sourceMessageId, input.sourceChannelId, input.sourceServerId,
          input.targetChannelId, input.targetServerId, input.bridgeMessageId,
          input.createdAt,
        ],
      );

      let bridgeMessageId = logInsert.rows[0]?.bridgeMessageId;
      if (!bridgeMessageId) {
        const existing = await client.query<{
          sourceChannelId: string; sourceServerId: string;
          targetServerId: string; bridgeMessageId: string;
        }>(
          `SELECT "sourceChannelId","sourceServerId","targetServerId","bridgeMessageId"
             FROM crosspost_log
            WHERE "messageId"=$1 AND "targetChannelId"=$2
            FOR UPDATE`,
          [input.sourceMessageId, input.targetChannelId],
        );
        const row = existing.rows[0];
        if (!row || row.sourceChannelId !== input.sourceChannelId ||
            row.sourceServerId !== input.sourceServerId ||
            row.targetServerId !== input.targetServerId) {
          throw new Error('Crosspost log tenant integrity mismatch');
        }
        bridgeMessageId = row.bridgeMessageId;
      }

      const bridgedFrom = JSON.stringify({
        channelId: input.sourceChannelId,
        serverId: input.sourceServerId,
        messageId: input.sourceMessageId,
      });
      const inserted = await client.query<{ _id: string }>(
        `INSERT INTO messages
           (_id,"channelId","serverId","userId",username,"displayName","avatarColor","avatarUrl",
            content,type,"fileUrl","fileName","fileType","bridgedFrom","createdAt")
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'crosspost',$10,$11,$12,$13::jsonb,$14)
         ON CONFLICT(_id) DO NOTHING
         RETURNING _id`,
        [
          bridgeMessageId, input.targetChannelId, input.targetServerId,
          input.userId, input.username, input.displayName, input.avatarColor,
          input.avatarUrl ?? null, input.content, input.fileUrl ?? null,
          input.fileName ?? null, input.fileType ?? null, bridgedFrom, input.createdAt,
        ],
      );

      if (!inserted.rows.length) {
        const existingMessage = await client.query<{ channelId: string; serverId: string }>(
          `SELECT "channelId","serverId" FROM messages WHERE _id=$1`,
          [bridgeMessageId],
        );
        const row = existingMessage.rows[0];
        if (!row || row.channelId !== input.targetChannelId || row.serverId !== input.targetServerId) {
          throw new Error('Crosspost message tenant integrity mismatch');
        }
      }

      await client.query('COMMIT');
      return { bridgeMessageId, created: inserted.rows.length > 0 };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

export const Announcements = new AnnouncementRepository();
