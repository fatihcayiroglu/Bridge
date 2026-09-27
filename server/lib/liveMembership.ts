import type { Server as SocketIOServer, Socket } from 'socket.io';
import { Channels, Threads } from '../db/repositories';
import { canViewChannel } from './permissions';
import { newRequestId, runWithRequestContext } from './requestContext';
import logger from './logger';

// `watch` was ADDED in Final21 Phase 16. Phase 15 introduced `watch:<channelId>`
// rooms for unread activity and did NOT add them here: a member who was kicked
// or banned kept those rooms and went on receiving `channel:activity` for that
// server's channels until they happened to reconnect. The signal is
// content-free, but it still reveals THAT a channel they can no longer see is
// active — the same leak class this eviction exists to close.
const CHANNEL_SCOPED_PREFIXES = new Set(['channel', 'voice', 'stage', 'canvas', 'draw', 'video-grid', 'watch']);

export function roomBelongsToServer(
  room: string,
  serverId: string,
  channelIds: ReadonlySet<string>,
  threadIds: ReadonlySet<string>,
): boolean {
  if (room === `server:${serverId}`) return true;
  const split = room.indexOf(':');
  if (split <= 0) return false;
  const prefix = room.slice(0, split);
  const id = room.slice(split + 1);
  if (prefix === 'thread') return threadIds.has(id);
  return CHANNEL_SCOPED_PREFIXES.has(prefix) && channelIds.has(id);
}

/**
 * Membership revocation must take effect on already-open sockets immediately.
 * This deliberately leaves user:/dm:/gdm: rooms alone because they are not
 * owned by the revoked server membership.
 */
export async function evictUserFromServerRooms(
  io: SocketIOServer | null | undefined,
  userId: string,
  serverId: string,
): Promise<number> {
  if (!io || !userId || !serverId) return 0;

  const channelIds = new Set(await Channels.findIdsByServer(serverId));
  const sockets = await io.in(`user:${userId}`).fetchSockets();

  // Do not query every channel's thread list on a large server. Only resolve
  // thread rooms the target user's live sockets are actually subscribed to.
  const candidateThreadIds = new Set<string>();
  for (const socket of sockets as unknown as Array<Socket>) {
    for (const room of socket.rooms) {
      if (room.startsWith('thread:')) candidateThreadIds.add(room.slice('thread:'.length));
    }
  }
  const threadRows = await Promise.all(Array.from(candidateThreadIds, id => Threads.findById(id)));
  const threadIds = new Set(
    threadRows
      .filter((thread): thread is NonNullable<typeof thread> => !!thread && String(thread.serverId) === serverId)
      .map(thread => String(thread._id)),
  );

  let leaves = 0;
  for (const socket of sockets as unknown as Array<Socket>) {
    for (const room of Array.from(socket.rooms)) {
      if (!roomBelongsToServer(room, serverId, channelIds, threadIds)) continue;
      await socket.leave(room);
      leaves += 1;
    }

    const mutable = socket as Socket & {
      currentChannel?: string;
      currentVoiceChannel?: string;
      currentVoiceServer?: string;
    };
    if (mutable.currentChannel && channelIds.has(mutable.currentChannel)) mutable.currentChannel = undefined;
    if (mutable.currentVoiceChannel && channelIds.has(mutable.currentVoiceChannel)) {
      mutable.currentVoiceChannel = undefined;
      mutable.currentVoiceServer = undefined;
    }
    socket.emit('membership:revoked', { serverId });
  }
  return leaves;
}

export async function evictUserFromServerRoomsBestEffort(
  io: SocketIOServer | null | undefined,
  userId: string,
  serverId: string,
): Promise<void> {
  try {
    await evictUserFromServerRooms(io, userId, serverId);
  } catch (err) {
    logger.error({ err, userId, serverId, event: 'socket.membership_evict.failed' }, 'Live membership eviction failed.');
  }
}

/**
 * ════════════════════════════════════════════════════════════════════════════
 * PERMISSION revocation must reach OPEN sockets too (Final21 Phase 16)
 * ════════════════════════════════════════════════════════════════════════════
 * MEASURED LEAK — `p16-perm-revocation-probe`, real server, two accounts:
 *   1. Alice joins channel X (allowed) and receives `message:new` — positive control.
 *   2. The owner denies VIEW_CHANNELS to @everyone on X.
 *   3. Bob posts in X. Alice's HTTP read is correctly refused (403) — but her ALREADY OPEN
 *      socket still received the message, content and all, plus `channel:activity`.
 *
 * Membership revocation (kick/ban/leave) was handled by `evictUserFromServerRooms`.
 * Permission revocation took a different path: the routes called `invalidatePerms`, which
 * only clears the permission CACHE. Nothing touched the sockets, so the rooms joined while
 * access existed kept delivering until the client happened to switch channels or reconnect.
 *
 * `canViewChannel` is fail-closed, so an unresolvable channel evicts rather than keeps.
 */
function socketUserId(socket: Socket): string {
  const data = (socket as Socket & { data?: { userId?: unknown } }).data;
  if (typeof data?.userId === 'string' && data.userId) return data.userId;
  const direct = (socket as Socket & { userId?: unknown }).userId;
  if (typeof direct === 'string' && direct) return direct;
  // Works for every adapter: each socket joins its own `user:<id>` room.
  for (const room of socket.rooms) if (room.startsWith('user:')) return room.slice('user:'.length);
  return '';
}

export async function evictSocketsWithoutChannelAccess(
  io: SocketIOServer | null | undefined,
  serverId: string,
  channelId?: string | null,
): Promise<number> {
  if (!io || !serverId) return 0;

  const affected = channelId
    ? new Set([String(channelId)])
    : new Set((await Channels.findIdsByServer(serverId)).map(String));
  if (!affected.size) return 0;

  const sockets = await io.in(`server:${serverId}`).fetchSockets();
  let leaves = 0;

  for (const socket of sockets as unknown as Array<Socket>) {
    const userId = socketUserId(socket);
    if (!userId) continue;

    // Which of this socket's rooms belong to an affected channel? Thread rooms are
    // resolved only for threads this socket actually holds, never by listing them all.
    const roomsByChannel = new Map<string, string[]>();
    const threadRooms = new Map<string, string>();
    for (const room of socket.rooms) {
      const split = room.indexOf(':');
      if (split <= 0) continue;
      const prefix = room.slice(0, split);
      const id = room.slice(split + 1);
      if (prefix === 'thread') { threadRooms.set(id, room); continue; }
      if (!CHANNEL_SCOPED_PREFIXES.has(prefix) || !affected.has(id)) continue;
      const list = roomsByChannel.get(id);
      if (list) list.push(room); else roomsByChannel.set(id, [room]);
    }
    if (threadRooms.size) {
      const rows = await Promise.all(Array.from(threadRooms.keys(), id => Threads.findById(id)));
      for (const thread of rows) {
        if (!thread || String(thread.serverId) !== serverId) continue;
        const parent = String(thread.channelId ?? '');
        if (!affected.has(parent)) continue;
        const room = threadRooms.get(String(thread._id));
        if (!room) continue;
        const list = roomsByChannel.get(parent);
        if (list) list.push(room); else roomsByChannel.set(parent, [room]);
      }
    }
    if (!roomsByChannel.size) continue;

    // One request scope per socket so repeated permission resolution is memoized.
    await runWithRequestContext({ requestId: newRequestId(), userId, socketId: socket.id, memo: new Map() }, async () => {
      for (const [cid, rooms] of roomsByChannel) {
        if (await canViewChannel(userId, serverId, cid)) continue;
        for (const room of rooms) { await socket.leave(room); leaves += 1; }

        const mutable = socket as Socket & {
          currentChannel?: string;
          currentVoiceChannel?: string;
          currentVoiceServer?: string;
        };
        if (mutable.currentChannel === cid) mutable.currentChannel = undefined;
        if (mutable.currentVoiceChannel === cid) {
          mutable.currentVoiceChannel = undefined;
          mutable.currentVoiceServer = undefined;
        }
        socket.emit('channel:access-revoked', { serverId, channelId: cid });
        logger.info(
          { userId, serverId, channelId: cid, rooms: rooms.length, event: 'socket.channel_access_evicted' },
          'Channel access revoked; live rooms evicted.',
        );
      }
    });
  }
  return leaves;
}

/** Never let an eviction failure break the permission write that triggered it. */
export async function evictSocketsWithoutChannelAccessBestEffort(
  io: SocketIOServer | null | undefined,
  serverId: string,
  channelId?: string | null,
): Promise<void> {
  try {
    await evictSocketsWithoutChannelAccess(io, serverId, channelId);
  } catch (err) {
    logger.error(
      { err, serverId, channelId, event: 'socket.channel_access_evict.failed' },
      'Channel access eviction failed.',
    );
  }
}
