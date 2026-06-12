// server/lib/redisAdapter.ts
// Redis pub/sub adapter for Socket.io (multi-instance support)
// Falls back to in-memory if Redis is unavailable — single-instance mode still works.
//
// ⚠️  CLUSTER UYARISI: In-memory fallback yalnızca tek-node deploy için güvenlidir.
//    Çoklu node/pod ortamında Redis olmadan rate limit, socket broadcast ve
//    session cache tutarsız davranır. Production cluster'da REDIS_URL zorunludur.
//    Bkz: DEPLOYMENT_GUIDE.md §Redis
//
// v74 — Redis Singleton:
//   - Global singleton: aynı process içinde tek bir Redis bağlantısı
//   - İkinci kez import edildiğinde mevcut bağlantıyı döndürür
//   - Bağlantı koptuğunda otomatik reconnect (redis client retry stratejisi)
//   - applyAdapter() idempotent — defalarca çağrılabilir, yalnızca ilk kez bağlanır
//
// Önceki v63 özellikleri korundu:
//   - cache.mget / cache.mset, cache.remember, cache.increment / decrement
//   - cache.hset / hget / hgetAll, sessionCache, redisRateLimiter, healthCheck()

import { tryRequire } from './_optional-require';
import logger from './logger';

// ── Tip tanımları (opsiyonel bağımlılıklar için) ─────────────

/** redis paketinin createClient'ından dönen istemci arayüzü (minimal) */
interface RedisClient {
  connect(): Promise<void>;
  quit(): Promise<void>;
  duplicate(): RedisClient;
  ping(): Promise<string>;
  info(section?: string): Promise<string>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, handler: (message: string) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
  del(key: string | string[]): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  mGet(keys: string[]): Promise<(string | null)[]>;
  multi(): RedisPipeline;
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  hSet(key: string, field: string, value: string): Promise<number>;
  hGet(key: string, field: string): Promise<string | null>;
  hGetAll(key: string): Promise<Record<string, string>>;
  hDel(key: string, field: string): Promise<number>;
  /** Lua script çalıştırıcı — redis v4+ sendCommand wrapper */
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): this;
}

interface RedisPipeline {
  set(key: string, value: string, options?: { EX?: number }): this;
  exec(): Promise<unknown[]>;
}

type RedisModule = {
  createClient(opts: Record<string, unknown>): RedisClient;
};
type RedisAdapterModule = {
  createAdapter(pub: RedisClient, sub: RedisClient): unknown;
};

/** In-memory cache girişi */
interface MemCacheEntry<T = unknown> {
  value: T;
  expiresAt?: number;
}

const REDIS_URL = process.env.REDIS_URL || null;

// ── Singleton state ───────────────────────────────────────────
// Bu değişkenler modül cache'inde yaşar — process boyunca tek kez init edilir
let _pubClient:      RedisClient | null = null;  // Socket.io pub (ve genel cache client)
let _subClient:      RedisClient | null = null;  // Socket.io sub
let _isRedisAvailable = false;
let _connectPromise: Promise<boolean> | null = null;  // İlk bağlantı Promise'i — race condition önleyici

// ── Bağlantı başlatıcı — idempotent ──────────────────────────
async function _connect(): Promise<boolean> {
  // Zaten bağlıysa hemen dön
  if (_isRedisAvailable && _pubClient) return true;
  // Bağlantı devam ediyorsa aynı Promise'i bekle
  if (_connectPromise) return _connectPromise!;

  if (!REDIS_URL) {
    if (process.env.NODE_ENV === 'production') {
      logger.error(
        { event: 'redis.no_url.production' },
        '[Redis] REDIS_URL set edilmemiş — Production ortamında Redis olmadan yatay ölçekleme çalışmaz. .env dosyasına REDIS_URL=redis://... ekleyin.'
      );
    } else {
      logger.warn(
        { event: 'redis.no_url', clusterSafe: false },
        'REDIS_URL set edilmemiş — tek instance (in-memory) modunda çalışılıyor. ' +
        'Çoklu node/pod ortamında rate limit ve socket broadcast tutarsız davranır. ' +
        'Production için REDIS_URL ekleyin.'
      );
    }
    return false;
  }

  _connectPromise = (async () => {
    try {
      const redisModule = tryRequire<RedisModule>('redis');

      if (!redisModule) {
        logger.warn({ event: 'redis.package_missing' }, '[Redis] "redis" paketi yüklü değil — in-memory modunda devam ediliyor');
        _connectPromise = null;
        return false;
      }

      const { createClient } = redisModule;

      _pubClient = createClient({
        url: REDIS_URL,
        socket: {
          reconnectStrategy: (retries: number) => {
            if (retries > 10) return new Error('Redis: 10 bağlantı denemesi başarısız');
            return Math.min(retries * 200, 3000); // üstel geri çekilme, max 3s
          },
        },
      });
      _subClient = _pubClient.duplicate();

      _pubClient.on('error',        (e: unknown) => logger.error({ err: e instanceof Error ? e.message : String(e), event: 'redis.pub.error' }, '[Redis pub error]'));
      _subClient.on('error',        (e: unknown) => logger.error({ err: e instanceof Error ? e.message : String(e), event: 'redis.sub.error' }, '[Redis sub error]'));
      _pubClient.on('reconnecting', ()  => logger.warn({ event: 'redis.reconnecting' }, '[Redis] Yeniden bağlanıyor…'));
      _pubClient.on('ready',        ()  => {
        _isRedisAvailable = true;
        logger.info({ event: 'redis.ready' }, 'Redis bağlantısı hazır.');
      });
      _pubClient.on('end', () => {
        _isRedisAvailable = false;
        logger.warn({ event: 'redis.closed' }, '[Redis] Bağlantı kapandı');
      });

      await Promise.all([_pubClient.connect(), _subClient.connect()]);
      _isRedisAvailable = true;
      logger.info({ url: REDIS_URL.replace(/:[^@]+@/, ':***@'), event: 'redis.connected' }, 'Redis singleton bağlandı.');
      return true;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), event: 'redis.connect_failed' }, '[Redis] Bağlantı başarısız, in-memory moduna geçiliyor');
      _pubClient        = null;
      _subClient        = null;
      _isRedisAvailable = false;
      _connectPromise   = null; // Tekrar denenebilmesi için sıfırla
      return false;
    }
  })();

  return _connectPromise;
}

// ── Socket.io adapter — idempotent ───────────────────────────
// Birden fazla çağrıda yalnızca ilk kez adapter kurulur
let _adapterApplied = false;

async function applyAdapter(io: unknown): Promise<boolean> {
  if (_adapterApplied) {
    logger.debug({ event: 'redis.adapter_skip' }, 'Redis adapter zaten kurulu, atlanıyor.');
    return _isRedisAvailable;
  }

  const connected = await _connect();
  if (!connected) return false;

  try {
    const adapterMod = tryRequire<RedisAdapterModule>('@socket.io/redis-adapter');
    if (!adapterMod) {
      logger.warn({ event: 'redis.adapter_package_missing' }, '[Redis] "@socket.io/redis-adapter" paketi yüklü değil — adapter kurulamadı');
      return false;
    }
    if (_pubClient && _subClient && typeof (io as { adapter?: unknown }).adapter === 'function') {
      (io as { adapter(adapter: unknown): void }).adapter(adapterMod.createAdapter(_pubClient, _subClient));
    }
    _adapterApplied = true;
    logger.info({ event: 'redis.adapter_ready' }, 'Socket.io Redis adapter kuruldu.');
    return true;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), event: 'redis.adapter_failed' }, '[Redis] Adapter kurulamadı');
    return false;
  }
}

// ── In-memory fallback ────────────────────────────────────────
const memCache = new Map<string, MemCacheEntry>();

// ── Cache wrapper ─────────────────────────────────────────────
const cache = {
  _client(): RedisClient | null { return _pubClient; },
  async get<T = unknown>(key: string): Promise<T | null> {
    if (_isRedisAvailable && _pubClient) {
      const val = await _pubClient.get(`bridge:cache:${key}`);
      return val ? (JSON.parse(val) as T) : null;
    }
    const entry = memCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt < Date.now()) { memCache.delete(key); return null; }
    return entry.value as T;
  },

  async set<T = unknown>(key: string, value: T, ttlSeconds = 300): Promise<void> {
    if (_isRedisAvailable && _pubClient) {
      await _pubClient.set(`bridge:cache:${key}`, JSON.stringify(value), { EX: ttlSeconds });
      return;
    }
    memCache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  },

  async delete(key: string): Promise<void> {
    return this.del(key);
  },

  async del(key: string): Promise<void> {
    if (_isRedisAvailable && _pubClient) {
      await _pubClient.del(`bridge:cache:${key}`);
      return;
    }
    memCache.delete(key);
  },

  async invalidatePattern(prefix: string): Promise<void> {
    if (_isRedisAvailable && _pubClient) {
      const keys = await _pubClient.keys(`bridge:cache:${prefix}*`);
      if (keys.length) await _pubClient.del(keys);
      return;
    }
    for (const k of memCache.keys()) {
      if (k.startsWith(prefix)) memCache.delete(k);
    }
  },

  async mget<T = unknown>(keys: string[]): Promise<Map<string, T>> {
    if (!keys.length) return new Map<string, T>();
    if (_isRedisAvailable && _pubClient) {
      const prefixed = keys.map(k => `bridge:cache:${k}`);
      const vals     = await _pubClient.mGet(prefixed);
      const result   = new Map<string, T>();
      keys.forEach((k, i) => {
        if (vals[i] !== null) result.set(k, JSON.parse(vals[i]!) as T);
      });
      return result;
    }
    const result = new Map<string, T>();
    const now    = Date.now();
    for (const k of keys) {
      const entry = memCache.get(k);
      if (entry && (!entry.expiresAt || entry.expiresAt > now)) result.set(k, entry.value as T);
    }
    return result;
  },

  async mset<T = unknown>(entries: [string, T][], ttlSeconds = 300): Promise<void> {
    if (!entries.length) return;
    if (_isRedisAvailable && _pubClient) {
      const pipeline = _pubClient.multi();
      for (const [k, v] of entries) {
        pipeline.set(`bridge:cache:${k}`, JSON.stringify(v), { EX: ttlSeconds });
      }
      await pipeline.exec();
      return;
    }
    const expiresAt = Date.now() + ttlSeconds * 1000;
    for (const [k, v] of entries) memCache.set(k, { value: v, expiresAt });
  },

  async remember<T = unknown>(key: string, ttlSeconds: number, computeFn: () => Promise<T>): Promise<T | null> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    // Cache Stampede (Thundering Herd) Koruması:
    // Redis varsa SET NX ile distributed lock al.
    // Lock alınamazsa (başka bir instance hesaplıyor), kısa bekle + cache'e yeniden bak.
    if (_isRedisAvailable && _pubClient) {
      const lockKey = `bridge:lock:${key}`;
      const lockTtl = Math.min(ttlSeconds, 30); // lock süresi hesaplama süresini aşmasın

      try {
        // SET lockKey "1" NX EX lockTtl — atomik: yalnızca key yoksa set eder
        const acquired = await (_pubClient as unknown as {
          set(k: string, v: string, opts: { NX: boolean; EX: number }): Promise<string | null>;
        }).set(lockKey, '1', { NX: true, EX: lockTtl });

        if (!acquired) {
          // Başka bir worker hesaplıyor; 100ms bekle + cache'e bak
          await new Promise(r => setTimeout(r, 100));
          const refetched = await this.get<T>(key);
          if (refetched !== null) return refetched;
          // Hâlâ yok — lock alındıktan sonra da değer set edilmediyse düş, hesapla
        } else {
          // Lock alındı — hesapla ve serbest bırak
          try {
            const value = await computeFn();
            if (value !== null && value !== undefined) await this.set(key, value, ttlSeconds);
            return value ?? null;
          } finally {
            // Lock'u serbest bırak (fire-and-forget — TTL zaten backup)
            _pubClient!.del(lockKey).catch(() => {});
          }
        }
      } catch {
        // Lock mekanizması başarısız — normal yola dön
      }
    }

    // In-memory fallback veya lock timeout: doğrudan hesapla
    const value = await computeFn();
    if (value !== null && value !== undefined) await this.set(key, value, ttlSeconds);
    return value ?? null;
  },

  async increment(key: string, ttlSeconds = 60): Promise<number> {
    if (_isRedisAvailable && _pubClient) {
      const rKey = `bridge:cache:${key}`;
      const val  = await _pubClient.incr(rKey);
      if (val === 1) await _pubClient.expire(rKey, ttlSeconds);
      return val;
    }
    const entry = memCache.get(key);
    const now   = Date.now();
    if (!entry || (entry.expiresAt && entry.expiresAt < now)) {
      memCache.set(key, { value: 1, expiresAt: now + ttlSeconds * 1000 });
      return 1;
    }
    const next = Number(entry.value) + 1;
    entry.value = next;
    return next;
  },

  async decrement(key: string): Promise<number> {
    if (_isRedisAvailable && _pubClient) {
      return await _pubClient.decr(`bridge:cache:${key}`);
    }
    const entry = memCache.get(key);
    if (!entry) return 0;
    const next = Math.max(0, Number(entry.value) - 1);
    entry.value = next;
    return next;
  },

  async hset<T = unknown>(key: string, field: string, value: T): Promise<void> {
    if (_isRedisAvailable && _pubClient) {
      await _pubClient.hSet(`bridge:hash:${key}`, field, JSON.stringify(value));
      return;
    }
    let h = memCache.get(`hash:${key}`)?.value;
    if (!h || typeof h !== 'object' || Array.isArray(h)) { h = {}; memCache.set(`hash:${key}`, { value: h }); }
    (h as Record<string, T>)[field] = value;
  },

  async hget<T = unknown>(key: string, field: string): Promise<T | null> {
    if (_isRedisAvailable && _pubClient) {
      const val = await _pubClient.hGet(`bridge:hash:${key}`, field);
      return val ? (JSON.parse(val) as T) : null;
    }
    return (memCache.get(`hash:${key}`)?.value as Record<string, T> | undefined)?.[field] ?? null;
  },

  async hgetAll<T = unknown>(key: string): Promise<Record<string, T>> {
    if (_isRedisAvailable && _pubClient) {
      const result = await _pubClient.hGetAll(`bridge:hash:${key}`);
      if (!result) return {};
      return Object.fromEntries(
        Object.entries(result).map(([k, v]) => [k, JSON.parse(v) as T])
      ) as Record<string, T>;
    }
    return (memCache.get(`hash:${key}`)?.value as Record<string, T>) || {};
  },

  async hdel(key: string, field: string): Promise<void> {
    if (_isRedisAvailable && _pubClient) {
      await _pubClient.hDel(`bridge:hash:${key}`, field);
      return;
    }
    const h = memCache.get(`hash:${key}`)?.value;
    if (h && typeof h === 'object' && !Array.isArray(h)) delete (h as Record<string, unknown>)[field];
  },

  /**
   * Tip-güvenli Lua script çalıştırıcı.
   * Redis yoksa null döner; caller in-memory fallback uygular.
   *
   * @param script - Lua script metni
   * @param keys   - KEYS[] dizisi
   * @param args   - ARGV[] dizisi
   * @returns Redis'ten dönen değer veya null (Redis yoksa)
   */
  async luaEval(script: string, keys: string[], args: string[]): Promise<unknown> {
    if (!_isRedisAvailable || !_pubClient) return null;
    return _pubClient.eval(script, keys, args);
  },
};

// Jest unit tests import the real adapter in a few legacy suites. Keep the
// in-memory implementation, but expose Jest spy helpers when running under Jest
// so tests can assert calls and override one-off cache reads without replacing
// production behavior.
if (process.env.NODE_ENV === 'test' && typeof jest !== 'undefined' && typeof jest.fn === 'function') {
  const mutableCache = cache as unknown as Record<string, unknown>;
  for (const key of Object.keys(mutableCache)) {
    const fn = mutableCache[key];
    if (typeof fn === 'function' && !('mock' in fn)) {
      mutableCache[key] = jest.fn(fn.bind(cache));
    }
  }
}

// ── Notification pub/sub ──────────────────────────────────────
const notifChannel = 'bridge:notifications';

async function publishNotification(payload: Record<string, unknown>): Promise<void> {
  if (_isRedisAvailable && _pubClient) {
    await _pubClient.publish(notifChannel, JSON.stringify(payload));
  }
}

/**
 * Genel amaçlı Redis pub/sub aboneliği.
 * Cluster modunda worker'lar arası koordinasyon için kullanılır (örn. presenceCache).
 * Redis yoksa handler hiç çağrılmaz; fallback caller tarafından yönetilir.
 *
 * @returns unsub — aboneliği iptal eden fonksiyon
 */
async function subscribeToChannel(
  channel: string,
  handler: (message: string) => void
): Promise<(() => Promise<void>) | null> {
  if (!_isRedisAvailable || !_subClient) return null;
  await _subClient.subscribe(channel, handler);
  return async () => {
    try { await _subClient!.unsubscribe(channel); } catch { /* ignore */ }
  };
}

async function publishToChannel(channel: string, message: string): Promise<void> {
  if (_isRedisAvailable && _pubClient) {
    await _pubClient.publish(channel, message);
  }
}

// ── Session Cache ─────────────────────────────────────────────
const sessionCache = {
  async invalidateToken(jti: string, ttlSeconds: number): Promise<void> {
    await cache.set(`revoked:${jti}`, 1, ttlSeconds);
  },
  async isRevoked(jti: string): Promise<boolean> {
    const val = await cache.get(`revoked:${jti}`);
    return val !== null;
  },
};

// ── Redis-backed Sliding Window Rate Limiter ──────────────────

interface RateLimitReq {
  user?: { id?: string };
  ip?: string;
}
interface RateLimitRes {
  setHeader(name: string, value: string | number): void;
  status(code: number): { json(body: unknown): void };
}
type NextFn = () => void;

function redisRateLimiter({ windowMs = 60_000, max = 60, keyPrefix = 'rl' }: { windowMs?: number; max?: number; keyPrefix?: string } = {}): (req: RateLimitReq, res: RateLimitRes, next: NextFn) => Promise<void> {
  return async function rateLimitMiddleware(req, res, next) {
    const identifier = req.user?.id || req.ip || 'anon';
    const windowSec  = Math.floor(windowMs / 1000);
    const key        = `${keyPrefix}:${identifier}`;

    try {
      const count = await cache.increment(key, windowSec);
      res.setHeader('X-RateLimit-Limit',     max);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, max - count));

      if (count > max) {
        res.setHeader('Retry-After', windowSec);
        return res.status(429).json({ error: 'Too many requests', retryAfter: windowSec });
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), event: 'rate_limiter.redis.error' }, '[RateLimiter] Redis error, allowing request');
    }

    next();
  };
}

// ── Health Check ──────────────────────────────────────────────
interface HealthCheckResult {
  redis: boolean;
  mode?: string;
  singleton?: boolean;
  latencyMs?: number;
  usedMemory?: string;
  url?: string;
  memCacheSize?: number;
  error?: string;
  clusterWarning?: string;
}

async function healthCheck(): Promise<HealthCheckResult> {
  if (!_isRedisAvailable || !_pubClient) {
    return {
      redis: false,
      mode: 'in-memory',
      memCacheSize: memCache.size,
      clusterWarning: process.env.NODE_ENV === 'production'
        ? 'REDIS_URL eksik — Production cluster ortamında yatay ölçekleme çalışmaz'
        : undefined,
    };
  }
  try {
    const start = Date.now();
    await _pubClient.ping();
    const latencyMs = Date.now() - start;
    const info = await _pubClient.info('memory');
    const usedMemoryMatch = info.match(/used_memory_human:(.+)/);
    return {
      redis:      true,
      mode:       'redis',
      singleton:  true,
      latencyMs,
      usedMemory: usedMemoryMatch?.[1]?.trim() || 'unknown',
      url:        (REDIS_URL || '').replace(/:[^@]+@/, ':***@'),
    };
  } catch (err) {
    return { redis: false, error: err instanceof Error ? err instanceof Error ? err.message : String(err) : String(err) };
  }
}

// ── Graceful shutdown ─────────────────────────────────────────
// Sprint 108: sessiz catch'ler loglanır hale getirildi.
// Shutdown path'i yine de tamamlanır — hata bağlantıyı durdurmaz.
async function disconnect(): Promise<void> {
  if (_pubClient) {
    try { await _pubClient.quit(); }
    catch (err) {
      // SIGTERM sırasında zaten kopuk bağlantılarda hata beklenir;
      // yine de log bırak → gözlemlenebilirlik artırır, sessiz kalmaz.
      logger.warn(
        { err: (err as Error).message, event: 'redis.quit.pub_error' },
        'Redis pub client quit() başarısız — bağlantı zaten kapalı olabilir.',
      );
    }
    _pubClient = null;
  }
  if (_subClient) {
    try { await _subClient.quit(); }
    catch (err) {
      logger.warn(
        { err: (err as Error).message, event: 'redis.quit.sub_error' },
        'Redis sub client quit() başarısız — bağlantı zaten kapalı olabilir.',
      );
    }
    _subClient = null;
  }
  _isRedisAvailable = false;
  _connectPromise   = null;
  _adapterApplied   = false;
  logger.info({ event: 'redis.closed' }, 'Redis singleton bağlantısı kapatıldı.');
}

// Graceful shutdown hook. Testlerde/module reload'larda aynı listener'ı
// defalarca ekleyip MaxListenersExceededWarning üretmemek için global guard kullan.
const redisSignalHookKey = Symbol.for('bridge.redis.signalHookRegistered');
const redisSignalState = globalThis as typeof globalThis & { [redisSignalHookKey]?: boolean };
if (!redisSignalState[redisSignalHookKey]) {
  process.on('SIGTERM', disconnect);
  process.on('SIGINT',  disconnect);
  redisSignalState[redisSignalHookKey] = true;
}

export {
  applyAdapter,
  cache,
  sessionCache,
  redisRateLimiter,
  healthCheck,
  disconnect,
  publishNotification,
  subscribeToChannel,
  publishToChannel,
};

export function redisClient() {
  return _pubClient;
}

export function isRedisAvailable() {
  return _isRedisAvailable;
}
