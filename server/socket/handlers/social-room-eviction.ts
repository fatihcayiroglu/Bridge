/**
 * Server-scoped 3D social presence revocation.
 *
 * Membership kick/ban is already enforced by the DB. Socket.IO audience
 * eviction prevents further delivery; this removes the user's *persistent*
 * per-socket avatar entries so other users do not see ghost avatars.
 *
 * A single Redis-backed lock protects the entire read/filter/write. On Redis
 * failure the operation throws: never claim the avatar roster is clean.
 */
import type { Server as SocketIOServer } from 'socket.io';
import { Members } from '../../db/repositories';
import { PERMS, hasPermission, resolvePermissions } from '../../lib/permissions';
import { publicSocialRoom, socialRoomStore, type SocialRoom } from './social-room-store';

/**
 * Advance the cross-node revocation generation BEFORE normal membership
 * audience eviction. In-flight joins capture the old generation and cannot
 * publish presence after the marker changes.
 */
export async function fenceSocialUserRevocation(userId: string, serverId: string): Promise<void> {
  if (!userId || !serverId) return;
  await socialRoomStore.withLock(serverId, async () => {
    await socialRoomStore.markRevocationFence(serverId, userId);
  });
}

export async function evictSocialUserFromRoom(
  io: Pick<SocketIOServer, 'to'>,
  userId: string,
  serverId: string,
): Promise<number> {
  if (!userId || !serverId) return 0;
  const updated = await socialRoomStore.withLock(serverId, async (): Promise<{
    room: SocialRoom;
    removed: number;
  } | null> => {
    const room = await socialRoomStore.load(serverId);
    const previous = room.peers.length;
    room.peers = room.peers.filter(peer => peer.userId !== userId);
    const removed = previous - room.peers.length;
    if (!removed) return null; // no writes or phantom roster events on a no-op
    await socialRoomStore.save(serverId, room);
    return { room, removed };
  });
  if (!updated) return 0;
  io.to('social-3d:' + serverId).emit('social:peers', publicSocialRoom(updated.room));
  return updated.removed;
}


/**
 * Reconcile the independent server-scoped 3D Social Space after actual
 * server-role permissions or member-role assignments are committed.
 *
 * Unlike channel room eviction, social access uses server-wide VIEW_CHANNELS
 * and CONNECT. Every affected in-flight admission sees a changed Redis
 * generation; existing unauthorized sockets leave their delivery audience
 * BEFORE the Redis avatar roster is published to remaining subscribers.
 *
 * Do not silently treat Redis failure or distributed adapter failure as a
 * successful removal. Callers must invalidate the permission cache first.
 */
export async function reconcileSocialRoomAccess(
  io: Pick<SocketIOServer, 'to' | 'in'> | null | undefined,
  serverId: string,
  targetUserId?: string,
): Promise<number> {
  if (process.env.BRIDGE_SOCIAL_3D_MULTIPLAYER !== '1' || !io || !serverId) return 0;
  // A global role-permission edit affects every member, including joins which
  // haven't yet reserved an avatar. Per-member assignment affects only one.
  const fenceSubject = targetUserId || '__all__';
  await socialRoomStore.withLock(serverId, async () => {
    await socialRoomStore.markRevocationFence(serverId, fenceSubject);
  });
  const snapshot = await socialRoomStore.load(serverId);
  const candidates = [...new Set(snapshot.peers.map(peer => peer.userId))]
    .filter(id => !targetUserId || id === targetUserId);
  let removed = 0;
  for (const userId of candidates) {
    let permitted = false;
    try {
      const member = await Members.findOne(userId, serverId);
      if (member) {
        const resolved = await resolvePermissions(userId, serverId);
        permitted = hasPermission(resolved, PERMS.VIEW_CHANNELS)
          && hasPermission(resolved, PERMS.CONNECT);
      }
    } catch {
      permitted = false; // Fail closed on unreadable DB / permissions.
    }
    if (permitted) continue;

    const socketRoom = 'social-3d:' + serverId;
    const userSockets = await io.in('user:' + userId).fetchSockets();
    for (const socket of userSockets) {
      if (!socket.rooms.has(socketRoom)) continue;
      await socket.leave(socketRoom);
      socket.emit('social:left', { serverId });
    }
    removed += await evictSocialUserFromRoom(io, userId, serverId);
  }
  return removed;
}
