// server/lib/presenceCache.ts
// Cluster-safe presence and membership cache.
//
// Presence truth is a Redis sorted set of live socket ids when REDIS_URL is
// configured. Each worker refreshes only the sockets it owns; reads prune
// stale members before counting. This prevents one worker's disconnect from
// marking a user offline while another worker still owns a live socket, and
// it also self-heals after process crashes.

import { cache, subscribeToChannel, publishToChannel } from './redisAdapter';
import logger from './logger';

const MEMBERSHIP_TTL_S = 300;
const STATUS_THROTTLE_S = 10;
const ONLINE_TTL_S = 600; // single-node compatibility heartbeat
const PRESENCE_CHANNEL = 'bridge:presence';
const REDIS_CONFIGURED = Boolean(process.env.REDIS_URL);
const SOCKET_STALE_MS = 90_000;
const SOCKET_HEARTBEAT_MS = 30_000;

const _socketMap = new Map<string, Set<string>>();
const _hiddenUsers = new Set<string>();
const _manualOfflineUsers = new Set<string>();
const _socketMutationTails = new Map<string, Promise<void>>();

function sharedSocketKey(userId: string): string {
  return `presence:sockets:${userId}`;
}

// ── PRESENCE AFTER NODE DEATH (P1 multi-node, ND-07) ─────────────────────────
// A node that dies never releases its sockets. Their entries go stale after
// SOCKET_STALE_MS, but staleness was only noticed when the SAME user's next
// socket event ran a prune. Measured with three real nodes: a user whose node
// was SIGKILLed and whose replacement socket then closed stayed "online"
// forever (DB status and every observer), because nothing re-examined them.
// `presence:users` indexes every user with shared sockets by last heartbeat;
// the reaper below finds users whose sockets are ALL stale and performs the
// offline transition exactly once cluster-wide (atomic ZREM decides the owner).
const PRESENCE_INDEX_KEY = 'presence:users';
const REAP_BATCH = 500;

function visibilityKey(userId: string): string {
  return `presence:visibility:${userId}`;
}

function visibilityLockKey(userId: string): string {
  return `presence-visibility:${userId}`;
}

function parseVisibilityAuthority(value: unknown): boolean | null {
  if (value === 'visible') return true;
  if (value === 'hidden') return false;
  return null;
}

async function recoverVisibilityAuthority(userId: string): Promise<boolean> {
  return cache.withKeyLock(visibilityLockKey(userId), async () => {
    // A concurrent profile update may have restored the key while we waited.
    const rechecked = parseVisibilityAuthority(
      await cache.getAuthoritative<string>(visibilityKey(userId)),
    );
    if (rechecked !== null) return rechecked;

    try {
      const [{ Users }, { normalizePresenceVisibility }] = await Promise.all([
        import('../db/repositories'),
        import('./userUtils'),
      ]);
      const user = await Users.findById(userId);
      const visible = Boolean(user) && normalizePresenceVisibility(user?.presenceVisibility) === 'visible';
      await cache.setAuthoritative(visibilityKey(userId), visible ? 'visible' : 'hidden', 0);
      return visible;
    } catch (err) {
      logger.warn({ err, userId, event: 'presence.visibility_recovery.failed' },
        'Presence visibility authority recovery failed; treating user as hidden.');
      return false;
    }
  }, { leaseSeconds: 5, waitMs: 2_000, retryMs: 10 });
}

async function withSocketMutation<T>(userId: string, socketId: string, fn: () => Promise<T>): Promise<T> {
  const key = `${userId}:${socketId}`;
  const previous = _socketMutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => gate);
  _socketMutationTails.set(key, tail);
  await previous.catch(() => undefined);
  try { return await fn(); }
  finally {
    release();
    if (_socketMutationTails.get(key) === tail) _socketMutationTails.delete(key);
  }
}

function parseRedisCount(value: unknown, label: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid ${label} count`);
  return count;
}

async function touchSharedSocket(userId: string, socketId: string, now = Date.now()): Promise<number> {
  const raw = await cache.luaEvalAuthoritative(
    `local key = KEYS[1]
local now = tonumber(ARGV[1])
local stale = tonumber(ARGV[2])
redis.call('ZADD', key, now, ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - stale)
local count = redis.call('ZCARD', key)
redis.call('PEXPIRE', key, stale + tonumber(ARGV[4]))
redis.call('ZADD', KEYS[2], now, ARGV[5])
return count`,
    [sharedSocketKey(userId), PRESENCE_INDEX_KEY],
    [String(now), String(SOCKET_STALE_MS), socketId, String(SOCKET_HEARTBEAT_MS), userId],
  );
  if (raw === null) throw new Error('Redis presence coordination unavailable');
  return parseRedisCount(raw, 'presence socket');
}

async function releaseSharedSocket(userId: string, socketId: string, now = Date.now()): Promise<number> {
  const raw = await cache.luaEvalAuthoritative(
    `local key = KEYS[1]
local now = tonumber(ARGV[1])
local stale = tonumber(ARGV[2])
redis.call('ZREM', key, ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - stale)
local count = redis.call('ZCARD', key)
if count == 0 then
  redis.call('DEL', key)
  redis.call('ZREM', KEYS[2], ARGV[5])
else
  redis.call('PEXPIRE', key, stale + tonumber(ARGV[4]))
end
return count`,
    [sharedSocketKey(userId), PRESENCE_INDEX_KEY],
    [String(now), String(SOCKET_STALE_MS), socketId, String(SOCKET_HEARTBEAT_MS), userId],
  );
  if (raw === null) throw new Error('Redis presence coordination unavailable');
  return parseRedisCount(raw, 'presence socket');
}

async function sharedSocketCount(userId: string, now = Date.now()): Promise<number> {
  const raw = await cache.luaEvalAuthoritative(
    `local key = KEYS[1]
local now = tonumber(ARGV[1])
local stale = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - stale)
local count = redis.call('ZCARD', key)
if count == 0 then redis.call('DEL', key) end
return count`,
    [sharedSocketKey(userId)],
    [String(now), String(SOCKET_STALE_MS)],
  );
  if (raw === null) throw new Error('Redis presence coordination unavailable');
  return parseRedisCount(raw, 'presence socket');
}

/**
 * One reaper pass: users whose every shared socket is stale. Returns the users
 * for which THIS caller won the offline transition (at most one caller per
 * user, whatever the number of nodes running the reaper).
 */
async function reapStalePresence(now = Date.now()): Promise<string[]> {
  const candidates = await cache.luaEvalAuthoritative(
    `return redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]), 'LIMIT', 0, tonumber(ARGV[2]))`,
    [PRESENCE_INDEX_KEY],
    [String(now - SOCKET_STALE_MS), String(REAP_BATCH)],
  );
  if (!Array.isArray(candidates)) return [];
  const expired: string[] = [];
  for (const candidate of candidates) {
    const userId = String(candidate);
    if (!userId) continue;
    const won = await cache.luaEvalAuthoritative(
      `local key = KEYS[1]
local now = tonumber(ARGV[1])
local stale = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - stale)
if redis.call('ZCARD', key) > 0 then
  local newest = redis.call('ZRANGE', key, -1, -1, 'WITHSCORES')
  redis.call('ZADD', KEYS[2], newest[2], ARGV[3])
  return 0
end
redis.call('DEL', key)
return redis.call('ZREM', KEYS[2], ARGV[3])`,
      [sharedSocketKey(userId), PRESENCE_INDEX_KEY],
      [String(now), String(SOCKET_STALE_MS), userId],
    );
    if (Number(won) === 1) expired.push(userId);
  }
  return expired;
}

type PresenceExpiredHandler = (userId: string) => Promise<void>;
let _reaper: ReturnType<typeof setInterval> | null = null;

/** Start the cluster presence reaper (idempotent). The handler performs the user-visible offline transition. */
function startPresenceReaper(onExpired: PresenceExpiredHandler, intervalMs = SOCKET_HEARTBEAT_MS): void {
  if (!REDIS_CONFIGURED || _reaper) return;
  let running = false;
  _reaper = setInterval(() => {
    if (running) return;
    running = true;
    void (async () => {
      const expired = await reapStalePresence();
      for (const userId of expired) {
        if (_socketMap.get(userId)?.size) continue; // a live local socket re-touches it
        // A reconnect elsewhere between the reap and now must win.
        if ((await sharedSocketCount(userId).catch(() => 1)) > 0) continue;
        await markOffline(userId).catch(() => undefined);
        void Promise.resolve(publishToChannel(PRESENCE_CHANNEL, JSON.stringify({ event: 'presence:left', userId }))).catch(() => {});
        await onExpired(userId).catch((err: unknown) => {
          logger.warn({ err, userId, event: 'presence.reap.transition_failed' }, 'Stale presence offline transition failed');
        });
        logger.info({ userId, event: 'presence.reaped' }, 'User with only stale sockets (dead node) marked offline');
      }
    })().catch((err: unknown) => {
      logger.warn({ err, event: 'presence.reap.redis_failed' }, 'Presence reaper pass failed');
    }).finally(() => { running = false; });
  }, intervalMs);
  _reaper.unref?.();
}

function stopPresenceReaper(): void {
  if (_reaper) clearInterval(_reaper);
  _reaper = null;
}

// Best-effort pub/sub is notification-only. Redis socket ownership above is
// the source of truth, so losing a pub/sub message cannot corrupt presence.
let _unsubscribe: (() => Promise<void>) | null = null;
(async () => {
  try {
    _unsubscribe = await subscribeToChannel(PRESENCE_CHANNEL, (raw) => {
      try {
        const msg = JSON.parse(raw) as { event: string; userId: string; visible?: boolean };
        if (msg.event === 'presence:visibility' && typeof msg.userId === 'string' && typeof msg.visible === 'boolean') {
          if (msg.visible) _hiddenUsers.delete(msg.userId);
          else _hiddenUsers.add(msg.userId);
        }
        logger.debug({ msg, event: 'presenceCache.pubsub.received' }, 'Presence pub/sub message received');
      } catch { /* malformed notification */ }
    });
  } catch (err) {
    logger.warn({ err, event: 'presenceCache.pubsub.subscribe_failed' }, 'Presence pub/sub subscription failed');
  }
})();

async function trackSocket(userId: string, socketId: string, visible = true): Promise<number> {
  await setPresenceVisibility(userId, visible);
  if (!_socketMap.has(userId)) _socketMap.set(userId, new Set());
  _socketMap.get(userId)!.add(socketId);
  const localCount = _socketMap.get(userId)!.size;

  if (REDIS_CONFIGURED) {
    if (!visible) return localCount;
    try {
      const globalCount = await withSocketMutation(userId, socketId, () => touchSharedSocket(userId, socketId));
      if (globalCount === 1) {
        // The live-socket ZSET is cluster truth. Legacy online-heartbeat
        // maintenance must not roll back a socket whose authoritative claim
        // already succeeded (that would leave an untracked Redis ghost).
        await markOnline(userId).catch((err) => {
          logger.warn({ err, userId, event: 'presence.legacy_online_write_failed' }, 'Legacy online heartbeat update failed');
        });
        void Promise.resolve(publishToChannel(PRESENCE_CHANNEL, JSON.stringify({ event: 'presence:joined', userId }))).catch(() => {});
      }
      return globalCount;
    } catch (err) {
      const local = _socketMap.get(userId);
      local?.delete(socketId);
      if (local?.size === 0) _socketMap.delete(userId);
      logger.warn({ err, userId, event: 'presence.socket_track.redis_failed' }, 'Shared presence socket registration failed');
      throw err;
    }
  }

  if (localCount === 1) {
    if (visible) {
      await markOnline(userId);
      void Promise.resolve(publishToChannel(PRESENCE_CHANNEL, JSON.stringify({ event: 'presence:joined', userId }))).catch(() => {});
    } else {
      await markOffline(userId);
    }
  }
  return localCount;
}

async function releaseSocket(userId: string, socketId: string): Promise<number> {
  const sockets = _socketMap.get(userId);
  if (sockets) {
    sockets.delete(socketId);
    if (sockets.size === 0) _socketMap.delete(userId);
  }
  const localRemaining = sockets?.size ?? 0;

  if (REDIS_CONFIGURED) {
    let globalRemaining: number;
    try {
      globalRemaining = await withSocketMutation(userId, socketId, () => releaseSharedSocket(userId, socketId));
    } catch (err) {
      // Never report zero from a process-local view when Redis authority is
      // unavailable: callers would persist/broadcast a false global offline.
      logger.warn({ err, userId, event: 'presence.socket_release.redis_failed' }, 'Shared presence socket release failed');
      return Math.max(1, localRemaining);
    }
    if (globalRemaining === 0) {
      // The authoritative ZSET has already reached zero. A failure deleting
      // the compatibility heartbeat must not suppress the canonical offline
      // transition or make callers believe a socket is still alive.
      await markOffline(userId).catch((err) => {
        logger.warn({ err, userId, event: 'presence.legacy_offline_write_failed' }, 'Legacy online heartbeat cleanup failed');
      });
      void Promise.resolve(publishToChannel(PRESENCE_CHANNEL, JSON.stringify({ event: 'presence:left', userId }))).catch(() => {});
    }
    return globalRemaining;
  }

  if (localRemaining === 0) {
    await markOffline(userId);
    void Promise.resolve(publishToChannel(PRESENCE_CHANNEL, JSON.stringify({ event: 'presence:left', userId }))).catch(() => {});
  }
  return localRemaining;
}

function socketCount(userId: string): number {
  return _socketMap.get(userId)?.size ?? 0;
}

async function getMembershipsCached(
  userId: string,
  fetchFn: () => Promise<Array<{ serverId: string }>>,
): Promise<Array<{ serverId: string }>> {
  const key = `presence:memberships:${userId}`;
  try {
    const cached = await cache.get<Array<{ serverId: string }>>(key);
    if (cached) return cached;
  } catch { /* cache miss/error -> DB */ }

  const memberships = await fetchFn();
  try { await cache.set(key, memberships, MEMBERSHIP_TTL_S); } catch { /* cache only */ }
  return memberships;
}

async function invalidateMemberships(userId: string): Promise<void> {
  try { await cache.del(`presence:memberships:${userId}`); } catch { /* cache only */ }
}

async function throttleStatusWrite(userId: string, newStatus: string): Promise<boolean> {
  const key = `presence:status_throttle:${userId}`;
  try {
    const last = await cache.get<string>(key);
    if (last === newStatus) return false;
    await cache.set(key, newStatus, STATUS_THROTTLE_S);
  } catch { /* safe side: write DB */ }
  return true;
}

async function markOnline(userId: string): Promise<void> {
  _manualOfflineUsers.delete(userId);
  try {
    if (REDIS_CONFIGURED) await cache.delAuthoritative(`presence:manual_offline:${userId}`);
    else await cache.del(`presence:manual_offline:${userId}`);
    // Keep the legacy heartbeat for single-node/backward-compatible readers.
    if (REDIS_CONFIGURED) await cache.setAuthoritative(`presence:online:${userId}`, 1, ONLINE_TTL_S);
    else await cache.set(`presence:online:${userId}`, 1, ONLINE_TTL_S);
  } catch (err) {
    if (REDIS_CONFIGURED) throw err;
  }
}

async function markOffline(userId: string): Promise<void> {
  _manualOfflineUsers.add(userId);
  try {
    // Cluster truth is the live-socket ZSET; a separate offline marker races a
    // concurrent connect on another node and can mask a real live socket.
    if (REDIS_CONFIGURED) await cache.delAuthoritative(`presence:online:${userId}`);
    else await cache.del(`presence:online:${userId}`);
  } catch (err) {
    if (REDIS_CONFIGURED) throw err;
  }
}

async function setPresenceVisibility(userId: string, visible: boolean): Promise<void> {
  try {
    if (REDIS_CONFIGURED) {
      // Visibility is explicit authoritative state. Absence must never mean
      // "visible": after a Redis flush/recovery that interpretation could
      // expose a user whose durable DB preference is hidden before the owning
      // socket has had a chance to repopulate coordination state.
      await cache.withKeyLock(visibilityLockKey(userId), async () => {
        await cache.setAuthoritative(visibilityKey(userId), visible ? 'visible' : 'hidden', 0);
      }, { leaseSeconds: 5, waitMs: 2_000, retryMs: 10 });
    } else if (visible) {
      await cache.del(`presence:hidden:${userId}`);
    } else {
      await cache.set(`presence:hidden:${userId}`, 1, 0);
    }

    // Local fast-path state changes only AFTER authoritative Redis accepted
    // the transition. A failed "show me" request must not make this worker
    // more permissive than cluster truth; a failed "hide me" request is
    // handled by the route before durable DB persistence.
    if (visible) _hiddenUsers.delete(userId);
    else _hiddenUsers.add(userId);
    void Promise.resolve(publishToChannel(PRESENCE_CHANNEL, JSON.stringify({ event: 'presence:visibility', userId, visible }))).catch(() => {});
  } catch (err) {
    if (REDIS_CONFIGURED) throw err;
  }
}

async function isPresenceVisible(userId: string): Promise<boolean> {
  try {
    if (REDIS_CONFIGURED) {
      // Redis is authoritative in clustered mode; a process-local hint must
      // never permanently override a newer preference written on another node.
      const visibility = parseVisibilityAuthority(
        await cache.getAuthoritative<string>(visibilityKey(userId)),
      );
      if (visibility !== null) return visibility;
      // Redis restart/flush recovery: reconstruct explicit authority from the
      // durable DB preference under the same lock used by profile updates.
      return recoverVisibilityAuthority(userId);
    }
    if (_hiddenUsers.has(userId)) return false;
    const hidden = await cache.get(`presence:hidden:${userId}`);
    return hidden === null;
  } catch {
    return false;
  }
}

async function isUserOnline(userId: string): Promise<boolean> {
  if (!(await isPresenceVisible(userId))) return false;

  if (REDIS_CONFIGURED) {
    try { return (await sharedSocketCount(userId)) > 0; }
    catch { return false; }
  }

  if (_manualOfflineUsers.has(userId)) return false;

  if (socketCount(userId) > 0) return true;
  try {
    const val = await cache.get(`presence:online:${userId}`);
    return val !== null;
  } catch {
    return false;
  }
}

function activeSockets(): number {
  let total = 0;
  for (const set of _socketMap.values()) total += set.size;
  return total;
}

function onlineUserCount(): number {
  return _socketMap.size;
}

if (REDIS_CONFIGURED) {
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const [userId, sockets] of _socketMap) {
      if (_manualOfflineUsers.has(userId)) continue;
      // Pub/sub above is only a latency optimization. Re-read explicit Redis
      // visibility before refreshing ownership so a dropped visibility event
      // self-heals and a hidden user is never inferred visible from local state.
      void isPresenceVisible(userId).then(async (visible) => {
        if (!visible) return;
        for (const socketId of sockets) {
          await withSocketMutation(userId, socketId, async () => {
            if (!_socketMap.get(userId)?.has(socketId)) return;
            await touchSharedSocket(userId, socketId, now);
          });
        }
      }).catch((err) => {
        logger.warn({ err, userId, event: 'presence.heartbeat.redis_failed' }, 'Shared presence heartbeat failed');
      });
    }
  }, SOCKET_HEARTBEAT_MS);
  heartbeat.unref?.();
}

export {
  reapStalePresence,
  startPresenceReaper,
  stopPresenceReaper,
  trackSocket,
  releaseSocket,
  socketCount,
  getMembershipsCached,
  invalidateMemberships,
  throttleStatusWrite,
  markOnline,
  markOffline,
  setPresenceVisibility,
  isPresenceVisible,
  isUserOnline,
  activeSockets,
  onlineUserCount,
};
