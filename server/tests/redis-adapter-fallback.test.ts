process.env.NODE_ENV = 'test';
delete process.env.REDIS_URL;
process.env.MEM_CACHE_MAX_ENTRIES = '10';
process.env.MEM_CACHE_SWEEP_MS = '10000';

jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const redis = require('../lib/redisAdapter') as typeof import('../lib/redisAdapter');
const { cache, sessionCache, redisRateLimiter } = redis;

describe('redisAdapter in-memory production fallback', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    // Delete the namespace used by this suite without relying on private state.
    await Promise.all([
      cache.invalidatePattern('t:'), cache.invalidatePattern('hash:t:'), cache.invalidatePattern('revoked:t:'),
    ]);
  });

  afterAll(async () => {
    await redis.disconnect();
  });

  it('applyAdapter fails cleanly when REDIS_URL is absent', async () => {
    const io = { adapter: jest.fn() };
    await expect(redis.applyAdapter(io)).resolves.toBe(false);
    expect(io.adapter).not.toHaveBeenCalled();
    expect(redis.isRedisAvailable()).toBe(false);
    expect(redis.redisClient()).toBeNull();
    await expect(redis.redisAuthoritativeCommand('fallback-forbidden', async () => true))
      .rejects.toThrow(/authority is not configured/i);
  });

  it('set/get preserves values and TTL expiry fails closed', async () => {
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    await cache.set('t:ttl', { ok: true }, 2);
    await expect(cache.get('t:ttl')).resolves.toEqual({ ok: true });
    spy.mockReturnValue(now + 2001);
    await expect(cache.get('t:ttl')).resolves.toBeNull();
    spy.mockRestore();
  });

  it('take atomically consumes a fallback cache value exactly once and honors expiry', async () => {
    await cache.set('t:take', { userId: 'u1' }, 60);
    await expect(cache.take('t:take')).resolves.toEqual({ userId: 'u1' });
    await expect(cache.take('t:take')).resolves.toBeNull();

    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    await cache.set('t:take-expired', 'secret-state', 1);
    spy.mockReturnValue(now + 1001);
    await expect(cache.take('t:take-expired')).resolves.toBeNull();
    await expect(cache.get('t:take-expired')).resolves.toBeNull();
    spy.mockRestore();
  });

  it('authoritative primitives preserve deliberate single-node fallback when REDIS_URL is absent', async () => {
    await cache.setAuthoritative('t:auth', { ok: true }, 60);
    await expect(cache.getAuthoritative('t:auth')).resolves.toEqual({ ok: true });
    await expect(cache.setIfAbsentAuthoritative('t:auth-nx', 1, 60)).resolves.toBe(true);
    await expect(cache.setIfAbsentAuthoritative('t:auth-nx', 2, 60)).resolves.toBe(false);
    await cache.setAuthoritative('t:auth-take', 'once', 60);
    await expect(cache.takeAuthoritative('t:auth-take')).resolves.toBe('once');
    await expect(cache.takeAuthoritative('t:auth-take')).resolves.toBeNull();
    await cache.setAuthoritative('t:auth-del', 'once', 60);
    await expect(cache.delAuthoritative('t:auth-del')).resolves.toBeUndefined();
    await expect(cache.getAuthoritative('t:auth-del')).resolves.toBeNull();
  });

  it('zero TTL remains available and delete removes it', async () => {
    await cache.set('t:persistent', 7, 0);
    await expect(cache.get('t:persistent')).resolves.toBe(7);
    await cache.delete('t:persistent');
    await expect(cache.get('t:persistent')).resolves.toBeNull();
  });

  it('setIfAbsent is atomic in fallback and permits replacement after expiry', async () => {
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    await expect(cache.setIfAbsent('t:nx', 'a', 1)).resolves.toBe(true);
    await expect(cache.setIfAbsent('t:nx', 'b', 1)).resolves.toBe(false);
    await expect(cache.get('t:nx')).resolves.toBe('a');
    spy.mockReturnValue(now + 1001);
    await expect(cache.setIfAbsent('t:nx', 'b', 1)).resolves.toBe(true);
    await expect(cache.get('t:nx')).resolves.toBe('b');
    spy.mockRestore();
  });

  it('mset/mget returns only live requested entries', async () => {
    await cache.mset([['t:a', 1], ['t:b', 2]], 60);
    const values = await cache.mget<number>(['t:a', 't:b', 't:missing']);
    expect([...values.entries()]).toEqual([['t:a', 1], ['t:b', 2]]);
  });

  it('mset zero TTL matches set semantics and remains non-expiring', async () => {
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await cache.mset([['t:m-persistent', 9]], 0);
      spy.mockReturnValue(now + 86_400_000);
      await expect(cache.mget<number>(['t:m-persistent']))
        .resolves.toEqual(new Map([['t:m-persistent', 9]]));
    } finally {
      spy.mockRestore();
    }
  });

  it('delPattern removes only the requested prefix', async () => {
    await cache.set('t:p:1', 1);
    await cache.set('t:p:2', 2);
    await cache.set('t:q:1', 3);
    await cache.invalidatePattern('t:p:');
    await expect(cache.get('t:p:1')).resolves.toBeNull();
    await expect(cache.get('t:p:2')).resolves.toBeNull();
    await expect(cache.get('t:q:1')).resolves.toBe(3);
  });

  it('remember caches non-null compute results and does not cache null', async () => {
    const compute = jest.fn().mockResolvedValueOnce({ value: 1 });
    await expect(cache.remember('t:remember', 30, compute)).resolves.toEqual({ value: 1 });
    await expect(cache.remember('t:remember', 30, compute)).resolves.toEqual({ value: 1 });
    expect(compute).toHaveBeenCalledTimes(1);

    const nullCompute = jest.fn().mockResolvedValue(null);
    await expect(cache.remember('t:null', 30, nullCompute)).resolves.toBeNull();
    await expect(cache.remember('t:null', 30, nullCompute)).resolves.toBeNull();
    expect(nullCompute).toHaveBeenCalledTimes(2);
  });

  it('increment starts at one, increments and resets after expiry', async () => {
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    await expect(cache.increment('t:counter', 1)).resolves.toBe(1);
    await expect(cache.increment('t:counter', 1)).resolves.toBe(2);
    spy.mockReturnValue(now + 1001);
    await expect(cache.increment('t:counter', 1)).resolves.toBe(1);
    spy.mockRestore();
  });

  it('increment rejects non-positive, fractional and unsafe TTL values', async () => {
    await expect(cache.increment('t:bad0', 0)).rejects.toThrow(/positive safe integer/);
    await expect(cache.increment('t:badfrac', 1.5)).rejects.toThrow(/positive safe integer/);
    await expect(cache.increment('t:badunsafe', Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow(/positive safe integer/);
  });

  it('withKeyLock serializes same-key in-memory mutations without blocking different keys', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const first = cache.withKeyLock('t:lock', async () => {
      order.push('first-start');
      await firstGate;
      order.push('first-end');
    });
    const second = cache.withKeyLock('t:lock', async () => { order.push('second'); });
    const other = cache.withKeyLock('t:other-lock', async () => { order.push('other'); });
    await other;
    expect(order).toEqual(['first-start', 'other']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'other', 'first-end', 'second']);
  });

  it('claimCooldown atomically preserves a fixed window in memory', async () => {
    await expect(cache.claimCooldown('t:cool', 10_000, 15_000, 100_000)).resolves.toBe(0);
    await expect(cache.claimCooldown('t:cool', 10_000, 15_000, 102_500)).resolves.toBe(7_500);
    // A rejection does not slide the window; exactly ten seconds from the
    // accepted claim is eligible again.
    await expect(cache.claimCooldown('t:cool', 10_000, 15_000, 110_000)).resolves.toBe(0);
  });

  it('claimCooldown fails closed once and heals corrupt/future fallback state', async () => {
    await cache.set('t:cool-corrupt', 'not-a-timestamp', 60);
    await expect(cache.claimCooldown('t:cool-corrupt', 1_000, 6_000, 50_000)).resolves.toBe(1_000);
    await expect(cache.claimCooldown('t:cool-corrupt', 1_000, 6_000, 51_000)).resolves.toBe(0);
    await expect(cache.claimCooldown('t:cool-bad', 0)).rejects.toThrow(/positive safe integer/);
  });

  it('decrement floors at zero and missing keys are zero', async () => {
    await expect(cache.decrement('t:no-counter')).resolves.toBe(0);
    await cache.set('t:dec', 1, 60);
    await expect(cache.decrement('t:dec')).resolves.toBe(0);
    await expect(cache.decrement('t:dec')).resolves.toBe(0);
  });

  it('hash operations preserve JSON-like values and missing hashes are empty', async () => {
    await expect(cache.hgetAll('t:hash')).resolves.toEqual({});
    await expect(cache.hget('t:hash', 'a')).resolves.toBeNull();
    await cache.hset('t:hash', 'a', { x: 1 });
    await cache.hset('t:hash', 'b', 2);
    await expect(cache.hget('t:hash', 'a')).resolves.toEqual({ x: 1 });
    await expect(cache.hgetAll('t:hash')).resolves.toEqual({ a: { x: 1 }, b: 2 });
    await cache.hdel('t:hash', 'a');
    await expect(cache.hget('t:hash', 'a')).resolves.toBeNull();
  });

  it('hash fallback treats prototype-like names as opaque Redis fields and returns snapshots', async () => {
    await expect(cache.hget('t:hash-opaque', 'constructor')).resolves.toBeNull();
    await expect(cache.hget('t:hash-opaque', 'toString')).resolves.toBeNull();

    await cache.hset('t:hash-opaque', '__proto__', { polluted: true });
    await cache.hset('t:hash-opaque', 'constructor', 'stored-value');
    await expect(cache.hget('t:hash-opaque', '__proto__')).resolves.toEqual({ polluted: true });
    await expect(cache.hget('t:hash-opaque', 'constructor')).resolves.toBe('stored-value');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();

    const snapshot = await cache.hgetAll<any>('t:hash-opaque');
    expect(Object.prototype.hasOwnProperty.call(snapshot, '__proto__')).toBe(true);
    // Prototip kirlenmesi sinaniyor: `constructor` UZERINE yazmak testin ta
    // kendisi. Sozluk olarak ele alinir; `Object`in kendi uye tipi degil.
    Object.defineProperty(snapshot, 'constructor', { value: 'caller-mutated', writable: true, configurable: true });
    await expect(cache.hget('t:hash-opaque', 'constructor')).resolves.toBe('stored-value');

    await cache.hdel('t:hash-opaque', '__proto__');
    await expect(cache.hget('t:hash-opaque', '__proto__')).resolves.toBeNull();

    // Normalize legacy ordinary-object entries and replace malformed array
    // entries instead of inheriting their prototype/index semantics.
    await cache.set('hash:t:hash-legacy', { legacy: 1 }, 0);
    await cache.hset('t:hash-legacy', 'next', 2);
    await expect(cache.hgetAll('t:hash-legacy')).resolves.toEqual({ legacy: 1, next: 2 });
    await cache.set('hash:t:hash-array', ['not', 'a', 'hash'], 0);
    await expect(cache.hget('t:hash-array', '0')).resolves.toBeNull();
    await expect(cache.hgetAll('t:hash-array')).resolves.toEqual({});
    await expect(cache.hdel('t:hash-array', '0')).resolves.toBeUndefined();
    await cache.hset('t:hash-array', 'fresh', true);
    await expect(cache.hgetAll('t:hash-array')).resolves.toEqual({ fresh: true });
  });

  it('luaEval explicitly reports unavailable Redis as null', async () => {
    await expect(cache.luaEval('return 1', ['k'], ['v'])).resolves.toBeNull();
  });

  it('sessionCache revocation uses the same bounded cache contract', async () => {
    await expect(sessionCache.isRevoked('t:jti')).resolves.toBe(false);
    await sessionCache.invalidateToken('t:jti', 60);
    await expect(sessionCache.isRevoked('t:jti')).resolves.toBe(true);
  });

  it('rate limiter rejects invalid window/quota configuration instead of creating a fail-open limiter', () => {
    expect(() => redisRateLimiter({ windowMs: 999 })).toThrow(/windowMs/);
    expect(() => redisRateLimiter({ windowMs: 1.5 })).toThrow(/windowMs/);
    expect(() => redisRateLimiter({ max: 0 })).toThrow(/max/);
    expect(() => redisRateLimiter({ max: 1.5 })).toThrow(/max/);
  });

  it('rate limiter sets headers, permits within quota and blocks above quota', async () => {
    const limiter = redisRateLimiter({ windowMs: 30_000, max: 2, keyPrefix: 't:rl' });
    const headers: Record<string, string | number> = {};
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const res = { setHeader: (k: string, v: string | number) => { headers[k] = v; }, status };
    const next = jest.fn();

    await limiter({ user: { id: 'u1' }, ip: 'ignored' }, res, next);
    await limiter({ user: { id: 'u1' } }, res, next);
    expect(next).toHaveBeenCalledTimes(2);
    await limiter({ user: { id: 'u1' } }, res, next);
    expect(status).toHaveBeenCalledWith(429);
    expect(json).toHaveBeenCalledWith({ error: 'Too many requests', retryAfter: 30 });
    expect(headers['X-RateLimit-Limit']).toBe(2);
    expect(headers['X-RateLimit-Remaining']).toBe(0);
    expect(headers['Retry-After']).toBe(30);
  });

  it('rate limiter falls back to IP/anon and preserves a local quota on cache error', async () => {
    const limiter = redisRateLimiter({ max: 1, keyPrefix: 't:rlerr' });
    const res = { setHeader: jest.fn(), status: jest.fn(() => ({ json: jest.fn() })) };
    const next = jest.fn();
    const inc = cache.increment as jest.Mock;
    inc.mockRejectedValueOnce(new Error('cache down'));
    await limiter({ ip: '127.0.0.1' }, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    inc.mockRejectedValueOnce(new Error('cache still down'));
    await limiter({ ip: '127.0.0.1' }, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(next).toHaveBeenCalledTimes(1);

    await limiter({}, res, next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('healthCheck exposes in-memory mode and production cluster warning', async () => {
    process.env.NODE_ENV = 'production';
    const out = await redis.healthCheck();
    expect(out).toMatchObject({ redis: false, mode: 'in-memory' });
    expect(out.clusterWarning).toMatch(/REDIS_URL|Production/i);
    process.env.NODE_ENV = 'test';
  });

  it('pub/sub helpers are safe no-ops when Redis is unavailable', async () => {
    await expect(redis.publishNotification({ x: 1 })).resolves.toBeUndefined();
    await expect(redis.publishToChannel('c', 'm')).resolves.toBeUndefined();
    await expect(redis.subscribeToChannel('c', jest.fn())).resolves.toBeNull();
  });

  it('bounded fallback evicts oldest keys instead of growing without limit', async () => {
    for (let i = 0; i < 12; i++) await cache.set(`t:cap:${i}`, i, 0);
    await expect(cache.get('t:cap:0')).resolves.toBeNull();
    await expect(cache.get('t:cap:1')).resolves.toBeNull();
    await expect(cache.get('t:cap:11')).resolves.toBe(11);
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
