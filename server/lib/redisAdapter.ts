// @ts-nocheck
// server/lib/redisAdapter.js
// Redis pub/sub adapter for Socket.io (multi-instance support)
// Falls back to in-memory if Redis is unavailable — single-instance mode still works.
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

'use strict';

const REDIS_URL = process.env.REDIS_URL || null;

// ── Singleton state ───────────────────────────────────────────
// Bu değişkenler modül cache'inde yaşar — process boyunca tek kez init edilir
let _pubClient        = null;   // Socket.io pub (ve genel cache client)
let _subClient        = null;   // Socket.io sub
let _isRedisAvailable = false;
let _connectPromise   = null;   // İlk bağlantı Promise'i — race condition önleyici

// ── Bağlantı başlatıcı — idempotent ──────────────────────────
async function _connect() {
  // Zaten bağlıysa hemen dön
  if (_isRedisAvailable && _pubClient) return true;
  // Bağlantı devam ediyorsa aynı Promise'i bekle
  if (_connectPromise) return _connectPromise;

  if (!REDIS_URL) {
    if (process.env.NODE_ENV === 'production') {
      console.error(
        '[Redis] UYARI: REDIS_URL set edilmemiş!\n' +
        '              Production ortamında Redis olmadan yatay ölçekleme çalışmaz.\n' +
        '              Socket.IO olayları farklı instance\'lar arasında paylaşılamaz.\n' +
        '              .env dosyasına REDIS_URL=redis://... ekleyin.\n' +
        '              Tek instance in-memory modunda devam ediliyor.'
      );
    } else {
      console.log('[Redis] REDIS_URL set edilmemiş — tek instance (in-memory) modunda çalışılıyor');
    }
    return false;
  }

  _connectPromise = (async () => {
    try {
      const { createClient }  = require('redis');
      const { createAdapter } = require('@socket.io/redis-adapter');

      _pubClient = createClient({
        url: REDIS_URL,
        socket: {
          reconnectStrategy: (retries) => {
            if (retries > 10) return new Error('Redis: 10 bağlantı denemesi başarısız');
            return Math.min(retries * 200, 3000); // üstel geri çekilme, max 3s
          },
        },
      });
      _subClient = _pubClient.duplicate();

      _pubClient.on('error',        (e) => console.error('[Redis pub error]', e.message));
      _subClient.on('error',        (e) => console.error('[Redis sub error]', e.message));
      _pubClient.on('reconnecting', ()  => console.warn('[Redis] Yeniden bağlanıyor…'));
      _pubClient.on('ready',        ()  => {
        _isRedisAvailable = true;
        console.log('[Redis] ✓ Bağlantı hazır');
      });
      _pubClient.on('end', () => {
        _isRedisAvailable = false;
        console.warn('[Redis] Bağlantı kapandı');
      });

      await Promise.all([_pubClient.connect(), _subClient.connect()]);
      _isRedisAvailable = true;
      console.log('[Redis] ✓ Singleton bağlandı —', REDIS_URL.replace(/:[^@]+@/, ':***@'));
      return true;
    } catch (err) {
      console.warn('[Redis] Bağlantı başarısız, in-memory moduna geçiliyor:', err.message);
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

async function applyAdapter(io) {
  if (_adapterApplied) {
    console.log('[Redis] Adapter zaten kurulu, atlanıyor');
    return _isRedisAvailable;
  }

  const connected = await _connect();
  if (!connected) return false;

  try {
    const { createAdapter } = require('@socket.io/redis-adapter');
    io.adapter(createAdapter(_pubClient, _subClient));
    _adapterApplied = true;
    console.log('[Redis] ✓ Socket.io adapter kuruldu');
    return true;
  } catch (err) {
    console.warn('[Redis] Adapter kurulamadı:', err.message);
    return false;
  }
}

// ── In-memory fallback ────────────────────────────────────────
const memCache = new Map();

// ── Cache wrapper ─────────────────────────────────────────────
const cache = {
  async get(key) {
    if (_isRedisAvailable && _pubClient) {
      const val = await _pubClient.get(`bridge:cache:${key}`);
      return val ? JSON.parse(val) : null;
    }
    const entry = memCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt < Date.now()) { memCache.delete(key); return null; }
    return entry.value;
  },

  async set(key, value, ttlSeconds = 300) {
    if (_isRedisAvailable && _pubClient) {
      await _pubClient.set(`bridge:cache:${key}`, JSON.stringify(value), { EX: ttlSeconds });
      return;
    }
    memCache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  },

  async del(key) {
    if (_isRedisAvailable && _pubClient) {
      await _pubClient.del(`bridge:cache:${key}`);
      return;
    }
    memCache.delete(key);
  },

  async invalidatePattern(prefix) {
    if (_isRedisAvailable && _pubClient) {
      const keys = await _pubClient.keys(`bridge:cache:${prefix}*`);
      if (keys.length) await _pubClient.del(keys);
      return;
    }
    for (const k of memCache.keys()) {
      if (k.startsWith(prefix)) memCache.delete(k);
    }
  },

  async mget(keys) {
    if (!keys.length) return new Map();
    if (_isRedisAvailable && _pubClient) {
      const prefixed = keys.map(k => `bridge:cache:${k}`);
      const vals     = await _pubClient.mGet(prefixed);
      const result   = new Map();
      keys.forEach((k, i) => {
        if (vals[i] !== null) result.set(k, JSON.parse(vals[i]));
      });
      return result;
    }
    const result = new Map();
    const now    = Date.now();
    for (const k of keys) {
      const entry = memCache.get(k);
      if (entry && (!entry.expiresAt || entry.expiresAt > now)) result.set(k, entry.value);
    }
    return result;
  },

  async mset(entries, ttlSeconds = 300) {
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

  async remember(key, ttlSeconds, computeFn) {
    const cached = await this.get(key);
    if (cached !== null) return cached;
    const value = await computeFn();
    if (value !== null && value !== undefined) await this.set(key, value, ttlSeconds);
    return value;
  },

  async increment(key, ttlSeconds = 60) {
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
    entry.value++;
    return entry.value;
  },

  async decrement(key) {
    if (_isRedisAvailable && _pubClient) return _pubClient.decr(`bridge:cache:${key}`);
    const entry = memCache.get(key);
    if (!entry) return 0;
    entry.value = Math.max(0, entry.value - 1);
    return entry.value;
  },

  async hset(key, field, value) {
    if (_isRedisAvailable && _pubClient) {
      return _pubClient.hSet(`bridge:hash:${key}`, field, JSON.stringify(value));
    }
    let h = memCache.get(`hash:${key}`)?.value;
    if (!h) { h = {}; memCache.set(`hash:${key}`, { value: h }); }
    h[field] = value;
  },

  async hget(key, field) {
    if (_isRedisAvailable && _pubClient) {
      const val = await _pubClient.hGet(`bridge:hash:${key}`, field);
      return val ? JSON.parse(val) : null;
    }
    return memCache.get(`hash:${key}`)?.value?.[field] ?? null;
  },

  async hgetAll(key) {
    if (_isRedisAvailable && _pubClient) {
      const result = await _pubClient.hGetAll(`bridge:hash:${key}`);
      if (!result) return {};
      return Object.fromEntries(Object.entries(result).map(([k, v]) => [k, JSON.parse(v)]));
    }
    return memCache.get(`hash:${key}`)?.value || {};
  },

  async hdel(key, field) {
    if (_isRedisAvailable && _pubClient) return _pubClient.hDel(`bridge:hash:${key}`, field);
    const h = memCache.get(`hash:${key}`)?.value;
    if (h) delete h[field];
  },
};

// ── Notification pub/sub ──────────────────────────────────────
const notifChannel = 'bridge:notifications';

async function publishNotification(payload) {
  if (_isRedisAvailable && _pubClient) {
    await _pubClient.publish(notifChannel, JSON.stringify(payload));
  }
}

// ── Session Cache ─────────────────────────────────────────────
const sessionCache = {
  async invalidateToken(jti, ttlSeconds) {
    await cache.set(`revoked:${jti}`, 1, ttlSeconds);
  },
  async isRevoked(jti) {
    const val = await cache.get(`revoked:${jti}`);
    return val !== null;
  },
};

// ── Redis-backed Sliding Window Rate Limiter ──────────────────
function redisRateLimiter({ windowMs = 60_000, max = 60, keyPrefix = 'rl' } = {}) {
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
      console.warn('[RateLimiter] Redis error, allowing request:', err.message);
    }

    next();
  };
}

// ── Health Check ──────────────────────────────────────────────
async function healthCheck() {
  if (!_isRedisAvailable || !_pubClient) {
    return { redis: false, mode: 'in-memory', memCacheSize: memCache.size };
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
    return { redis: false, error: err.message };
  }
}

// ── Graceful shutdown ─────────────────────────────────────────
async function disconnect() {
  if (_pubClient) {
    try { await _pubClient.quit(); } catch {}
    _pubClient = null;
  }
  if (_subClient) {
    try { await _subClient.quit(); } catch {}
    _subClient = null;
  }
  _isRedisAvailable = false;
  _connectPromise   = null;
  _adapterApplied   = false;
  console.log('[Redis] Singleton bağlantısı kapatıldı');
}

// Graceful shutdown hook
process.on('SIGTERM', disconnect);
process.on('SIGINT',  disconnect);

module.exports = {
  applyAdapter,
  cache,
  sessionCache,
  redisRateLimiter,
  healthCheck,
  disconnect,
  // Getter'lar — doğrudan referans yerine fonksiyon döndür (singleton garantisi)
  redisClient:      () => _pubClient,
  isRedisAvailable: () => _isRedisAvailable,
  publishNotification,
};
export {};
