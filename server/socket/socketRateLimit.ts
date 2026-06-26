// server/socket/socketRateLimit.ts
// Sprint 104: socket/index.ts monolitinden ayrıştırıldı.
// Sprint 105: Redis-backed store eklendi — çok-instance deploy'da kullanıcı bazlı
//             socket rate limiting artık tüm node'lar arasında senkronize çalışır.
//             IP rate limiting (ipRateLimit.ts) ile tutarlı pattern.

import logger from '../lib/logger';
import { cache as _rateCache } from '../lib/redisAdapter';

// ── KULLANICI BAZLI SOCKET RATE LIMITER ────────────────────────
// Redis varsa: tüm instance'lar aynı sayacı görür (cluster-safe)
// Redis yoksa: in-memory fallback (tek-instance için yeterli)
export const _socketRateStore = new Map<string, number[]>(); // in-memory fallback

export const SOCKET_RL: Record<string, { max: number; windowMs: number }> = {
  'message:send':  { max: 20,  windowMs: 10_000  },  // 20 mesaj / 10 sn
  'dm:send':       { max: 10,  windowMs: 10_000  },  // 10 DM / 10 sn
  'gdm:send':      { max: 10,  windowMs: 10_000  },
  'typing:start':  { max: 30,  windowMs: 5_000   },
  'voice:signal':  { max: 60,  windowMs: 10_000  },
  'channel:join':  { max: 20,  windowMs: 10_000  },
  '*':             { max: 200, windowMs: 60_000  },   // global fallback / kullanıcı / dk
};

// ── Redis store yardımcıları ──────────────────────────────────
const REDIS_KEY_PREFIX = 'socketrl:';
// Max TTL: en uzun pencere + buffer (120 sn)
const REDIS_TTL_SEC = 120;

async function _storeGet(key: string): Promise<number[]> {
  if (_rateCache) {
    try {
      const val = await _rateCache.get<string>(`${REDIS_KEY_PREFIX}${key}`);
      return val ? (JSON.parse(val) as number[]) : [];
    } catch { /* fallback */ }
  }
  return _socketRateStore.get(key) ?? [];
}

async function _storeSet(key: string, hits: number[]): Promise<void> {
  if (_rateCache) {
    try {
      await _rateCache.set(`${REDIS_KEY_PREFIX}${key}`, JSON.stringify(hits), REDIS_TTL_SEC);
      return;
    } catch { /* fallback */ }
  }
  _socketRateStore.set(key, hits);
}

// ── In-memory fallback temizleyici (Redis TTL'i otomatik yönetir) ──
setInterval(() => {
  if (_rateCache) return; // Redis aktifse in-memory store kullanılmaz
  const now = Date.now();
  for (const [k, hits] of _socketRateStore) {
    const fresh = hits.filter(t => now - t < 120_000);
    if (!fresh.length) _socketRateStore.delete(k); else _socketRateStore.set(k, fresh);
  }
}, 2 * 60_000).unref?.();

/**
 * socketRateCheck — event bazlı kullanıcı rate kontrolü.
 * Redis varsa cluster-safe; yoksa in-memory fallback.
 */
export async function socketRateCheck(userId: string, event: string): Promise<boolean> {
  const cfg = SOCKET_RL[event] ?? SOCKET_RL['*']!;
  const key = `${userId}:${event}`;
  const now = Date.now();
  const stored = await _storeGet(key);
  const hits = stored.filter(t => now - t < cfg.windowMs);
  hits.push(now);
  await _storeSet(key, hits);
  return hits.length <= cfg.max;
}

/** Global kullanıcı başına genel hız limiti */
export async function socketGlobalCheck(userId: string): Promise<boolean> {
  return socketRateCheck(userId, '*');
}

/**
 * createRateLimitedSocket — rate-limited proxy socket factory.
 * Her socket.on handler çalışmadan önce hem event hem global limit kontrol edilir.
 * Sprint 105: async socketRateCheck ile uyumlu — handler await ile beklenir.
 */
export function createRateLimitedSocket(
  socket: import('socket.io').Socket,
  userId: string,
): import('socket.io').Socket {
  return new Proxy(socket, {
    get(target, prop) {
      if (prop !== 'on') {
        return typeof (target as unknown as Record<string | symbol, unknown>)[prop] === 'function'
          ? (target as unknown as Record<string | symbol, (...a: unknown[]) => unknown>)[prop]!.bind(target)
          : (target as unknown as Record<string | symbol, unknown>)[prop];
      }
      return function(event: string, handler: (...args: unknown[]) => void) {
        target.on(event, async (...args: unknown[]) => {
          // Event bazlı limit
          if (SOCKET_RL[event] && !(await socketRateCheck(userId, event))) {
            logger.warn(`[RateLimit] Socket event throttled: ${event} user=${userId}`);
            target.emit('error:ratelimit', { event, message: 'Çok hızlı! Yavaşla.' });
            return;
          }
          // Global limit
          if (!(await socketGlobalCheck(userId))) {
            logger.warn(`[RateLimit] Socket global throttled: user=${userId}`);
            return;
          }
          return handler(...args);
        });
      };
    },
  }) as import('socket.io').Socket;
}
