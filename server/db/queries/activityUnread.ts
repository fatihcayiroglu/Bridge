// server/db/queries/activityUnread.ts
//
// Unread channel activity snapshot query (Final21 Phase 15). Kept free of repository
// imports so the notification repository can use it without an import cycle; the
// behaviour is documented in lib/channelActivity.ts.

import type { Pool } from 'pg';

/** Channel types that carry chat messages (voice/stage do not have an unread state). */
export const MESSAGE_CHANNEL_TYPES: readonly string[] = ['text', 'announcement', 'forum'];
/** Upper bound for one watch set; a server with more message channels is watched partially. */
export const MAX_WATCHED_CHANNELS = 500;
/** Upper bound for one snapshot. */
export const MAX_UNREAD_CHANNELS = 1000;

/**
 * Channels, across the user's memberships, holding a message from someone else
 * that is newer than the user's read cursor — or, with no cursor yet, newer than
 * the moment they joined the server (joining is not a backlog of "unread").
 * Visibility and mute are applied by the caller.
 *
 * The row comparison follows the message pagination index
 * (`idx_messages_channel_cursor`: "channelId", "createdAt" DESC, _id DESC), and
 * EXISTS stops at the first qualifying message.
 */
export const ACTIVITY_UNREAD_SQL = `
SELECT c._id AS "channelId", c."serverId" AS "serverId"
  FROM members mem
  JOIN channels c ON c."serverId" = mem."serverId"
  LEFT JOIN channel_read_positions rp
    ON rp."userId" = mem."userId" AND rp."channelId" = c._id
 WHERE mem."userId" = $1
   AND mem.banned = FALSE
   AND c.type = ANY($2::text[])
   AND EXISTS (
     SELECT 1
       FROM messages m
      WHERE m."channelId" = c._id
        AND (m."createdAt", m._id) > (COALESCE(rp."lastReadAt", mem."joinedAt"), COALESCE(rp."lastReadMessageId", ''))
        AND m."deletedAt" IS NULL
        AND m."userId" IS DISTINCT FROM $1
   )
 ORDER BY c."serverId", c._id
 LIMIT $3`;

export async function queryActivityUnreadChannels(
  pool: Pick<Pool, 'query'>,
  userId: string,
  limit = MAX_UNREAD_CHANNELS,
): Promise<Array<{ channelId: string; serverId: string }>> {
  const { rows } = await pool.query(ACTIVITY_UNREAD_SQL, [userId, MESSAGE_CHANNEL_TYPES, limit]);
  return (rows as Array<{ channelId: unknown; serverId: unknown }>)
    .map((row) => ({ channelId: String(row.channelId), serverId: String(row.serverId) }));
}
