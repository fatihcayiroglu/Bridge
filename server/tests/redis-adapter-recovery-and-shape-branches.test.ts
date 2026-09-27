import { recordOf, recordsOf } from './helpers/narrow';
// server/tests/redis-adapter-recovery-and-shape-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// REDIS ADAPTÖRÜ — KURTARMA SONDASI, SAHİPLİK VE YANIT ŞEKLİ
// ════════════════════════════════════════════════════════════════════════════
//
// `tests/redis-adapter-connected.test.ts` bağlı protokol yollarını ölçer. Bu
// tamamlayıcı takım geri kalanını kapatır ve hepsi tek bir temaya bakar:
// BİR BAĞLANTI ÖLDÜĞÜNDE NE OLUR?
//
//   · KURTARMA SONDASI. Komut zaman aşımı otoriteyi "kullanılamaz" işaretler
//     ve periyodik bir PING başlatır. Sonda başarılı olursa otorite geri
//     gelir — ama YALNIZCA sondayı başlatan istemci hâlâ geçerliyse. Aksi
//     hâlde ölmüş bir istemci, yerine geçen YENİ bağlantıyı "hazır" ilan eder.
//   · OLAY SAHİPLİĞİ. `error`/`ready`/`end` olayları ESKİ bir bağlantıdan da
//     gelebilir; sahibi olmayan bir olay paylaşılan durumu DEĞİŞTİRMEMELİDİR.
//   · YANIT ŞEKLİ. Redis `null`, boş dize, boş hash gibi kenar değerler
//     döndürür; bunların hepsi "yok" anlamına gelir, hata değil.
//   · TEK DÜĞÜM YEDEĞİ. `REDIS_URL` yokken hız sınırı süreç-yerel sayaca
//     düşer; yapılandırılmışken düşmez, 503 verir.

'use strict';
process.env.NODE_ENV = 'test';

type Listener = (...args: unknown[]) => void;

let packageAvailable = true;
let pub: any;
let sub: any;

function makeClient(name: string) {
  const events: Record<string, Listener[]> = {};
  const kv = new Map<string, string>();
  const hashes = new Map<string, Record<string, string>>();
  const client: any = {
    name, events, kv, hashes,
    connect: jest.fn(async () => undefined),
    quit: jest.fn(async () => undefined),
    duplicate: jest.fn(),
    ping: jest.fn(async () => 'PONG'),
    info: jest.fn(async () => 'used_memory_human:12.3M\r\n'),
    publish: jest.fn(async () => 1),
    subscribe: jest.fn(async () => undefined),
    unsubscribe: jest.fn(async () => undefined),
    get: jest.fn(async (k: string) => kv.get(k) ?? null),
    set: jest.fn(async (k: string, v: string, o?: any) => {
      if (o?.NX && kv.has(k)) return null;
      kv.set(k, v); return 'OK';
    }),
    del: jest.fn(async (k: string | string[]) => {
      const keys = Array.isArray(k) ? k : [k];
      let n = 0; for (const key of keys) if (kv.delete(key)) n += 1;
      return n;
    }),
    keys: jest.fn(async () => []),
    scan: jest.fn(async (_cursor: number, opts?: { MATCH?: string }) => {
      const prefix = (opts?.MATCH || '').replace(/\*$/, '');
      return { cursor: 0, keys: [...kv.keys()].filter(k => k.startsWith(prefix)) };
    }),
    mGet: jest.fn(async (keys: string[]) => keys.map(k => kv.get(k) ?? null)),
    multi: jest.fn(() => {
      const ops: Array<[string, string]> = [];
      const pipeline: any = {
        set: jest.fn((k: string, v: string) => { ops.push([k, v]); return pipeline; }),
        exec: jest.fn(async () => { for (const [k, v] of ops) kv.set(k, v); return ops.map(() => 'OK'); }),
      };
      return pipeline;
    }),
    incr: jest.fn(async (k: string) => { const n = Number(kv.get(k) || 0) + 1; kv.set(k, String(n)); return n; }),
    decr: jest.fn(async (k: string) => { const n = Number(kv.get(k) || 0) - 1; kv.set(k, String(n)); return n; }),
    expire: jest.fn(async () => 1),
    hSet: jest.fn(async (k: string, f: string, v: string) => {
      const h = hashes.get(k) || {}; h[f] = v; hashes.set(k, h); return 1;
    }),
    hGet: jest.fn(async (k: string, f: string) => hashes.get(k)?.[f] ?? null),
    hGetAll: jest.fn(async (k: string) => hashes.get(k) || {}),
    hDel: jest.fn(async () => 1),
    eval: jest.fn(async (script: string, opts: { keys: string[]; arguments: string[] }) => {
      const key = opts.keys[0]!;
      if (script.includes("redis.call('INCR'")) {
        const n = Number(kv.get(key) || 0) + 1; kv.set(key, String(n)); return n;
      }
      if (script.includes("redis.call('GET', KEYS[1]) == ARGV[1]")) {
        if (kv.get(key) === opts.arguments[0]) { kv.delete(key); return 1; }
        return 0;
      }
      if (script.includes("local v = redis.call('GET'")) {
        const value = kv.get(key) ?? null;
        if (value !== null) kv.delete(key);
        return value;
      }
      return ['lua-ok'];
    }),
    on: jest.fn((event: string, fn: Listener) => { (events[event] ||= []).push(fn); return client; }),
    fire: (event: string, ...args: unknown[]) => { for (const fn of events[event] || []) fn(...args); },
  };
  return client;
}

function resetFakes() {
  packageAvailable = true;
  sub = makeClient('sub');
  pub = makeClient('pub');
  pub.duplicate.mockReturnValue(sub);
}
resetFakes();

jest.mock('../lib/_optional-require', () => ({
  tryRequire: (id: string) => {
    if (id === 'redis') return packageAvailable ? { createClient: jest.fn(() => pub) } : null;
    if (id === '@socket.io/redis-adapter') return { createAdapter: () => ({}) };
    return null;
  },
}));
const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../lib/logger', () => ({ __esModule: true, default: log }));

type Adapter = typeof import('../lib/redisAdapter');

function load(options: { url?: string | null; probeMs?: string; timeoutMs?: string } = {}): Adapter {
  if (options.url === null) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = options.url ?? 'redis://user:secret@localhost:6379';
  if (options.probeMs) process.env.REDIS_RECOVERY_PROBE_MS = options.probeMs;
  if (options.timeoutMs) process.env.REDIS_COMMAND_TIMEOUT_MS = options.timeoutMs;
  jest.resetModules();
  return require('../lib/redisAdapter') as Adapter;
}

const previousRedisUrl = process.env.REDIS_URL;

beforeEach(() => {
  jest.clearAllMocks();
  resetFakes();
});

afterEach(() => {
  delete process.env.REDIS_RECOVERY_PROBE_MS;
  delete process.env.REDIS_COMMAND_TIMEOUT_MS;
  if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = previousRedisUrl;
});

/** Lets pending microtasks and zero-delay timers run. */
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

describe('connection lifecycle', () => {
  it('a second connect while one is in flight reuses the same attempt', async () => {
    let release!: () => void;
    pub.connect.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const adapter = load();

    const first = adapter.applyAdapter({ adapter: jest.fn() });
    const second = adapter.applyAdapter({ adapter: jest.fn() });
    await settle();
    release();

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    // Exactly one connection attempt was made for the two callers.
    expect(pub.connect).toHaveBeenCalledTimes(1);
    await adapter.disconnect();
  });

  it('an already-connected adapter short-circuits without reconnecting', async () => {
    const adapter = load();
    await adapter.applyAdapter({ adapter: jest.fn() });
    pub.connect.mockClear();
    await expect(adapter.applyAdapter({ adapter: jest.fn() })).resolves.toBe(true);
    expect(pub.connect).not.toHaveBeenCalled();
    await adapter.disconnect();
  });

  it('a missing REDIS_URL warns about single-node mode outside production', async () => {
    const adapter = load({ url: null });
    await expect(adapter.applyAdapter({ adapter: jest.fn() })).resolves.toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'redis.no_url', clusterSafe: false }), expect.any(String));
    expect(log.error).not.toHaveBeenCalled();
  });

  it('a missing REDIS_URL is an ERROR in production, because scaling silently breaks', async () => {
    process.env.NODE_ENV = 'production';
    try {
      const adapter = load({ url: null });
      await expect(adapter.applyAdapter({ adapter: jest.fn() })).resolves.toBe(false);
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'redis.no_url.production' }), expect.any(String));
    } finally { process.env.NODE_ENV = 'test'; }
  });

  it('a non-Error connect rejection is still reported readably', async () => {
    pub.connect.mockRejectedValue('connection refused');
    const adapter = load();
    await expect(adapter.applyAdapter({ adapter: jest.fn() })).resolves.toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'redis.connect_failed', err: 'connection refused' }), expect.any(String));
    expect(adapter.redisClient()).toBeNull();
  });

  it('the connection log redacts the password from the URL', async () => {
    const adapter = load();
    await adapter.applyAdapter({ adapter: jest.fn() });
    // The redaction is deliberately blunt: whatever it leaves behind, the
    // password must not be in it.
    const connected = log.info.mock.calls.find(([obj]: any[]) => obj?.event === 'redis.connected')!;
    expect(String((connected[0] as { url: string }).url)).not.toContain('secret');
    expect(String((connected[0] as { url: string }).url)).toContain('***@localhost:6379');
    await adapter.disconnect();
  });
});

describe('connection events only count from the client that owns them', () => {
  it('error, reconnecting, ready and end move shared availability', async () => {
    const adapter = load();
    await adapter.applyAdapter({ adapter: jest.fn() });
    expect(adapter.isRedisAvailable()).toBe(true);

    pub.fire('error', new Error('socket reset'));
    expect(adapter.isRedisAvailable()).toBe(false);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'redis.pub.error', err: 'socket reset' }), expect.any(String));

    pub.fire('ready');
    expect(adapter.isRedisAvailable()).toBe(true);

    pub.fire('reconnecting');
    expect(adapter.isRedisAvailable()).toBe(false);

    pub.fire('ready');
    pub.fire('end');
    expect(adapter.isRedisAvailable()).toBe(false);
    await adapter.disconnect();
  });

  it('a non-Error error payload is reported readably on both clients', async () => {
    const adapter = load();
    await adapter.applyAdapter({ adapter: jest.fn() });

    pub.fire('error', 'ECONNRESET');
    sub.fire('error', 'ECONNRESET');

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'redis.pub.error', err: 'ECONNRESET' }), expect.any(String));
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'redis.sub.error', err: 'ECONNRESET' }), expect.any(String));
    await adapter.disconnect();
  });

  it('events from a disposed client cannot resurrect shared state', async () => {
    const adapter = load();
    await adapter.applyAdapter({ adapter: jest.fn() });
    const stale = pub;
    const staleSub = sub;
    await adapter.disconnect();
    expect(adapter.isRedisAvailable()).toBe(false);

    log.error.mockClear();
    stale.fire('ready');
    stale.fire('error', new Error('late error'));
    stale.fire('reconnecting');
    stale.fire('end');
    staleSub.fire('error', new Error('late sub error'));

    expect(adapter.isRedisAvailable()).toBe(false);
    expect(log.error).not.toHaveBeenCalled();
  });
});

describe('the recovery probe', () => {
  it('marks the command path available again after a timeout, and says so once', async () => {
    const adapter = load({ probeMs: '100', timeoutMs: '100' });
    await adapter.applyAdapter({ adapter: jest.fn() });

    // A command that never settles trips the timeout and starts the probe.
    pub.get.mockImplementation(() => new Promise(() => undefined));
    await expect(adapter.cache.getAuthoritative('k')).rejects.toThrow(/timeout/i);
    expect(adapter.isRedisAvailable()).toBe(false);

    log.info.mockClear();
    await new Promise(resolve => setTimeout(resolve, 400));

    expect(adapter.isRedisAvailable()).toBe(true);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'redis.recovered' }), expect.any(String));

    // A later successful probe does not repeat the recovery announcement.
    log.info.mockClear();
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(log.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'redis.recovered' }), expect.any(String));
    await adapter.disconnect();
  });

  it('a probe that keeps failing reschedules itself instead of giving up', async () => {
    const adapter = load({ probeMs: '100', timeoutMs: '100' });
    await adapter.applyAdapter({ adapter: jest.fn() });

    pub.get.mockImplementation(() => new Promise(() => undefined));
    await expect(adapter.cache.getAuthoritative('k')).rejects.toThrow(/timeout/i);
    pub.ping.mockRejectedValue(new Error('still down'));

    await new Promise(resolve => setTimeout(resolve, 400));
    expect(adapter.isRedisAvailable()).toBe(false);
    expect(pub.ping.mock.calls.length).toBeGreaterThan(1);
    await adapter.disconnect();
  });

  it('a probe that resolves after the client was replaced does not mark the new one ready', async () => {
    const adapter = load({ probeMs: '100', timeoutMs: '100' });
    await adapter.applyAdapter({ adapter: jest.fn() });

    let releasePing!: () => void;
    pub.ping.mockImplementation(() => new Promise<string>(resolve => { releasePing = () => resolve('PONG'); }));
    pub.get.mockImplementation(() => new Promise(() => undefined));
    await expect(adapter.cache.getAuthoritative('k')).rejects.toThrow(/timeout/i);

    await new Promise(resolve => setTimeout(resolve, 150));
    await adapter.disconnect();
    releasePing?.();
    await settle();

    expect(adapter.isRedisAvailable()).toBe(false);
  });
});

describe('authoritative writes carry their TTL correctly', () => {
  it('a positive TTL is sent and a non-expiring write omits it', async () => {
    const adapter = load();
    await adapter.applyAdapter({ adapter: jest.fn() });

    await adapter.cache.setAuthoritative('with-ttl', { a: 1 }, 30);
    await adapter.cache.setAuthoritative('forever', { a: 1 }, 0);

    expect(pub.set).toHaveBeenNthCalledWith(1, 'bridge:cache:with-ttl', '{"a":1}', { EX: 30 });
    expect(pub.set).toHaveBeenNthCalledWith(2, 'bridge:cache:forever', '{"a":1}');
    await adapter.disconnect();
  });

  it('set-if-absent uses NX, and omits EX for a non-expiring claim', async () => {
    const adapter = load();
    await adapter.applyAdapter({ adapter: jest.fn() });

    await expect(adapter.cache.setIfAbsentAuthoritative('claim', 1, 30)).resolves.toBe(true);
    await expect(adapter.cache.setIfAbsentAuthoritative('claim', 2, 30)).resolves.toBe(false);
    await adapter.cache.setIfAbsentAuthoritative('permanent', 1, 0);

    expect(pub.set).toHaveBeenNthCalledWith(1, 'bridge:cache:claim', '1', { NX: true, EX: 30 });
    expect(pub.set).toHaveBeenNthCalledWith(3, 'bridge:cache:permanent', '1', { NX: true });
    await adapter.disconnect();
  });

  it('an authoritative Lua call with no keys still names itself in the failure', async () => {
    const adapter = load();
    await adapter.applyAdapter({ adapter: jest.fn() });
    await expect(adapter.cache.luaEvalAuthoritative('return 1', [], [])).resolves.toEqual(['lua-ok']);

    pub.fire('end');
    await expect(adapter.cache.luaEvalAuthoritative('return 1', [], []))
      .rejects.toThrow(/authoritative cache unavailable: lua/);
    await adapter.disconnect();
  });

  it('an unauthoritative Lua call with no keys is a no-op when Redis is down', async () => {
    const adapter = load();
    await adapter.applyAdapter({ adapter: jest.fn() });
    pub.fire('end');
    await expect(adapter.cache.luaEval('return 1', [], [])).resolves.toBeNull();
    await adapter.disconnect();
  });
});

describe('read shapes that mean "not present"', () => {
  it('a one-time take returns null for a missing key and consumes an existing one', async () => {
    const adapter = load();
    await adapter.applyAdapter({ adapter: jest.fn() });

    await expect(adapter.cache.take('absent')).resolves.toBeNull();

    await adapter.cache.set('once', { a: 1 }, 30);
    await expect(adapter.cache.take('once')).resolves.toEqual({ a: 1 });
    await expect(adapter.cache.take('once')).resolves.toBeNull();
    await adapter.disconnect();
  });

  it('a hash field that was never written reads as null', async () => {
    const adapter = load();
    await adapter.applyAdapter({ adapter: jest.fn() });
    await expect(adapter.cache.hget('h', 'missing')).resolves.toBeNull();
    await adapter.disconnect();
  });

  it('an empty hash reads as an empty object, not as a failure', async () => {
    const adapter = load();
    await adapter.applyAdapter({ adapter: jest.fn() });
    await expect(adapter.cache.hgetAll('never-written')).resolves.toEqual({});
    await adapter.disconnect();
  });

  it('pattern invalidation deletes only the pages that had keys', async () => {
    const adapter = load();
    await adapter.applyAdapter({ adapter: jest.fn() });

    await adapter.cache.invalidatePattern('empty-prefix:');
    expect(pub.del).not.toHaveBeenCalled();

    await adapter.cache.set('pref:1', 1, 30);
    await adapter.cache.invalidatePattern('pref:');
    expect(pub.del).toHaveBeenCalledWith(['bridge:cache:pref:1']);
    await adapter.disconnect();
  });
});

describe('the cache stampede lock', () => {
  it('clamps the lease into a bounded positive window', async () => {
    const adapter = load();
    await adapter.applyAdapter({ adapter: jest.fn() });

    await adapter.cache.remember('never-expires', 0, async () => 'v1');
    await adapter.cache.remember('very-long', 86_400, async () => 'v2');
    await adapter.cache.remember('unsafe', Number.NaN, async () => 'v3');

    const leases = pub.set.mock.calls
      .filter(([key]: string[]) => key.startsWith('bridge:lock:'))
      .map(([, , opts]: [string, string, { EX: number }]) => opts.EX);
    expect(leases).toEqual([30, 30, 30]);
    await adapter.disconnect();
  });

  it('a computation that yields null is not written to the cache', async () => {
    const adapter = load();
    await adapter.applyAdapter({ adapter: jest.fn() });

    await expect(adapter.cache.remember('null-value', 30, async () => null)).resolves.toBeNull();
    expect(pub.set.mock.calls.some(([key]: string[]) => key === 'bridge:cache:null-value')).toBe(false);

    await expect(adapter.cache.remember('undef-value', 30, async () => undefined)).resolves.toBeNull();
    await adapter.disconnect();
  });

  it('a caller that lost the lock uses the value the winner published', async () => {
    const adapter = load();
    await adapter.applyAdapter({ adapter: jest.fn() });

    // Simulate a lease already held by another worker, whose result lands in
    // the cache while this caller waits.
    await adapter.cache.set('contended', 'from-winner', 30);
    // The very next SET is the lock acquisition; make it lose the race.
    pub.set.mockImplementationOnce(async () => null);
    const compute = jest.fn(async () => 'computed-locally');

    await expect(adapter.cache.remember('contended', 30, compute)).resolves.toBe('from-winner');
    expect(compute).not.toHaveBeenCalled();
    await adapter.disconnect();
  });
});

describe('the mutation lock gives up at its deadline', () => {
  it('throws rather than running the body when the lease is never free', async () => {
    const adapter = load();
    await adapter.applyAdapter({ adapter: jest.fn() });

    pub.set.mockImplementation(async () => null);
    const body = jest.fn(async () => 'never');

    await expect(adapter.cache.withKeyLock('busy', body, { leaseSeconds: 5, waitMs: 30, retryMs: 5 }))
      .rejects.toThrow(/mutation lock timeout: busy/);
    expect(body).not.toHaveBeenCalled();
    // It retried instead of failing on the first attempt.
    expect(pub.set.mock.calls.length).toBeGreaterThan(1);
    await adapter.disconnect();
  });
});

describe('rate limiting authority', () => {
  function response() {
    const res: any = { headers: {} as Record<string, unknown>, statusCode: 200 };
    res.setHeader = jest.fn((k: string, v: unknown) => { res.headers[k] = v; });
    res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
    res.json = jest.fn(() => res);
    return res;
  }

  it('a configured deployment fails closed when the shared counter is unavailable', async () => {
    const adapter = load();
    await adapter.applyAdapter({ adapter: jest.fn() });
    pub.eval.mockRejectedValue('counter backend offline');

    const res = response();
    const next = jest.fn();
    await adapter.redisRateLimiter({ windowMs: 60_000, max: 5, keyPrefix: 'rl' })(
      { ip: '1.2.3.4', headers: {} } as never, res, next);

    expect(res.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'rate_limiter.redis.authority_unavailable', err: 'counter backend offline' }),
      expect.any(String));
    await adapter.disconnect();
  });

  it('a single-node deployment falls back to a process-local quota', async () => {
    const adapter = load({ url: null });
    const res = response();
    const next = jest.fn();
    const limiter = adapter.redisRateLimiter({ windowMs: 60_000, max: 1, keyPrefix: 'rl-local' });

    await limiter({ ip: '5.6.7.8', headers: {} } as never, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.headers['X-RateLimit-Limit']).toBe(1);

    await limiter({ ip: '5.6.7.8', headers: {} } as never, res, next);
    await limiter({ ip: '5.6.7.8', headers: {} } as never, res, next);
    expect(res.statusCode).toBe(429);
  });
});

describe('health reporting', () => {
  it('reports the redacted url and the parsed memory figure', async () => {
    const adapter = load();
    await adapter.applyAdapter({ adapter: jest.fn() });
    const health = recordOf(await adapter.healthCheck(), 'health');
    expect(health).toMatchObject({ redis: true, mode: 'redis', usedMemory: '12.3M' });
    // Whatever the redaction leaves behind, the password must not survive it.
    expect(String(health.url)).not.toContain('secret');
    expect(String(health.url)).toContain('***@localhost:6379');
    await adapter.disconnect();
  });

  it('a non-Error health failure is still reported readably', async () => {
    const adapter = load();
    await adapter.applyAdapter({ adapter: jest.fn() });
    pub.ping.mockRejectedValue('ping refused');
    await expect(adapter.healthCheck()).resolves.toEqual({ redis: false, error: 'ping refused' });
    await adapter.disconnect();
  });
});

describe('pub/sub teardown', () => {
  it('unsubscribing after a disconnect does not throw', async () => {
    const adapter = load();
    await adapter.applyAdapter({ adapter: jest.fn() });
    const unsubscribe = await adapter.subscribeToChannel('bridge:test', () => undefined);
    expect(unsubscribe).toBeInstanceOf(Function);

    await adapter.disconnect();
    await expect(unsubscribe!()).resolves.toBeUndefined();
    expect(sub.unsubscribe).not.toHaveBeenCalled();
  });

  it('unsubscribing while connected reaches the subscriber client', async () => {
    const adapter = load();
    await adapter.applyAdapter({ adapter: jest.fn() });
    const unsubscribe = await adapter.subscribeToChannel('bridge:test', () => undefined);
    await unsubscribe!();
    expect(sub.unsubscribe).toHaveBeenCalledWith('bridge:test');
    await adapter.disconnect();
  });

  it('publishing without a connection is a silent no-op', async () => {
    const adapter = load({ url: null });
    await expect(adapter.publishToChannel('bridge:test', 'payload')).resolves.toBeUndefined();
    expect(pub.publish).not.toHaveBeenCalled();
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
