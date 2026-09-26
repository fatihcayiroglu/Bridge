// Authoritative Draw Together session store.
// Redis is mandatory for coordination when REDIS_URL is configured; otherwise
// a process-local Map is used only for explicit single-node/dev/test mode.
import { cache, isRedisAvailable } from '../../../lib/redisAdapter';
import logger from '../../../lib/logger';
import type { DrawSession, DrawStroke } from './draw-together';

const KEY_PREFIX = 'draw:session:';
const SESSION_TTL_SECONDS = 6 * 60 * 60;
const REDIS_CONFIGURED = Boolean(process.env.REDIS_URL);

export const drawSessions = new Map<string, DrawSession>();

type StoredParticipant = { socketId: string; userId: string; displayName: string; color: string };
type StoredActiveStroke = { socketId: string; stroke: DrawStroke };
type StoredSession = Omit<DrawSession, 'activeStrokes' | 'participants'> & {
  activeStrokes: StoredActiveStroke[];
  participants: StoredParticipant[];
};

function unavailable(op: string): Error {
  return new Error(`Redis draw-session coordination unavailable during ${op}`);
}

function encode(session: DrawSession): StoredSession {
  return {
    sessionId: session.sessionId,
    channelId: session.channelId,
    strokes: session.strokes,
    activeStrokes: [...session.activeStrokes.entries()].map(([socketId, stroke]) => ({ socketId, stroke })),
    participants: [...session.participants.entries()].map(([socketId, p]) => ({ socketId, ...p })),
    createdAt: session.createdAt,
    hostSocketId: session.hostSocketId,
  };
}

function decode(value: unknown, expectedChannelId: string): DrawSession {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid persisted draw session');
  const raw = value as Partial<StoredSession>;
  if (typeof raw.sessionId !== 'string' || !raw.sessionId || raw.channelId !== expectedChannelId ||
      !Array.isArray(raw.strokes) || !Array.isArray(raw.activeStrokes) || !Array.isArray(raw.participants) ||
      typeof raw.createdAt !== 'number' || !Number.isSafeInteger(raw.createdAt) || raw.createdAt < 0 ||
      typeof raw.hostSocketId !== 'string') {
    throw new TypeError('Invalid persisted draw session');
  }
  const participants = new Map<string, { userId: string; displayName: string; color: string }>();
  for (const item of raw.participants) {
    if (!item || typeof item.socketId !== 'string' || typeof item.userId !== 'string' ||
        typeof item.displayName !== 'string' || typeof item.color !== 'string') {
      throw new TypeError('Invalid persisted draw participant');
    }
    participants.set(item.socketId, { userId: item.userId, displayName: item.displayName, color: item.color });
  }
  const activeStrokes = new Map<string, DrawStroke>();
  for (const item of raw.activeStrokes) {
    if (!item || typeof item.socketId !== 'string' || !item.stroke || typeof item.stroke !== 'object') {
      throw new TypeError('Invalid persisted draw active stroke');
    }
    activeStrokes.set(item.socketId, item.stroke);
  }
  return {
    sessionId: raw.sessionId,
    channelId: expectedChannelId,
    strokes: raw.strokes as DrawStroke[],
    activeStrokes,
    participants,
    createdAt: raw.createdAt,
    hostSocketId: raw.hostSocketId,
  };
}

export const drawStore = {
  async get(channelId: string): Promise<DrawSession | null> {
    if (isRedisAvailable()) {
      let raw: unknown;
      try {
        raw = await cache.getAuthoritative<StoredSession>(`${KEY_PREFIX}${channelId}`);
      } catch (err) {
        logger.warn({ err, channelId, event: 'draw.store.get_failed' }, '[draw-together] Redis read failed');
        if (REDIS_CONFIGURED) throw err;
        return drawSessions.get(channelId) ?? null;
      }
      // Corrupt shared state is an authority/integrity failure, not a cache
      // miss. Never reset it to an empty local canvas.
      return raw === null ? null : decode(raw, channelId);
    } else if (REDIS_CONFIGURED) {
      throw unavailable('get');
    }
    return drawSessions.get(channelId) ?? null;
  },

  async set(channelId: string, session: DrawSession): Promise<void> {
    if (session.channelId !== channelId) throw new TypeError('Draw session/channel mismatch');
    if (isRedisAvailable()) {
      try {
        await cache.setAuthoritative(`${KEY_PREFIX}${channelId}`, encode(session), SESSION_TTL_SECONDS);
        return;
      } catch (err) {
        logger.warn({ err, channelId, event: 'draw.store.set_failed' }, '[draw-together] Redis write failed');
        if (REDIS_CONFIGURED) throw err;
      }
    } else if (REDIS_CONFIGURED) {
      throw unavailable('set');
    }
    drawSessions.set(channelId, session);
  },

  async del(channelId: string): Promise<void> {
    if (isRedisAvailable()) {
      try {
        await cache.delAuthoritative(`${KEY_PREFIX}${channelId}`);
        return;
      } catch (err) {
        logger.warn({ err, channelId, event: 'draw.store.delete_failed' }, '[draw-together] Redis delete failed');
        if (REDIS_CONFIGURED) throw err;
      }
    } else if (REDIS_CONFIGURED) {
      throw unavailable('delete');
    }
    drawSessions.delete(channelId);
  },

  async withLock<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
    if (!channelId || channelId.length > 256) throw new TypeError('Invalid draw channel id');
    return cache.withKeyLock(`draw-session:${channelId}`, fn, { leaseSeconds: 5, waitMs: 2_000, retryMs: 10 });
  },
};
