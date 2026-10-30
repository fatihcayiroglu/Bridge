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
