/**
 * Independent 3D Social Space room state. Unlike game Activities this is keyed
 * by a verified server, not a voice channel or a game activity ID.
 *
 * Server-authoritative positions and per-socket identities; no client coords.
 * The multiplayer handler is feature-gated OFF in production pending review.
 */
import { cache, isRedisAvailable } from '../../lib/redisAdapter';
import { randomUUID } from 'node:crypto';

export const SOCIAL_SPACE_MAX_PEERS = 16;
export const SOCIAL_SPACE_BOUNDS = Object.freeze({ x: 5.6, z: 5.2 });
const TTL_SECONDS = 30 * 60;
const KEY = 'social-3d:server:';
// A short-lived generation marker survives deleting an empty room. All nodes
// must observe it; a stale join predating a kick must not resurrect presence.
const FENCE_KEY = 'social-3d:revocation-fence:';
const FENCE_TTL_SECONDS = 120;
const CONFIGURED_REDIS = Boolean(process.env.REDIS_URL);

export interface SocialPeer {
  readonly socketId: string;
  readonly userId: string;
  x: number;
  z: number;
  lastStepAt: number;
}
export interface SocialRoom {
  readonly serverId: string;
  peers: SocialPeer[];
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128
    && /^[a-zA-Z0-9_-]+$/.test(value);
}
function assertRoom(serverId: string, raw: unknown): SocialRoom {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('SOCIAL_ROOM_CORRUPT');
  const room = raw as Partial<SocialRoom>;
  if (room.serverId !== serverId || !Array.isArray(room.peers)
      || room.peers.length > SOCIAL_SPACE_MAX_PEERS
      || !room.peers.every(p => p && validId(p.socketId) && validId(p.userId)
        && Number.isFinite(p.x) && Number.isFinite(p.z)
        && Math.abs(p.x) <= SOCIAL_SPACE_BOUNDS.x && Math.abs(p.z) <= SOCIAL_SPACE_BOUNDS.z
        && Number.isSafeInteger(p.lastStepAt) && p.lastStepAt >= 0)) throw Error('SOCIAL_ROOM_CORRUPT');
  if (new Set(room.peers.map(p => p.socketId)).size !== room.peers.length) throw Error('SOCIAL_ROOM_CORRUPT');
  return { serverId, peers: room.peers.map(p => ({ socketId:p.socketId, userId:p.userId, x:p.x, z:p.z, lastStepAt:p.lastStepAt })) };
}
const localRooms = new Map<string, SocialRoom>();
const localFences = new Map<string, string>();
function requireId(id: string): void {
  if (!validId(id)) throw new TypeError('Invalid social room id');
}
function redisDown(): never { throw Error('SOCIAL_ROOM_REDIS_UNAVAILABLE'); }

export const socialRoomStore = {
  async readRevocationFence(serverId: string, userId: string): Promise<string | null> {
    requireId(serverId); requireId(userId);
    const key = FENCE_KEY + serverId + ':' + userId;
    if (isRedisAvailable()) {
      const fence = await cache.getAuthoritative<string>(key);
      if (fence !== null && (typeof fence !== 'string' || fence.length > 128)) {
        throw Error('SOCIAL_ROOM_FENCE_CORRUPT');
      }
      return fence;
    }
    if (CONFIGURED_REDIS) return redisDown();
    return localFences.get(key) ?? null;
  },
  async markRevocationFence(serverId: string, userId: string): Promise<void> {
    requireId(serverId); requireId(userId);
    const key = FENCE_KEY + serverId + ':' + userId;
    // Called inside the same server-room lock used for joining/pruning.
    const generation = randomUUID();
    if (isRedisAvailable()) {
      await cache.setAuthoritative(key, generation, FENCE_TTL_SECONDS);
      return;
    }
    if (CONFIGURED_REDIS) return redisDown();
    localFences.set(key, generation);
  },
  async load(serverId: string): Promise<SocialRoom> {
    requireId(serverId);
    if (isRedisAvailable()) {
      const raw = await cache.getAuthoritative<SocialRoom>(KEY + serverId);
      return raw === null ? { serverId, peers: [] } : assertRoom(serverId, raw);
    }
    if (CONFIGURED_REDIS) return redisDown();
    const local = localRooms.get(serverId);
    return local ? assertRoom(serverId, local) : { serverId, peers: [] };
  },
  async save(serverId: string, room: SocialRoom): Promise<void> {
    requireId(serverId);
    const verified = assertRoom(serverId, room);
    if (isRedisAvailable()) {
      if (verified.peers.length) await cache.setAuthoritative(KEY + serverId, verified, TTL_SECONDS);
      else await cache.delAuthoritative(KEY + serverId);
      return;
    }
    if (CONFIGURED_REDIS) return redisDown();
    if (verified.peers.length) localRooms.set(serverId, verified);
    else localRooms.delete(serverId);
  },
  async withLock<T>(serverId: string, action: () => Promise<T>): Promise<T> {
    requireId(serverId);
    return cache.withKeyLock('social-room-3d:' + serverId, action, {
      leaseSeconds: 5, waitMs: 2000, retryMs: 10,
    });
  },
  _localRooms_TEST_ONLY: localRooms,
  _localFences_TEST_ONLY: localFences,
};

export function publicSocialRoom(room: SocialRoom) {
  return {
    serverId: room.serverId,
    peers: room.peers.map(p => ({ socketId: p.socketId, userId: p.userId, x: p.x, z: p.z })),
  };
}

export function moveSocialPeer(
  peer: SocialPeer,
  direction: 'forward' | 'back' | 'left' | 'right',
  now: number,
): boolean {
  if (!Number.isSafeInteger(now) || now < 0) return false;
  // This is a bounded discrete-step preview. Continuous 3D games require a
  // separate simulation protocol and exact-head latency/abuse qualification.
  if (now - peer.lastStepAt < 300) return false;
  const delta = 0.35;
  const clamp = (value: number, bound: number) => Math.min(bound, Math.max(-bound, value));
  if (direction === 'forward') peer.z = clamp(peer.z - delta, SOCIAL_SPACE_BOUNDS.z);
  else if (direction === 'back') peer.z = clamp(peer.z + delta, SOCIAL_SPACE_BOUNDS.z);
  else if (direction === 'left') peer.x = clamp(peer.x - delta, SOCIAL_SPACE_BOUNDS.x);
  else if (direction === 'right') peer.x = clamp(peer.x + delta, SOCIAL_SPACE_BOUNDS.x);
  else return false;
  peer.lastStepAt = now;
  return true;
}
