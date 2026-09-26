// server/lib/channelActivity.ts
//
// "Which channels have something I have not read?" (Final21 Phase 15).
//
// Measured before this module: only mentions and replies produced any unread
// signal. A normal message in a channel the viewer was not looking at left no
// trace — not live (clients join only the open channel's room) and not after a
// reload (the server kept no such state). Every mainstream chat product marks
// such channels; Bridge did not.
//
// Two paths, one truth:
//   · Snapshot: read cursors (`channel_read_positions`, advanced when history is
//     loaded or a live message is seen) compared with newer messages from other
//     people — `db/queries/activityUnread.ts`. Authoritative; used on connect,
//     reconnect, server switch and when the tab becomes visible.
//   · Live: a content-free `channel:activity` signal to `watch:<channelId>` rooms.
//     A socket joins those rooms ONLY for channels it can view, and only for the
//     server it is looking at (`watchServerChannels`). Nothing about a channel a
//     member cannot see is ever sent to them.

import { Channels, Members } from '../db/repositories';
import { MAX_WATCHED_CHANNELS, MESSAGE_CHANNEL_TYPES } from '../db/queries/activityUnread';
import { invalidateChannelMessages } from './messageCache';
import { canViewChannel } from './permissions';
import { newRequestId, runWithRequestContext } from './requestContext';

export { MAX_UNREAD_CHANNELS, MAX_WATCHED_CHANNELS, MESSAGE_CHANNEL_TYPES } from '../db/queries/activityUnread';

export const watchRoom = (channelId: string): string => `watch:${channelId}`;

export interface ChannelActivityMessage {
  _id?: unknown;
  channelId?: unknown;
  serverId?: unknown;
  userId?: unknown;
  createdAt?: unknown;
}

interface ActivityEmitter {
  to(room: string): { emit(event: string, payload: unknown): unknown };
}

/** Announce that a persisted message exists. No content, author name or attachment is sent. */
export function announceChannelActivity(io: ActivityEmitter | null | undefined, message: ChannelActivityMessage | null | undefined): void {
  const channelId = typeof message?.channelId === 'string' ? message.channelId : '';
  const serverId = typeof message?.serverId === 'string' ? message.serverId : '';
  const messageId = typeof message?._id === 'string' ? message._id : '';
  if (!io || !channelId || !serverId || !messageId) return;
  io.to(watchRoom(channelId)).emit('channel:activity', {
    channelId,
    serverId,
    messageId,
    userId: typeof message?.userId === 'string' ? message.userId : null,
    createdAt: Number(message?.createdAt) || Date.now(),
  });
}

type MessageBroadcaster = ActivityEmitter;

/**
 * A persisted message reaches the people in its channel (`message:new`) and the
 * people watching the server (`channel:activity`). For callers that have already
 * invalidated the channel history cache.
 */
export function broadcastPersistedMessage(io: MessageBroadcaster | null | undefined, message: ChannelActivityMessage | null | undefined): void {
  const channelId = typeof message?.channelId === 'string' ? message.channelId : '';
  if (!io || !channelId) return;
  io.to(`channel:${channelId}`).emit('message:new', message);
  announceChannelActivity(io, message);
}

/**
 * Everything a newly persisted message needs to be visible everywhere: the first
 * history page is invalidated (a reload must show it — Final21 Phase 14/15 found
 * five creators that skipped this), then it is broadcast. Without `io` (jobs
 * before the socket server exists) the cache is still invalidated.
 */
export async function publishPersistedMessage(io: MessageBroadcaster | null | undefined, message: ChannelActivityMessage | null | undefined): Promise<void> {
  const channelId = typeof message?.channelId === 'string' ? message.channelId : '';
  if (!channelId) return;
  await invalidateChannelMessages(channelId);
  broadcastPersistedMessage(io, message);
}

interface WatchingSocket {
  id?: string;
  rooms: Set<string>;
  join(room: string): unknown;
  leave(room: string): unknown;
}

/**
 * Replace the socket's watch set with the message channels of `serverId` it can
 * view. Returns the watched channel ids; an empty result (and no watch rooms)
 * for a non-member.
 */
export async function watchServerChannels(socket: WatchingSocket, userId: string, serverId: string): Promise<string[]> {
  const leaveWatchRooms = (keep: ReadonlySet<string>) => {
    for (const room of [...socket.rooms]) {
      if (room.startsWith('watch:') && !keep.has(room)) socket.leave(room);
    }
  };
  if (!userId || !serverId || !await Members.findOne(userId, serverId)) {
    leaveWatchRooms(new Set<string>());
    return [];
  }
  const channels = (await Channels.findByServer(serverId) as Array<{ _id?: unknown; type?: unknown }>)
    .filter((channel) => typeof channel._id === 'string' && MESSAGE_CHANNEL_TYPES.includes(String(channel.type ?? 'text')))
    .slice(0, MAX_WATCHED_CHANNELS);

  // One request-scoped memo: server row, membership and roles are read once, not per channel.
  const viewable = await runWithRequestContext(
    { requestId: newRequestId(), userId, socketId: socket.id, memo: new Map() },
    async () => {
      const ids: string[] = [];
      for (const channel of channels) {
        const channelId = String(channel._id);
        if (await canViewChannel(userId, serverId, channelId)) ids.push(channelId);
      }
      return ids;
    },
  );
  const keep = new Set<string>(viewable.map(watchRoom));
  leaveWatchRooms(keep);
  for (const room of keep) socket.join(room);
  return viewable;
}
