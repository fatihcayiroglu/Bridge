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

import { randomUUID } from 'crypto';
import { tryRequire } from './_optional-require';
import logger from './logger';
import { envSafeInt } from './envNumbers';

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
  set(key: string, value: string, options?: { EX?: number; NX?: boolean }): Promise<unknown>;
  del(key: string | string[]): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  /**
   * SCAN imleci DIZGEDIR — hem istekte hem yanitta.
   *
   * Bu yerel bildirim imleci `number` ilan ediyordu ve TypeScript bu
   * yuzden YANLIS tipi ZORUNLU kiliyordu: dogru (dizge) kullanim derleme
   * hatasi veriyor, yanlis (sayi) kullanim ise calisma zamaninda
   * @redis/client 6 tarafindan reddediliyordu:
   *     "arguments[1]" must be of type "string | Buffer", got number
   * Yani kusurun KAYNAGI bu satirdi; `invalidatePattern` gercek Redis'te
   * hic calismiyordu. Ust akis tipi: `cursor: RedisArgument`, yanit
   * `cursor: BlobStringReply`.
   */
  scan(cursor: string, options?: { MATCH?: string; COUNT?: number }): Promise<{ cursor: string; keys: string[] }>;
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
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  /** node-redis v6 command proxy.  Aborting removes a queued command so a
   * timed-out authoritative mutation cannot execute later after recovery. */
  withAbortSignal?(signal: AbortSignal): RedisClient;
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
const REDIS_COMMAND_TIMEOUT_MS = envSafeInt('REDIS_COMMAND_TIMEOUT_MS', 2_000, { min: 100, max: 30_000 });
const REDIS_RECOVERY_PROBE_MS = envSafeInt('REDIS_RECOVERY_PROBE_MS', 500, { min: 100, max: 30_000 });
// Yeniden baglanma denemeleri arasindaki EN UZUN bekleme. Deneme SAYISI
// sinirsizdir (yukariya bakiniz); sinirlanan yalnizca sikligidir.
const REDIS_RECONNECT_MAX_DELAY_MS = envSafeInt('REDIS_RECONNECT_MAX_DELAY_MS', 3_000, { min: 100, max: 60_000 });

// ── Singleton state ───────────────────────────────────────────
// Bu değişkenler modül cache'inde yaşar — process boyunca tek kez init edilir
let _pubClient:      RedisClient | null = null;  // Socket.io pub (ve genel cache client)
let _subClient:      RedisClient | null = null;  // Socket.io sub
let _isRedisAvailable = false;
let _connectPromise: Promise<boolean> | null = null;  // İlk bağlantı Promise'i — race condition önleyici
let _redisRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
// Disconnect invalidates every in-flight connection attempt.  Without a
// generation guard, a late connect()/ready event can resurrect a client after
// graceful shutdown has already detached it from the singleton.
let _redisLifecycleGeneration = 0;

type RedisCommandOptions = {
  /** Recovery probes must not recursively schedule another probe. */
  markUnavailable?: boolean;
  timeoutMs?: number;
};

function scheduleRedisRecoveryProbe(): void {
  if (!REDIS_URL || _redisRecoveryTimer || !_pubClient) return;
  _redisRecoveryTimer = setTimeout(async () => {
    _redisRecoveryTimer = null;
    const client = _pubClient;
    if (!client) return;
    try {
      await runRedisCommand(client, 'recovery probe', c => c.ping(), {
        markUnavailable: false,
        timeoutMs: REDIS_COMMAND_TIMEOUT_MS,
      });
      // A disconnect/reconnect may have replaced the singleton while the
      // probe was in flight.  Never let a stale client mark the new one ready.
      if (_pubClient === client) {
        const recovered = !_isRedisAvailable;
        _isRedisAvailable = true;
        if (recovered) logger.info({ event: 'redis.recovered' }, '[Redis] Command path recovered.');
      }
    } catch {
      scheduleRedisRecoveryProbe();
    }
  }, REDIS_RECOVERY_PROBE_MS);
  _redisRecoveryTimer.unref?.();
}

/**
 * Bound every authoritative Redis round trip.  A TCP black-hole (for example
 * a paused pod or severed Docker network) does not necessarily emit `end` or
 * `reconnecting`; without a command deadline, readiness and security checks
 * can remain pending indefinitely while `_isRedisAvailable` is still true.
 *
 * node-redis' AbortSignal support is important here: it removes the command
 * from the offline queue.  A rejected replay claim or lock request therefore
 * cannot execute unexpectedly after the caller has already failed closed.
 */
async function runRedisCommand<T>(
  client: RedisClient,
  operation: string,
  command: (scopedClient: RedisClient) => Promise<T>,
  options: RedisCommandOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? REDIS_COMMAND_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scopedClient = client.withAbortSignal?.(controller.signal) ?? client;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(`Redis command timeout during ${operation}`));
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([command(scopedClient), timeout]);
  } catch (err) {
    if (timedOut && options.markUnavailable !== false) {
      _isRedisAvailable = false;
      logger.error(
        { event: 'redis.command_timeout', operation, timeoutMs },
        '[Redis] Command timed out; shared authority marked unavailable.',
      );
      scheduleRedisRecoveryProbe();
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Bağlantı başlatıcı — idempotent ──────────────────────────
async function disposeRedisClients(...clients: Array<RedisClient | null>): Promise<void> {
  const uniqueClients = [...new Set(clients.filter((client): client is RedisClient => client !== null))];
  await Promise.allSettled(uniqueClients.map(client => client.quit()));
}

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

  const generation = _redisLifecycleGeneration;
  let attemptPubClient: RedisClient | null = null;
  let attemptSubClient: RedisClient | null = null;

  const connectPromise = (async () => {
    try {
      const redisModule = tryRequire<RedisModule>('redis');

      if (!redisModule) {
        logger.warn({ event: 'redis.package_missing' }, '[Redis] "redis" paketi yüklü değil — in-memory modunda devam ediliyor');
        return false;
      }

      const { createClient } = redisModule;

      attemptPubClient = createClient({
        url: REDIS_URL,
        socket: {
          // ── YENIDEN BAGLANMA ASLA PES ETMEZ ────────────────────────────
          // ESKI HALI 10 denemeden sonra `Error` donduruyordu. node-redis bunu
          // "bir daha deneme" olarak yorumlar ve istemciyi KALICI olarak
          // kapatir. Sonucu OLCULDU (v1.123, tek kullanimlik ortam):
          //
          //   1. Redis durduruldu.
          //   2. ~30 sn sonra yeniden baglanma butcesi tukendi.
          //   3. Redis GERI GELDI ve host'tan erisilebilirdi (+PONG).
          //   4. Sunucu 60+ sn sonra hâlâ TUM isteklere 503 doniyordu; yeni
          //      hicbir `redis.reconnecting` olayi uretilmedi. Surec yeniden
          //      baslatilmadan ASLA toparlanmadi.
          //
          // Zincir soyle: istemci kalici olarak olur -> `_isRedisAvailable`
          // kalici olarak false -> hiz sinirlayici yetkili Redis komutunu
          // bulamaz -> fail-closed 503. `/api/health` de bu zincirin
          // arkasindadir, yani yuk dengeleyici TUM ornekleri havuzdan cikarir
          // ve GERI ALMAZ: gecici bir Redis kesintisi KALICI bir filo
          // kesintisine donusur.
          //
          // Fail-closed davranis DOGRUDUR ve degistirilmedi (aksi hâlde Redis'i
          // dusuren biri hiz sinirlarini atlardi). Yanlis olan, kesinti bitince
          // geri donememekti. Bu yuzden deneme sayisi SINIRSIZDIR; yalnizca
          // bekleme suresi sinirlanir, boylece kapali bir Redis'e karsi sonsuz
          // sikin bir dongu de olusmaz.
          reconnectStrategy: (retries: number) =>
            Math.min(retries * 200, REDIS_RECONNECT_MAX_DELAY_MS),
        },
      });
      attemptSubClient = attemptPubClient.duplicate();
      _pubClient = attemptPubClient;
      _subClient = attemptSubClient;

      const ownsPubClient = (): boolean =>
        generation === _redisLifecycleGeneration && _pubClient === attemptPubClient;
      const ownsSubClient = (): boolean =>
        generation === _redisLifecycleGeneration && _subClient === attemptSubClient;

      attemptPubClient.on('error', (e: unknown) => {
        if (!ownsPubClient()) return;
        _isRedisAvailable = false;
        logger.error({ err: e instanceof Error ? e.message : String(e), event: 'redis.pub.error' }, '[Redis pub error]');
        scheduleRedisRecoveryProbe();
      });
      attemptSubClient.on('error', (e: unknown) => {
        if (!ownsSubClient()) return;
        logger.error({ err: e instanceof Error ? e.message : String(e), event: 'redis.sub.error' }, '[Redis sub error]');
      });
      attemptPubClient.on('reconnecting', () => {
        if (!ownsPubClient()) return;
        _isRedisAvailable = false;
        logger.warn({ event: 'redis.reconnecting' }, '[Redis] Yeniden bağlanıyor…');
        scheduleRedisRecoveryProbe();
      });
      attemptPubClient.on('ready', () => {
        if (!ownsPubClient()) return;
        _isRedisAvailable = true;
        logger.info({ event: 'redis.ready' }, 'Redis bağlantısı hazır.');
      });
      attemptPubClient.on('end', () => {
        if (!ownsPubClient()) return;
        _isRedisAvailable = false;
        logger.warn({ event: 'redis.closed' }, '[Redis] Bağlantı kapandı');
      });

      await Promise.all([attemptPubClient.connect(), attemptSubClient.connect()]);
      if (!ownsPubClient() || !ownsSubClient()) {
        await disposeRedisClients(attemptPubClient, attemptSubClient);
        return false;
      }
      _isRedisAvailable = true;
      logger.info({ url: REDIS_URL.replace(/:[^@]+@/, ':***@'), event: 'redis.connected' }, 'Redis singleton bağlandı.');
      return true;
    } catch (err) {
      if (_pubClient === attemptPubClient) _pubClient = null;
      if (_subClient === attemptSubClient) _subClient = null;
      if (generation === _redisLifecycleGeneration) _isRedisAvailable = false;
      await disposeRedisClients(attemptPubClient, attemptSubClient);
      logger.warn({ err: err instanceof Error ? err.message : String(err), event: 'redis.connect_failed' }, '[Redis] Bağlantı başarısız, in-memory moduna geçiliyor');
      return false;
    }
  })();

  _connectPromise = connectPromise;
  void connectPromise.finally(() => {
    if (_connectPromise === connectPromise) _connectPromise = null;
  });
  return connectPromise;
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
const memMutationLockTails = new Map<string, Promise<void>>();
const MEM_CACHE_MAX_ENTRIES = envSafeInt('MEM_CACHE_MAX_ENTRIES', 100_000, { min: 10, max: 1_000_000 });
const MEM_CACHE_SWEEP_MS = envSafeInt('MEM_CACHE_SWEEP_MS', 60_000, { min: 10_000, max: 10 * 60_000 });
let _lastMemEvictionWarnAt = 0;

function pruneMemCache(requiredCapacity = 0): void {
  const now = Date.now();
  for (const [key, entry] of memCache) {
    if (entry.expiresAt && entry.expiresAt <= now) memCache.delete(key);
  }

  let evicted = 0;
  while (memCache.size + requiredCapacity > MEM_CACHE_MAX_ENTRIES) {
    const oldest = memCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    memCache.delete(oldest);
    evicted++;
  }
  if (evicted > 0 && now - _lastMemEvictionWarnAt > 60_000) {
    _lastMemEvictionWarnAt = now;
    logger.warn(
      { event: 'redis.mem_cache.eviction', evicted, size: memCache.size, max: MEM_CACHE_MAX_ENTRIES },
      'In-memory cache capacity reached; oldest entries were evicted.',
    );
  }
}

function setMemCacheEntry(key: string, entry: MemCacheEntry): void {
  const isNew = !memCache.has(key);
  if (isNew) pruneMemCache(1);
  else memCache.delete(key); // refresh insertion order for bounded oldest-first eviction
  memCache.set(key, entry);
}

const _memCacheSweepTimer = setInterval(() => pruneMemCache(), MEM_CACHE_SWEEP_MS);
_memCacheSweepTimer.unref?.();

// ── Cache wrapper ─────────────────────────────────────────────
const cache = {
  _client(): RedisClient | null { return _pubClient; },
  async get<T = unknown>(key: string): Promise<T | null> {
    if (_isRedisAvailable && _pubClient) {
      const val = await runRedisCommand(_pubClient, `cache get ${key}`, client => client.get(`bridge:cache:${key}`));
      return val ? (JSON.parse(val) as T) : null;
    }
    const entry = memCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt < Date.now()) { memCache.delete(key); return null; }
    return entry.value as T;
  },

  async set<T = unknown>(key: string, value: T, ttlSeconds = 300): Promise<void> {
    if (_isRedisAvailable && _pubClient) {
      if (ttlSeconds > 0) {
        await runRedisCommand(_pubClient, `cache set ${key}`, client =>
          client.set(`bridge:cache:${key}`, JSON.stringify(value), { EX: ttlSeconds }));
      } else {
        await runRedisCommand(_pubClient, `cache set ${key}`, client =>
          client.set(`bridge:cache:${key}`, JSON.stringify(value)));
      }
      return;
    }
    setMemCacheEntry(key, { value, expiresAt: ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0 });
  },

  /** Atomically set a cache key only when it does not already exist. */
  async setIfAbsent<T = unknown>(key: string, value: T, ttlSeconds = 300): Promise<boolean> {
    if (_isRedisAvailable && _pubClient) {
      const options: { NX: boolean; EX?: number } = { NX: true };
      if (ttlSeconds > 0) options.EX = ttlSeconds;
      const result = await runRedisCommand(_pubClient, `cache set-if-absent ${key}`, client =>
        client.set(`bridge:cache:${key}`, JSON.stringify(value), options));
      return result !== null;
    }

    const now = Date.now();
    const existing = memCache.get(key);
    if (existing && (!existing.expiresAt || existing.expiresAt > now)) return false;
    if (existing) memCache.delete(key);
    setMemCacheEntry(key, {
      value,
      expiresAt: ttlSeconds > 0 ? now + ttlSeconds * 1000 : 0,
    });
    return true;
  },

  /**
   * Bir desene uyan anahtar SAYISI.
   *
   * ── NEDEN BURADA ──────────────────────────────────────────────────────────
   * `bridge:cache:` öneki YALNIZCA bu dosyanın bildiği bir ayrıntıdır. Çağıran
   * modüllerin öneki kendi başına birleştirmesi, önek bir gün değiştiğinde
   * SESSİZCE 0 döndüren sayaçlar üretirdi — nitekim `bridge_voice_rooms`
   * göstergesi tam olarak bu sınıftan bir nedenle her zaman 0 okuyordu
   * (bkz. Final21 Faz 6, F21-6-01). Bu yüzden desen ÖNEKSİZ verilir ve önek
   * burada eklenir.
   *
   * SCAN kullanılır (KEYS DEĞİL): KEYS tek bir çağrıda tüm anahtar alanını
   * gezer ve Redis'i bloklar; SCAN parçalı ilerler.
   */
  async countKeys(pattern: string): Promise<number> {
    if (_isRedisAvailable && _pubClient) {
      const client = _pubClient;
      return runRedisCommand(client, `cache countKeys ${pattern}`, async (c) => {
        if (typeof c.scan !== 'function') return 0;
        let cursor = '0';
        let total = 0;
        // Sonsuz döngüye karşı sert tavan: 10k tur × COUNT 500.
        for (let guard = 0; guard < 10_000; guard++) {
          const res = await c.scan(cursor, { MATCH: `bridge:cache:${pattern}`, COUNT: 500 });
          total += Array.isArray(res?.keys) ? res.keys.length : 0;
          cursor = String(res?.cursor ?? '0');
          if (cursor === '0') break;
        }
        return total;
      }) ?? 0;
    }
    // Bellek yolu: anahtarlar öneksiz saklanır.
    const escapeLiteral = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(`^${pattern.split('*').map(escapeLiteral).join('.*')}$`);
    let n = 0;
    for (const key of memCache.keys()) if (rx.test(key)) n += 1;
    return n;
  },

  /**
   * Security/durability state that is expected to be shared must never silently
   * degrade to process-local memory when REDIS_URL was explicitly configured.
   * These primitives preserve the ordinary in-memory behaviour for deliberate
   * single-node deployments (no REDIS_URL), but fail closed on cluster-store
   * uncertainty.  They also execute directly against the captured Redis client
   * so an availability flip between a pre-check and the command cannot route the
   * operation into the local fallback.
   */
  async getAuthoritative<T = unknown>(key: string): Promise<T | null> {
    if (!REDIS_URL) return this.get<T>(key);
    const client = _isRedisAvailable ? _pubClient : null;
    if (!client) throw new Error(`Redis authoritative cache unavailable: ${key}`);
    const val = await runRedisCommand(client, `authoritative get ${key}`, scoped =>
      scoped.get(`bridge:cache:${key}`));
    return val ? (JSON.parse(val) as T) : null;
  },

  async setAuthoritative<T = unknown>(key: string, value: T, ttlSeconds = 300): Promise<void> {
    if (!REDIS_URL) return this.set(key, value, ttlSeconds);
    const client = _isRedisAvailable ? _pubClient : null;
    if (!client) throw new Error(`Redis authoritative cache unavailable: ${key}`);
    if (ttlSeconds > 0) {
      await runRedisCommand(client, `authoritative set ${key}`, scoped =>
        scoped.set(`bridge:cache:${key}`, JSON.stringify(value), { EX: ttlSeconds }));
    } else {
      await runRedisCommand(client, `authoritative set ${key}`, scoped =>
        scoped.set(`bridge:cache:${key}`, JSON.stringify(value)));
    }
  },

  async setIfAbsentAuthoritative<T = unknown>(key: string, value: T, ttlSeconds = 300): Promise<boolean> {
    if (!REDIS_URL) return this.setIfAbsent(key, value, ttlSeconds);
    const client = _isRedisAvailable ? _pubClient : null;
    if (!client) throw new Error(`Redis authoritative cache unavailable: ${key}`);
    const options: { NX: boolean; EX?: number } = { NX: true };
    if (ttlSeconds > 0) options.EX = ttlSeconds;
    const result = await runRedisCommand(client, `authoritative set-if-absent ${key}`, scoped =>
      scoped.set(`bridge:cache:${key}`, JSON.stringify(value), options));
    return result !== null;
  },

  async takeAuthoritative<T = unknown>(key: string): Promise<T | null> {
    if (!REDIS_URL) return this.take<T>(key);
    const client = _isRedisAvailable ? _pubClient : null;
    if (!client) throw new Error(`Redis authoritative cache unavailable: ${key}`);
    const rKey = `bridge:cache:${key}`;
    const raw = await runRedisCommand(client, `authoritative take ${key}`, scoped => scoped.eval(
      `local v = redis.call('GET', KEYS[1])
if v then redis.call('DEL', KEYS[1]) end
return v`,
      { keys: [rKey], arguments: [] },
    ));
    if (raw === null || raw === undefined) return null;
    return JSON.parse(String(raw)) as T;
  },

  /** Delete shared authority without ever falling back to process memory when
   * REDIS_URL declares Redis as the deployment's source of truth. */
  async delAuthoritative(key: string): Promise<void> {
    if (!REDIS_URL) return this.del(key);
    const client = _isRedisAvailable ? _pubClient : null;
    if (!client) throw new Error(`Redis authoritative cache unavailable: ${key}`);
    await runRedisCommand(client, `authoritative delete ${key}`, scoped =>
      scoped.del(`bridge:cache:${key}`));
  },

  /** Execute a script against cache keys using the same fail-closed authority
   * contract as the other authoritative primitives. Keys are cache-relative;
   * callers cannot accidentally address the un-prefixed Redis namespace. */
  async luaEvalAuthoritative(script: string, keys: string[], args: string[]): Promise<unknown> {
    if (!REDIS_URL) return this.luaEval(script, keys, args);
    const client = _isRedisAvailable ? _pubClient : null;
    if (!client) throw new Error(`Redis authoritative cache unavailable: ${keys[0] ?? 'lua'}`);
    return runRedisCommand(client, `authoritative Lua ${keys[0] ?? 'lua'}`, scoped => scoped.eval(script, {
      keys: keys.map(key => `bridge:cache:${key}`),
      arguments: args,
    }));
  },

  /** Atomically consume a cache value exactly once. Useful for OAuth state,
   * password-reset nonces and other replay-sensitive short-lived tokens. */
  async take<T = unknown>(key: string): Promise<T | null> {
    if (_isRedisAvailable && _pubClient) {
      const rKey = `bridge:cache:${key}`;
      const raw = await runRedisCommand(_pubClient, `cache take ${key}`, client => client.eval(
        `local v = redis.call('GET', KEYS[1])
if v then redis.call('DEL', KEYS[1]) end
return v`,
        { keys: [rKey], arguments: [] },
      ));
      if (raw === null || raw === undefined) return null;
      return JSON.parse(String(raw)) as T;
    }
    const entry = memCache.get(key);
    if (!entry) return null;
    memCache.delete(key);
    if (entry.expiresAt && entry.expiresAt < Date.now()) return null;
    return entry.value as T;
  },

  async delete(key: string): Promise<void> {
    return this.del(key);
  },

  async del(key: string): Promise<void> {
    if (_isRedisAvailable && _pubClient) {
      await runRedisCommand(_pubClient, `cache delete ${key}`, client =>
        client.del(`bridge:cache:${key}`));
      return;
    }
    memCache.delete(key);
  },

  async invalidatePattern(prefix: string): Promise<void> {
    if (_isRedisAvailable && _pubClient) {
      await runRedisCommand(_pubClient, `cache invalidate ${prefix}`, async client => {
        // KEYS blocks Redis while traversing the entire keyspace. This path is
        // reached by ordinary message mutations, so use incremental SCAN and
        // bounded deletes instead. Redis' cursor can revisit keys; DEL is
        // idempotent and therefore safe if that happens.
        //
        // CURSOR BIR DIZGEDIR, SAYI DEGIL. @redis/client 6 `cursor` icin
        // `RedisArgument` (string | Buffer) ister; SAYI verilince komut
        // KODLAMA sirasinda firlatir:
        //     "arguments[1]" must be of type "string | Buffer", got number
        // Cagiran (`lib/messageCache.ts`) hatayi kritik olmayan sayip yutar,
        // bu yuzden gecersiz kilma GERCEK Redis ile HER ZAMAN sessizce
        // basarisiz oluyordu: kanal ilk-sayfa onbellegi hic dusurulmuyor ve
        // yenileyen / ikinci cihazdan bakan kullanici 45 saniyeye kadar ESKI
        // listeyi goruyordu — bu dosyanin kapattigini soyledigi kusurun ta
        // kendisi. Birim testleri istemciyi mock'ladigi icin bunu goremezdi;
        // gercek Redis'e kosan `tests/pg-integration` bunu yakalar.
        let cursor = '0';
        const pattern = `bridge:cache:${prefix}*`;
        do {
          const page = await client.scan(cursor, { MATCH: pattern, COUNT: 100 });
          cursor = String(page.cursor);
          if (page.keys.length) await client.del(page.keys);
        } while (cursor !== '0');
      });
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
      const vals     = await runRedisCommand(_pubClient, 'cache mget', client => client.mGet(prefixed));
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
      await runRedisCommand(_pubClient, 'cache mset', async client => {
        const pipeline = client.multi();
        for (const [k, v] of entries) {
          const redisKey = `bridge:cache:${k}`;
          if (ttlSeconds > 0) pipeline.set(redisKey, JSON.stringify(v), { EX: ttlSeconds });
          else pipeline.set(redisKey, JSON.stringify(v));
        }
        await pipeline.exec();
      });
      return;
    }
    const expiresAt = ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0;
    for (const [k, v] of entries) setMemCacheEntry(k, { value: v, expiresAt });
  },

  async remember<T = unknown>(key: string, ttlSeconds: number, computeFn: () => Promise<T>): Promise<T | null> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    // Cache Stampede (Thundering Herd) Koruması:
    // Redis varsa SET NX ile distributed lock al.
    // Lock alınamazsa (başka bir instance hesaplıyor), kısa bekle + cache'e yeniden bak.
    if (_isRedisAvailable && _pubClient) {
      const lockKey = `bridge:lock:${key}`;
      // A cache TTL may be zero for non-expiring values, but a distributed
      // stampede lock must always expire. Keep the lease bounded and positive.
      const lockTtl = Math.max(1, Math.min(Number.isSafeInteger(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 30, 30));
      const lockOwner = randomUUID();

      let acquired: string | null | undefined;
      try {
        // Ownership token is critical: a worker whose lease expired must never
        // delete a newer worker's lock in its finally block.
        acquired = await runRedisCommand(_pubClient, `cache computation lock ${key}`, async client =>
          (client as unknown as {
            set(k: string, v: string, opts: { NX: boolean; EX: number }): Promise<string | null>;
          }).set(lockKey, lockOwner, { NX: true, EX: lockTtl }));
      } catch (error) {
        // Lock infrastructure failure may fall back to an unlocked computation,
        // but business compute/cache-write failures below must never be swallowed
        // or re-executed.
        logger.warn({ err: error, key, event: 'redis.cache_lock_acquire_failed' }, '[Redis] cache lock acquire failed');
        acquired = undefined;
      }

      if (acquired) {
        try {
          const value = await computeFn();
          if (value !== null && value !== undefined) await this.set(key, value, ttlSeconds);
          return value ?? null;
        } finally {
          // Compare-and-delete: never release a lease that has already
          // expired and been acquired by another worker.
          try {
            await runRedisCommand(_pubClient!, `cache computation unlock ${key}`, client => client.eval(
              `if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`,
              { keys: [lockKey], arguments: [lockOwner] },
            ));
          } catch (error) {
            // TTL is the final safety net. Do not fail a successfully
            // computed cache result merely because best-effort unlock failed.
            logger.warn({ err: error, key, event: 'redis.cache_lock_release_failed' }, '[Redis] cache lock release failed');
          }
        }
      }

      if (acquired === null) {
        // Another worker owns the lease. Give it one short opportunity to
        // populate the cache; if it did not, compute once without a lock.
        await new Promise(r => setTimeout(r, 100));
        try {
          const refetched = await this.get<T>(key);
          if (refetched !== null) return refetched;
        } catch (error) {
          logger.warn({ err: error, key, event: 'redis.cache_lock_refetch_failed' }, '[Redis] cache refetch after lock contention failed');
        }
      }
    }

    // In-memory fallback veya lock timeout: doğrudan hesapla
    const value = await computeFn();
    if (value !== null && value !== undefined) await this.set(key, value, ttlSeconds);
    return value ?? null;
  },

  async increment(key: string, ttlSeconds = 60): Promise<number> {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new RangeError('cache.increment ttlSeconds must be a positive safe integer');
    }
    if (_isRedisAvailable && _pubClient) {
      const rKey = `bridge:cache:${key}`;
      // One Lua command owns both operations. A network/process failure cannot
      // leave a newly-created counter without an expiry and permanently block
      // rate-limit / AutoMod users.
      const raw = await runRedisCommand(_pubClient, `counter increment ${key}`, client => client.eval(
        `local value = redis.call('INCR', KEYS[1])
if value == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return value`,
        { keys: [rKey], arguments: [String(ttlSeconds)] },
      ));
      const val = Number(raw);
      if (!Number.isSafeInteger(val) || val < 1) throw new Error('Redis increment returned an invalid counter');
      return val;
    }
    if (REDIS_URL) throw new Error(`Redis counter authority unavailable: ${key}`);
    const entry = memCache.get(key);
    const now   = Date.now();
    if (!entry || (entry.expiresAt && entry.expiresAt < now)) {
      setMemCacheEntry(key, { value: 1, expiresAt: now + ttlSeconds * 1000 });
      return 1;
    }
    const next = Number(entry.value) + 1;
    entry.value = next;
    return next;
  },

  /**
   * Atomically claim a fixed cooldown window.
   *
   * Returns 0 when this caller acquired the window, otherwise the remaining
   * milliseconds. Unlike a `get()` + `set()` pair this is one Redis command,
   * so two concurrent sends on different application nodes cannot both pass a
   * channel slowmode check. The in-memory path is also atomic within one Node
   * process because it performs no await between read and write.
   */
  /**
   * Serialize a short read-modify-write mutation by logical key.
   *
   * Redis mode uses a bounded distributed lease with an ownership token;
   * single-node mode uses a per-key promise tail. Callers must keep the
   * critical section short and must route every mutation of the protected
   * resource through the same logical key. Failure to acquire Redis
   * coordination is fail-closed: business state is not mutated unlocked.
   */
  async withKeyLock<T>(
    key: string,
    fn: () => Promise<T>,
    options: { leaseSeconds?: number; waitMs?: number; retryMs?: number } = {},
  ): Promise<T> {
    if (typeof key !== 'string' || key.length < 1 || key.length > 512) {
      throw new TypeError('cache.withKeyLock key must be a non-empty bounded string');
    }
    if (typeof fn !== 'function') throw new TypeError('cache.withKeyLock fn must be a function');
    const leaseSeconds = options.leaseSeconds ?? 5;
    const waitMs = options.waitMs ?? 2_000;
    const retryMs = options.retryMs ?? 15;
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 60 ||
        !Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30_000 ||
        !Number.isSafeInteger(retryMs) || retryMs < 1 || retryMs > 1_000) {
      throw new RangeError('cache.withKeyLock received invalid lock timing');
    }

    if (_isRedisAvailable && _pubClient) {
      const client = _pubClient;
      const lockKey = `bridge:lock:mutation:${key}`;
      const owner = randomUUID();
      const deadline = Date.now() + waitMs;
      let acquired = false;
      for (;;) {
        const result = await runRedisCommand(client, `mutation lock ${key}`, scoped =>
          scoped.set(lockKey, owner, { NX: true, EX: leaseSeconds }));
        if (result) { acquired = true; break; }
        if (Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, retryMs));
      }
      if (!acquired) throw new Error(`Redis mutation lock timeout: ${key}`);

      try {
        return await fn();
      } finally {
        try {
          await runRedisCommand(client, `mutation unlock ${key}`, scoped => scoped.eval(
            `if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`,
            { keys: [lockKey], arguments: [owner] },
          ));
        } catch (error) {
          // The bounded lease is the final safety net. Preserve the business
          // result but make failed release observable.
          logger.warn({ err: error, key, event: 'redis.mutation_lock_release_failed' }, '[Redis] mutation lock release failed');
        }
      }
    }

    if (REDIS_URL) {
      throw new Error(`Redis mutation coordination unavailable: ${key}`);
    }

    const previous = memMutationLockTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    memMutationLockTails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (memMutationLockTails.get(key) === tail) memMutationLockTails.delete(key);
    }
  },

  async claimCooldown(
    key: string,
    intervalMs: number,
    ttlMs = intervalMs + 5_000,
    now = Date.now(),
  ): Promise<number> {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new RangeError('cache.claimCooldown intervalMs must be a positive safe integer');
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs < intervalMs) {
      throw new RangeError('cache.claimCooldown ttlMs must be a safe integer >= intervalMs');
    }
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RangeError('cache.claimCooldown now must be a non-negative safe integer');
    }

    if (_isRedisAvailable && _pubClient) {
      const rKey = `bridge:cache:${key}`;
      const raw = await runRedisCommand(_pubClient, `cooldown claim ${key}`, client => client.eval(
        `local raw = redis.call('GET', KEYS[1])
local now = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  local last = nil
  if ok then last = tonumber(decoded) end
  if not last then last = tonumber(raw) end
  if not last or last > now then
    redis.call('SET', KEYS[1], tostring(now), 'PX', ttl)
    return interval
  end
  local elapsed = now - last
  if elapsed < interval then return interval - elapsed end
end
redis.call('SET', KEYS[1], tostring(now), 'PX', ttl)
return 0`,
        { keys: [rKey], arguments: [String(now), String(intervalMs), String(ttlMs)] },
      ));
      const remaining = Number(raw);
      if (!Number.isSafeInteger(remaining) || remaining < 0 || remaining > intervalMs) {
        throw new Error('Redis cooldown claim returned an invalid remaining interval');
      }
      return remaining;
    }
    if (REDIS_URL) throw new Error(`Redis cooldown authority unavailable: ${key}`);

    const entry = memCache.get(key);
    const live = entry && (!entry.expiresAt || entry.expiresAt > now) ? entry : null;
    if (live) {
      const last = Number(live.value);
      if (!Number.isFinite(last) || !Number.isSafeInteger(last) || last < 0 || last > now) {
        setMemCacheEntry(key, { value: now, expiresAt: now + ttlMs });
        return intervalMs;
      }
      const elapsed = now - last;
      if (elapsed < intervalMs) return intervalMs - elapsed;
    }
    setMemCacheEntry(key, { value: now, expiresAt: now + ttlMs });
    return 0;
  },

  /** Atomic Redis sliding-window hit counter. Returns null when Redis is not
   * available so callers can preserve their single-process fallback stores. */
  async slidingWindowCount(key: string, windowMs: number, now = Date.now()): Promise<number | null> {
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0 || !Number.isSafeInteger(now) || now < 0) {
      throw new RangeError('slidingWindowCount requires positive safe windowMs and non-negative safe now');
    }
    if (!_isRedisAvailable || !_pubClient) {
      if (REDIS_URL) throw new Error(`Redis sliding-window authority unavailable: ${key}`);
      return null;
    }
    const rKey = `bridge:window:${key}`;
    const member = `${now}:${randomUUID()}`;
    const raw = await runRedisCommand(_pubClient, `sliding window ${key}`, client => client.eval(
      `redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[3])
local count = redis.call('ZCARD', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return count`,
      { keys: [rKey], arguments: [String(now), member, String(now - windowMs), String(windowMs + 1000)] },
    ));
    const count = Number(raw);
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('Redis sliding window returned an invalid count');
    return count;
  },

  async decrement(key: string): Promise<number> {
    if (_isRedisAvailable && _pubClient) {
      return runRedisCommand(_pubClient, `counter decrement ${key}`, client =>
        client.decr(`bridge:cache:${key}`));
    }
    if (REDIS_URL) throw new Error(`Redis counter authority unavailable: ${key}`);
    const entry = memCache.get(key);
    if (!entry) return 0;
    const next = Math.max(0, Number(entry.value) - 1);
    entry.value = next;
    return next;
  },

  async hset<T = unknown>(key: string, field: string, value: T): Promise<void> {
    if (_isRedisAvailable && _pubClient) {
      await runRedisCommand(_pubClient, `hash set ${key}`, client =>
        client.hSet(`bridge:hash:${key}`, field, JSON.stringify(value)));
      return;
    }
    const existing = memCache.get(`hash:${key}`)?.value;
    let h: Record<string, T>;
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      h = Object.create(null) as Record<string, T>;
      setMemCacheEntry(`hash:${key}`, { value: h });
    } else if (Object.getPrototypeOf(existing) !== null) {
      // Older/injected fallback entries may be ordinary objects. Normalize them
      // before accepting opaque Redis hash fields such as "__proto__".
      h = Object.assign(Object.create(null) as Record<string, T>, Object.fromEntries(Object.entries(existing)));
      setMemCacheEntry(`hash:${key}`, { value: h });
    } else {
      h = existing as Record<string, T>;
    }
    h[field] = value;
  },

  async hget<T = unknown>(key: string, field: string): Promise<T | null> {
    if (_isRedisAvailable && _pubClient) {
      const val = await runRedisCommand(_pubClient, `hash get ${key}`, client =>
        client.hGet(`bridge:hash:${key}`, field));
      return val ? (JSON.parse(val) as T) : null;
    }
    const h = memCache.get(`hash:${key}`)?.value;
    if (!h || typeof h !== 'object' || Array.isArray(h) || !Object.prototype.hasOwnProperty.call(h, field)) return null;
    return (h as Record<string, T>)[field] ?? null;
  },

  async hgetAll<T = unknown>(key: string): Promise<Record<string, T>> {
    if (_isRedisAvailable && _pubClient) {
      const result = await runRedisCommand(_pubClient, `hash get-all ${key}`, client =>
        client.hGetAll(`bridge:hash:${key}`));
      if (!result) return {};
      return Object.fromEntries(
        Object.entries(result).map(([k, v]) => [k, JSON.parse(v) as T])
      ) as Record<string, T>;
    }
    const h = memCache.get(`hash:${key}`)?.value;
    if (!h || typeof h !== 'object' || Array.isArray(h)) return {};
    // Redis returns a snapshot. Do the same in fallback mode so callers cannot
    // mutate the cache behind hset/hdel and so prototype-like keys remain data.
    return Object.fromEntries(Object.entries(h)) as Record<string, T>;
  },

  async hdel(key: string, field: string): Promise<void> {
    if (_isRedisAvailable && _pubClient) {
      await runRedisCommand(_pubClient, `hash delete ${key}`, client =>
        client.hDel(`bridge:hash:${key}`, field));
      return;
    }
    const h = memCache.get(`hash:${key}`)?.value;
    if (h && typeof h === 'object' && !Array.isArray(h) && Object.prototype.hasOwnProperty.call(h, field)) {
      delete (h as Record<string, unknown>)[field];
    }
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
    return runRedisCommand(_pubClient, `Lua ${keys[0] ?? 'script'}`, client =>
      client.eval(script, { keys, arguments: args }));
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
    await runRedisCommand(_pubClient, 'notification publish', client =>
      client.publish(notifChannel, JSON.stringify(payload)));
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
  await runRedisCommand(_subClient, `subscribe ${channel}`, client => client.subscribe(channel, handler));
  return async () => {
    try {
      if (_subClient) {
        await runRedisCommand(_subClient, `unsubscribe ${channel}`, client => client.unsubscribe(channel));
      }
    } catch { /* ignore */ }
  };
}

async function publishToChannel(channel: string, message: string): Promise<void> {
  if (_isRedisAvailable && _pubClient) {
    await runRedisCommand(_pubClient, `publish ${channel}`, client => client.publish(channel, message));
  }
}

// ── Session Cache ─────────────────────────────────────────────
const sessionCache = {
  async invalidateToken(jti: string, ttlSeconds: number): Promise<void> {
    await cache.setAuthoritative(`revoked:${jti}`, 1, ttlSeconds);
  },
  async isRevoked(jti: string): Promise<boolean> {
    const val = await cache.getAuthoritative(`revoked:${jti}`);
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
  if (!Number.isSafeInteger(windowMs) || windowMs < 1000) throw new RangeError('windowMs must be a safe integer >= 1000');
  if (!Number.isSafeInteger(max) || max <= 0) throw new RangeError('max must be a positive safe integer');
  const windowSec = Math.ceil(windowMs / 1000);

  function incrementLocalRateLimit(key: string): number {
    const localKey = `rate-fallback:${key}`;
    const now = Date.now();
    const entry = memCache.get(localKey);
    if (!entry || (entry.expiresAt && entry.expiresAt <= now)) {
      setMemCacheEntry(localKey, { value: 1, expiresAt: now + windowSec * 1000 });
      return 1;
    }
    const count = Number(entry.value) + 1;
    entry.value = count;
    return count;
  }

  return async function rateLimitMiddleware(req, res, next) {
    const identifier = req.user?.id || req.ip || 'anon';
    const key        = `${keyPrefix}:${identifier}`;
    let count: number;

    try {
      count = await cache.increment(key, windowSec);
    } catch (err) {
      if (REDIS_URL) {
        // In a configured multi-node deployment Redis is the quota authority.
        // Falling back to an independent process counter would multiply the
        // effective allowance by the number of workers exactly while the
        // shared dependency is degraded, so fail closed instead.
        logger.warn({ err: err instanceof Error ? err.message : String(err), event: 'rate_limiter.redis.authority_unavailable' }, '[RateLimiter] Redis authority unavailable');
        res.setHeader('Retry-After', Math.max(1, Math.min(windowSec, 30)));
        res.status(503).json({ error: 'Rate limit authority unavailable' });
        return;
      }

      // Deliberate single-node mode: a bounded process-local quota is the
      // canonical fallback because there is no configured shared authority.
      logger.warn({ err: err instanceof Error ? err.message : String(err), event: 'rate_limiter.local_fallback' }, '[RateLimiter] Cache error, using single-node local quota');
      count = incrementLocalRateLimit(key);
    }

    res.setHeader('X-RateLimit-Limit',     max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - count));

    if (count > max) {
      res.setHeader('Retry-After', windowSec);
      return res.status(429).json({ error: 'Too many requests', retryAfter: windowSec });
    }

    next();
  };
}

// ── Health Check ──────────────────────────────────────────────
export interface HealthCheckResult {
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
    const info = await runRedisCommand(_pubClient, 'health check', async client => {
      await client.ping();
      return client.info('memory');
    });
    const latencyMs = Date.now() - start;
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
  _redisLifecycleGeneration += 1;
  const pubClient = _pubClient;
  const subClient = _subClient;

  // Detach synchronously before awaiting network shutdown.  This prevents an
  // in-flight connection attempt or late event from making the singleton live
  // again while callers believe shutdown is complete.
  _pubClient = null;
  _subClient = null;
  _isRedisAvailable = false;
  _connectPromise = null;
  _adapterApplied = false;

  if (_redisRecoveryTimer) {
    clearTimeout(_redisRecoveryTimer);
    _redisRecoveryTimer = null;
  }
  if (pubClient) {
    try { await pubClient.quit(); }
    catch (err) {
      // SIGTERM sırasında zaten kopuk bağlantılarda hata beklenir;
      // yine de log bırak → gözlemlenebilirlik artırır, sessiz kalmaz.
      logger.warn(
        { err: (err as Error).message, event: 'redis.quit.pub_error' },
        'Redis pub client quit() başarısız — bağlantı zaten kapalı olabilir.',
      );
    }
  }
  if (subClient) {
    try { await subClient.quit(); }
    catch (err) {
      logger.warn(
        { err: (err as Error).message, event: 'redis.quit.sub_error' },
        'Redis sub client quit() başarısız — bağlantı zaten kapalı olabilir.',
      );
    }
  }
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

/**
 * Execute one command (or one Redis MULTI/Lua round trip) against the
 * configured shared authority through the same bounded/cancellable path used
 * by cache security primitives. Callers receive an opaque client on purpose:
 * domain modules must cast only the minimal command surface they own.
 *
 * This helper is for Redis-authoritative deployment state. Deliberate
 * single-node mode should keep using its local owner instead of calling here.
 */
export async function redisAuthoritativeCommand<T>(
  operation: string,
  command: (client: unknown) => Promise<T>,
): Promise<T> {
  if (!REDIS_URL) throw new Error(`Redis authority is not configured: ${operation}`);
  const client = _isRedisAvailable ? _pubClient : null;
  if (!client) throw new Error(`Redis authoritative command unavailable: ${operation}`);
  return runRedisCommand(client, operation, scoped => command(scoped));
}

export function redisClient() {
  return _pubClient;
}

export function isRedisAvailable() {
  return _isRedisAvailable;
}
