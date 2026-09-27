'use strict';

const originalRedisUrl = process.env.REDIS_URL;

type Loaded = {
  mod: typeof import('../lib/twoFactorLoginChallenge');
  cache: {
    setAuthoritative: jest.Mock;
    getAuthoritative: jest.Mock;
    luaEvalAuthoritative: jest.Mock;
    set: jest.Mock;
    get: jest.Mock;
    del: jest.Mock;
    luaEval: jest.Mock;
  };
  isRedisAvailable: jest.Mock;
};

function load(): Loaded {
  process.env.REDIS_URL = 'redis://configured-authority.test:6379';
  jest.resetModules();

  const cache = {
    setAuthoritative: jest.fn(async () => undefined),
    getAuthoritative: jest.fn(async () => null),
    luaEvalAuthoritative: jest.fn(async () => null),
    // These legacy primitives intentionally explode if a configured-Redis
    // security flow accidentally regresses to process-local-capable helpers.
    set: jest.fn(async () => { throw new Error('non-authoritative set used'); }),
    get: jest.fn(async () => { throw new Error('non-authoritative get used'); }),
    del: jest.fn(async () => { throw new Error('non-authoritative del used'); }),
    luaEval: jest.fn(async () => { throw new Error('non-authoritative lua used'); }),
  };
  const isRedisAvailable = jest.fn(() => true);
  jest.doMock('../lib/redisAdapter', () => ({ cache, isRedisAvailable }));
  const mod = require('../lib/twoFactorLoginChallenge') as typeof import('../lib/twoFactorLoginChallenge');
  return { mod, cache, isRedisAvailable };
}

afterEach(() => {
  jest.resetModules();
  jest.dontMock('../lib/redisAdapter');
  if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = originalRedisUrl;
});

describe('two-factor login challenge shared authority', () => {
  it('issue persists only through the authoritative configured-Redis primitive', async () => {
    const { mod, cache } = load();
    const token = await mod.issueTwoFactorLoginChallenge('user-1', 4);

    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(cache.setAuthoritative).toHaveBeenCalledWith(
      expect.stringMatching(/^2fa:login:[a-f0-9]{64}$/),
      expect.objectContaining({ userId: 'user-1', tokenVersion: 4, issuedAt: expect.any(Number) }),
      300,
    );
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('peek reads only authoritative state and never consults local-capable cache', async () => {
    const { mod, cache } = load();
    cache.getAuthoritative.mockResolvedValueOnce({ userId: 'user-2', tokenVersion: 3, issuedAt: Date.now() });

    await expect(mod.peekTwoFactorLoginChallenge('x'.repeat(32))).resolves.toMatchObject({ userId: 'user-2', tokenVersion: 3 });
    expect(cache.getAuthoritative).toHaveBeenCalledWith(expect.stringMatching(/^2fa:login:/));
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('claim atomically consumes the cache-relative authoritative key', async () => {
    const { mod, cache } = load();
    const persisted = { userId: 'user-3', tokenVersion: 8, issuedAt: Date.now() };
    cache.luaEvalAuthoritative.mockResolvedValueOnce(JSON.stringify(persisted));

    await expect(mod.claimTwoFactorLoginChallenge('y'.repeat(32))).resolves.toMatchObject(persisted);
    expect(cache.luaEvalAuthoritative).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET',KEYS[1])"),
      [expect.stringMatching(/^2fa:login:[a-f0-9]{64}$/)],
      [],
    );
    expect(cache.luaEval).not.toHaveBeenCalled();
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.del).not.toHaveBeenCalled();
  });

  it('a Redis failure after availability preflight propagates instead of falling back locally', async () => {
    const { mod, cache } = load();
    cache.setAuthoritative.mockRejectedValueOnce(new Error('redis command timeout'));

    await expect(mod.issueTwoFactorLoginChallenge('user-4', 0)).rejects.toThrow(/redis command timeout/);
    expect(cache.set).not.toHaveBeenCalled();
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
