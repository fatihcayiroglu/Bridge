import { cache, isRedisAvailable } from '../../lib/redisAdapter';
import logger from '../../lib/logger';

export interface ActivitySession {
  activityId: string;
  channelId: string;
  serverId: string;
  hostUserId: string;
  participants: Set<string>;
  /** Socket-level ownership prevents one browser tab from removing another
   * tab's user-level participant entry during leave/disconnect. */
  participantSockets?: Map<string, string>;
  startedAt: number;
  sessionId: string;
}

type StoredActivitySession = Omit<ActivitySession, 'participants' | 'participantSockets'> & {
  participants: string[];
  participantSockets?: Array<[string, string]>;
};
const KEY_PREFIX = 'activity:session:';
const TTL_SECONDS = 6 * 60 * 60;
const REDIS_CONFIGURED = Boolean(process.env.REDIS_URL);
const localSessions = new Map<string, ActivitySession>();

function unavailable(op: string): Error {
  return new Error(`Redis activity coordination unavailable during ${op}`);
}

function encode(session: ActivitySession): StoredActivitySession {
  const { participantSockets, ...rest } = session;
  return {
    ...rest,
    participants: [...session.participants],
    participantSockets: participantSockets ? [...participantSockets.entries()] : [],
  };
}

function decode(raw: unknown, channelId: string): ActivitySession {
  if (!raw || typeof raw !== 'object') throw new TypeError('Invalid persisted activity session');
  const value = raw as Partial<StoredActivitySession>;
  if (value.channelId !== channelId || typeof value.activityId !== 'string' || !value.activityId ||
      typeof value.serverId !== 'string' || !value.serverId || typeof value.hostUserId !== 'string' || !value.hostUserId ||
      typeof value.sessionId !== 'string' || !value.sessionId || !Array.isArray(value.participants) ||
      !value.participants.every(v => typeof v === 'string' && v.length > 0) ||
      (value.participantSockets !== undefined && (!Array.isArray(value.participantSockets) ||
        !value.participantSockets.every(entry => Array.isArray(entry) && entry.length === 2 &&
          typeof entry[0] === 'string' && entry[0].length > 0 &&
          typeof entry[1] === 'string' && entry[1].length > 0))) ||
      typeof value.startedAt !== 'number' || !Number.isSafeInteger(value.startedAt) || value.startedAt < 0) {
    throw new TypeError('Invalid persisted activity session');
  }
  return {
    activityId: value.activityId,
    channelId,
    serverId: value.serverId,
    hostUserId: value.hostUserId,
    participants: new Set(value.participants),
    participantSockets: new Map(value.participantSockets ?? []),
    startedAt: value.startedAt,
    sessionId: value.sessionId,
  };
}

export const activityStore = {
  async get(channelId: string): Promise<ActivitySession | null> {
    if (isRedisAvailable()) {
      let raw: unknown;
      try {
        raw = await cache.getAuthoritative<StoredActivitySession>(`${KEY_PREFIX}${channelId}`);
      } catch (err) {
        logger.warn({ err, channelId, event: 'activity.store.get_failed' }, 'Redis activity read failed');
        if (REDIS_CONFIGURED) throw err;
        return localSessions.get(channelId) ?? null;
      }
      return raw === null ? null : decode(raw, channelId);
    } else if (REDIS_CONFIGURED) throw unavailable('get');
    return localSessions.get(channelId) ?? null;
  },

  async set(channelId: string, session: ActivitySession): Promise<void> {
    if (session.channelId !== channelId) throw new TypeError('Activity session/channel mismatch');
    if (isRedisAvailable()) {
      try { await cache.setAuthoritative(`${KEY_PREFIX}${channelId}`, encode(session), TTL_SECONDS); return; }
      catch (err) {
        logger.warn({ err, channelId, event: 'activity.store.set_failed' }, 'Redis activity write failed');
        if (REDIS_CONFIGURED) throw err;
      }
    } else if (REDIS_CONFIGURED) throw unavailable('set');
    localSessions.set(channelId, session);
  },

  async del(channelId: string): Promise<void> {
    if (isRedisAvailable()) {
      try { await cache.delAuthoritative(`${KEY_PREFIX}${channelId}`); return; }
      catch (err) {
        logger.warn({ err, channelId, event: 'activity.store.delete_failed' }, 'Redis activity delete failed');
        if (REDIS_CONFIGURED) throw err;
      }
    } else if (REDIS_CONFIGURED) throw unavailable('delete');
    localSessions.delete(channelId);
  },

  async withLock<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
    if (!channelId || channelId.length > 256) throw new TypeError('Invalid activity channel id');
    return cache.withKeyLock(`activity-session:${channelId}`, fn, { leaseSeconds: 5, waitMs: 2_000, retryMs: 10 });
  },

  _localSessions_TEST_ONLY: localSessions,
};
