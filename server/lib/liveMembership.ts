import type { Server as SocketIOServer, Socket } from 'socket.io';
import { Channels, Members, Threads } from '../db/repositories';
import { PERMS, canViewChannel, hasPermission, resolvePermissions } from './permissions';
import { isMemberTimedOut } from './memberTimeout';
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

// ════════════════════════════════════════════════════════════════════════════
// VOICE STATE MUST FOLLOW A REVOCATION ON EVERY NODE (P1 multi-node, STALE-02/03)
// ════════════════════════════════════════════════════════════════════════════
// Leaving Socket.IO rooms is not enough for voice. A voice session also lives in
// the shared voice roster (Redis `voice:room:<ch>`, which `webrtc:*` signalling
// trusts), in the socket's `currentVoiceChannel`, and — for SFU sessions — in the
// owning node's mediasoup peer state. `fetchSockets()` returns sockets on OTHER
// nodes as RemoteSocket proxies: `leave()`/`emit()` travel through the adapter,
// but assigning `currentVoiceChannel` on a proxy changes nothing. Measured with
// three real nodes: a user kicked through another node kept injecting voice
// state and WebRTC offers, and stayed in every peer's roster as a ghost.
//
// The node that holds the socket must run the real leave path. The revoking
// node runs it for its own sockets and asks every other node to do the same.
export type LocalVoiceEvictor = (
  io: SocketIOServer,
  userId: string,
  channelIds: readonly string[],
) => Promise<void>;

export type LocalVoicePublishRevoker = (
  io: SocketIOServer,
  userId: string,
  channelId: string,
) => Promise<void>;

const VOICE_EVICT_EVENT = 'membership:voice-evict';
const VOICE_PUBLISH_REVOKE_EVENT = 'membership:voice-publish-revoke';
const MAX_EVICT_CHANNELS = 5_000;
let localVoiceEvictor: LocalVoiceEvictor | null = null;
let localVoicePublishRevoker: LocalVoicePublishRevoker | null = null;
const clusterBound = new WeakSet<object>();

/** Socket setup registers the node-local leave path (voice roster + SFU peer). */
export function registerLocalVoiceEvictor(evictor: LocalVoiceEvictor | null): void {
  localVoiceEvictor = evictor;
}

/** Socket setup registers the node-local publish revocation (SFU producers of one user in one room). */
export function registerLocalVoicePublishRevoker(revoker: LocalVoicePublishRevoker | null): void {
  localVoicePublishRevoker = revoker;
}

/** One cluster listener per Socket.IO server: run the local leave path for revocations decided elsewhere. */
export function bindVoiceEvictionClusterControl(io: SocketIOServer): void {
  if (clusterBound.has(io)) return;
  clusterBound.add(io);
  io.on(VOICE_EVICT_EVENT as never, ((payload: unknown) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const { userId, channelIds } = payload as { userId?: unknown; channelIds?: unknown };
    if (typeof userId !== 'string' || !userId || userId.length > 128) return;
    if (!Array.isArray(channelIds) || channelIds.length === 0 || channelIds.length > MAX_EVICT_CHANNELS) return;
    if (!channelIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 128)) return;
    void runLocalVoiceEviction(io, userId, channelIds as string[]);
  }) as never);
  io.on(VOICE_PUBLISH_REVOKE_EVENT as never, ((payload: unknown) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const { userId, channelId } = payload as { userId?: unknown; channelId?: unknown };
    if (typeof userId !== 'string' || !userId || userId.length > 128) return;
    if (typeof channelId !== 'string' || !channelId || channelId.length > 128) return;
    void runLocalVoicePublishRevoke(io, userId, channelId);
  }) as never);
}

async function runLocalVoicePublishRevoke(io: SocketIOServer, userId: string, channelId: string): Promise<void> {
  if (!localVoicePublishRevoker) return;
  try {
    await localVoicePublishRevoker(io, userId, channelId);
  } catch (err) {
    logger.error({ err, userId, channelId, event: 'socket.voice_publish_revoke.failed' }, 'Voice publish revocation failed on this node.');
  }
}

/**
 * The user may stay in the call but must no longer be heard or seen: close
 * their SFU producers wherever the room lives (only the owning node has them).
 */
export async function revokeVoicePublishingEverywhere(
  io: SocketIOServer,
  userId: string,
  channelId: string,
): Promise<void> {
  if (!userId || !channelId) return;
  await runLocalVoicePublishRevoke(io, userId, channelId);
  if (!process.env.REDIS_URL) return;
  const cluster = io as unknown as { serverSideEmit?: (event: string, ...args: unknown[]) => unknown };
  if (typeof cluster.serverSideEmit !== 'function') return;
  try {
    cluster.serverSideEmit(VOICE_PUBLISH_REVOKE_EVENT, { userId, channelId });
  } catch (err) {
    logger.error({ err, userId, event: 'socket.voice_publish_revoke.broadcast_failed' }, 'Voice publish revocation could not reach other nodes.');
  }
}

/**
 * Live voice access of a user who can still VIEW the channel. The SFU checks
 * CONNECT / SPEAK / member timeout only when an operation starts; without this
 * re-check an established call kept flowing after any of them was revoked
 * (measured with real media in the P2 media lab).
 */
async function liveVoiceAccess(userId: string, serverId: string, channelId: string): Promise<'full' | 'listen' | 'none'> {
  const member = await Members.findOne(userId, serverId);
  if (!member || isMemberTimedOut(member.timeoutUntil)) return 'none';
  const perms = await resolvePermissions(userId, serverId, channelId);
  if (!hasPermission(perms, PERMS.CONNECT)) return 'none';
  return hasPermission(perms, PERMS.SPEAK) ? 'full' : 'listen';
}

async function runLocalVoiceEviction(io: SocketIOServer, userId: string, channelIds: readonly string[]): Promise<void> {
  if (!localVoiceEvictor) return;
  try {
    await localVoiceEvictor(io, userId, channelIds);
  } catch (err) {
    logger.error({ err, userId, event: 'socket.voice_evict.failed' }, 'Voice eviction failed on this node.');
  }
}

/** Evict the user's voice sessions in these channels on this node and on every other node. */
export async function evictVoiceEverywhere(
  io: SocketIOServer,
  userId: string,
  channelIds: readonly string[],
): Promise<void> {
  if (!userId || channelIds.length === 0) return;
  await runLocalVoiceEviction(io, userId, channelIds);
  if (!process.env.REDIS_URL) return;
  const cluster = io as unknown as { serverSideEmit?: (event: string, ...args: unknown[]) => unknown };
  if (typeof cluster.serverSideEmit !== 'function') return;
  try {
    cluster.serverSideEmit(VOICE_EVICT_EVENT, { userId, channelIds: channelIds.slice(0, MAX_EVICT_CHANNELS) });
  } catch (err) {
    // Room membership was already revoked through the adapter and the P2P
    // handlers require that membership, so a lost signal cannot re-open
    // injection; the roster entry then clears with the socket's disconnect.
    logger.error({ err, userId, event: 'socket.voice_evict.broadcast_failed' }, 'Voice eviction could not reach other nodes.');
  }
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

  // Voice first, while the local sockets still carry `currentVoiceChannel`.
  await evictVoiceEverywhere(io, userId, Array.from(channelIds));

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
  const voiceEvicted = new Set<string>();
  const publishRevoked = new Set<string>();

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
        if (await canViewChannel(userId, serverId, cid)) {
          if (!rooms.includes(`voice:${cid}`)) continue;
          const access = await liveVoiceAccess(userId, serverId, cid);
          const key = `${userId}:${cid}`;
          if (access === 'none') {
            if (!voiceEvicted.has(key)) {
              voiceEvicted.add(key);
              await evictVoiceEverywhere(io, userId, [cid]);
            }
            await socket.leave(`voice:${cid}`);
            leaves += 1;
            const voiceSocket = socket as Socket & { currentVoiceChannel?: string; currentVoiceServer?: string };
            if (voiceSocket.currentVoiceChannel === cid) {
              voiceSocket.currentVoiceChannel = undefined;
              voiceSocket.currentVoiceServer = undefined;
            }
            logger.info({ userId, serverId, channelId: cid, event: 'socket.voice_access_evicted' },
              'Voice connect permission revoked; live voice session evicted.');
          } else if (access === 'listen' && !publishRevoked.has(key)) {
            publishRevoked.add(key);
            await revokeVoicePublishingEverywhere(io, userId, cid);
            logger.info({ userId, serverId, channelId: cid, event: 'socket.voice_publish_revoked' },
              'Voice speak permission revoked; live producers closed.');
          }
          continue;
        }
        if (rooms.includes(`voice:${cid}`) && !voiceEvicted.has(`${userId}:${cid}`)) {
          voiceEvicted.add(`${userId}:${cid}`);
          await evictVoiceEverywhere(io, userId, [cid]);
        }
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
