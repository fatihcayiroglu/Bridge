/**
 * Optional server-authoritative Social Space presence protocol.
 * OFF by default: must not be enabled for product use without live eviction,
 * moderation, physical-device and scale acceptance evidence.
 *
 * This is independent of existing game activity:start and voice-channel rooms.
 */
import type { HandlerSocket, HandlerServer } from '../handler-contracts';
import { Members } from '../../db/repositories';
import { resolvePermissions, hasPermission, PERMS } from '../../lib/permissions';
import { isolateSocketHandler } from '../handlerIsolation';
import {
  socialRoomStore, moveSocialPeer, publicSocialRoom, SOCIAL_SPACE_MAX_PEERS,
  type SocialRoom,
} from './social-room-store';

function validServerId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 64
    && /^[a-zA-Z0-9_-]+$/.test(value);
}
function payloadServerId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const serverId = (value as Record<string, unknown>).serverId;
  return validServerId(serverId) ? serverId : null;
}
function socialSocketRoom(serverId: string): string {
  return 'social-3d:' + serverId;
}

async function isAuthorized(socket: HandlerSocket, userId: string, serverId: string): Promise<boolean> {
  // Membership in a server room is server-owned and established after auth.
  // It is necessary, but NEVER sufficient without the current database check.
  if (!userId || socket.isBot || !socket.rooms.has('server:' + serverId)) return false;
  const membership = await Members.findOne(userId, serverId).catch(() => null);
  if (!membership) return false;
  const permissions = await resolvePermissions(userId, serverId).catch(() => 0);
  return hasPermission(permissions, PERMS.VIEW_CHANNELS) && hasPermission(permissions, PERMS.CONNECT);
}

export function registerSocialRoomHandlers(
  socket: HandlerSocket, io: HandlerServer, userId: string,
): void {
  // Never trust a client-supplied user ID or socket ID.
  const joined = new Set<string>();
  let disconnected = false;
  const error = () => socket.emit('social:error', { code: 'SOCIAL_ROOM_UNAVAILABLE' });
  const publish = (serverId: string, room: SocialRoom) =>
    io.to(socialSocketRoom(serverId)).emit('social:peers', publicSocialRoom(room));

  async function leave(serverId: string): Promise<void> {
    if (!joined.has(serverId)) return;
    // Remove from this socket's delivery audience first. A late packet cannot
    // authorize a new delivery after leave, even if storage is unavailable.
    await socket.leave(socialSocketRoom(serverId));
    joined.delete(serverId);
    const remaining = await socialRoomStore.withLock(serverId, async () => {
      const room = await socialRoomStore.load(serverId);
      room.peers = room.peers.filter(p => p.socketId !== socket.id);
      await socialRoomStore.save(serverId, room);
      return room;
    });
    publish(serverId, remaining);
  }

  socket.on('social:join', isolateSocketHandler(socket, 'social:join', async (payload: unknown) => {
    const serverId = payloadServerId(payload);
    if (!serverId || disconnected || !await isAuthorized(socket, userId, serverId)) { error(); return; }

    const state = await socialRoomStore.withLock(serverId, async () => {
      const room = await socialRoomStore.load(serverId);
      const present = room.peers.some(p => p.socketId === socket.id);
      if (!present) {
        if (room.peers.length >= SOCIAL_SPACE_MAX_PEERS) return null;
        room.peers.push({ socketId: socket.id, userId, x: 0, z: 2.5, lastStepAt: 0 });
        await socialRoomStore.save(serverId, room);
      }
      return room;
    });
    if (!state) { socket.emit('social:error', { code: 'SOCIAL_ROOM_FULL' }); return; }
    if (disconnected) {
      // Disconnect between state save and socket-room join. A later disconnect
      // listener might already have run, so explicitly clean this reservation.
      await socialRoomStore.withLock(serverId, async () => {
        const room = await socialRoomStore.load(serverId);
        room.peers = room.peers.filter(p => p.socketId !== socket.id);
        await socialRoomStore.save(serverId, room);
      });
      return;
    }
    try {
      await socket.join(socialSocketRoom(serverId));
    } catch (err) {
      await socialRoomStore.withLock(serverId, async () => {
        const room = await socialRoomStore.load(serverId);
        room.peers = room.peers.filter(p => p.socketId !== socket.id);
        await socialRoomStore.save(serverId, room);
      });
      throw err;
    }
    joined.add(serverId);
    socket.emit('social:joined', publicSocialRoom(state));
    publish(serverId, state);
  }));

  socket.on('social:step', isolateSocketHandler(socket, 'social:step', async (payload: unknown) => {
    const serverId = payloadServerId(payload);
    const direction = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).direction : null;
    if (!serverId || !joined.has(serverId) ||
        !['forward', 'back', 'left', 'right'].includes(String(direction))) { error(); return; }
    if (!await isAuthorized(socket, userId, serverId)) {
      await leave(serverId);
      error();
      return;
    }
    const state = await socialRoomStore.withLock(serverId, async () => {
      const room = await socialRoomStore.load(serverId);
      const peer = room.peers.find(p => p.socketId === socket.id && p.userId === userId);
      if (!peer) return null;
      if (!moveSocialPeer(peer, direction as 'forward' | 'back' | 'left' | 'right', Date.now())) return null;
      await socialRoomStore.save(serverId, room);
      return room;
    });
    if (state) publish(serverId, state);
  }));

  socket.on('social:leave', isolateSocketHandler(socket, 'social:leave', async (payload: unknown) => {
    const serverId = payloadServerId(payload);
    if (!serverId || !joined.has(serverId)) { error(); return; }
    await leave(serverId);
    socket.emit('social:left', { serverId });
  }));

  socket.on('disconnect', isolateSocketHandler(socket, 'social:disconnect', async () => {
    disconnected = true;
    for (const serverId of [...joined]) await leave(serverId);
  }));
}
