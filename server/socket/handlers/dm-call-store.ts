import { cache, isRedisAvailable } from '../../lib/redisAdapter';
import logger from '../../lib/logger';

export interface ActiveDmCall {
  callId: string;
  callerId: string;
  calleeId: string;
  type: 'voice' | 'video';
  startedAt: number;
  status: 'ringing' | 'active';
}

const KEY_PREFIX = 'dm:call:';
// Calls are normally deleted explicitly. A bounded TTL only prevents orphaned
// metadata from surviving a crashed node forever; it must not truncate normal
// multi-hour calls as the old five-minute process-local sweeper did.
const CALL_TTL_SECONDS = 24 * 60 * 60;
const REDIS_CONFIGURED = Boolean(process.env.REDIS_URL);
const localCalls = new Map<string, ActiveDmCall>();

function unavailable(op: string): Error {
  return new Error(`Redis DM-call coordination unavailable during ${op}`);
}

function decode(value: unknown, expectedCallId: string): ActiveDmCall {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid persisted DM call');
  const raw = value as Partial<ActiveDmCall>;
  if (raw.callId !== expectedCallId || typeof raw.callerId !== 'string' || !raw.callerId ||
      typeof raw.calleeId !== 'string' || !raw.calleeId || raw.callerId === raw.calleeId ||
      (raw.type !== 'voice' && raw.type !== 'video') ||
      typeof raw.startedAt !== 'number' || !Number.isSafeInteger(raw.startedAt) || raw.startedAt < 0 ||
      (raw.status !== 'ringing' && raw.status !== 'active')) {
    throw new TypeError('Invalid persisted DM call');
  }
  return raw as ActiveDmCall;
}

export const dmCallStore = {
  async get(callId: string): Promise<ActiveDmCall | null> {
    if (!callId || callId.length > 128) return null;
    if (isRedisAvailable()) {
      let raw: unknown;
      try {
        raw = await cache.getAuthoritative<ActiveDmCall>(`${KEY_PREFIX}${callId}`);
      } catch (err) {
        logger.warn({ err, callId, event: 'dm.call_store.get_failed' }, 'Redis DM call read failed');
        if (REDIS_CONFIGURED) throw err;
        const local = localCalls.get(callId);
        return local ? decode(local, callId) : null;
      }
      return raw === null ? null : decode(raw, callId);
    } else if (REDIS_CONFIGURED) {
      throw unavailable('get');
    }
    const local = localCalls.get(callId);
    return local ? decode(local, callId) : null;
  },

  async set(call: ActiveDmCall): Promise<void> {
    decode(call, call.callId);
    if (isRedisAvailable()) {
      try {
        await cache.setAuthoritative(`${KEY_PREFIX}${call.callId}`, call, CALL_TTL_SECONDS);
        return;
      } catch (err) {
        logger.warn({ err, callId: call.callId, event: 'dm.call_store.set_failed' }, 'Redis DM call write failed');
        if (REDIS_CONFIGURED) throw err;
      }
    } else if (REDIS_CONFIGURED) {
      throw unavailable('set');
    }
    localCalls.set(call.callId, { ...call });
  },

  async del(callId: string): Promise<void> {
    if (!callId || callId.length > 128) return;
    if (isRedisAvailable()) {
      try {
        await cache.delAuthoritative(`${KEY_PREFIX}${callId}`);
        return;
      } catch (err) {
        logger.warn({ err, callId, event: 'dm.call_store.delete_failed' }, 'Redis DM call delete failed');
        if (REDIS_CONFIGURED) throw err;
      }
    } else if (REDIS_CONFIGURED) {
      throw unavailable('delete');
    }
    localCalls.delete(callId);
  },

  async withLock<T>(callId: string, fn: () => Promise<T>): Promise<T> {
    if (!callId || callId.length > 128) throw new TypeError('Invalid DM call id');
    return cache.withKeyLock(`dm-call:${callId}`, fn, { leaseSeconds: 5, waitMs: 2_000, retryMs: 10 });
  },

  _localCalls_TEST_ONLY: localCalls,
};
