// server/tests/twofactor-challenge-fail-closed.test.ts
//
// The second-factor login challenge is the only thing standing between a
// correct password and a session. Every abnormal state must refuse:
//   · a stored challenge whose owner, version or issue time is malformed,
//     issued in the future, or older than its lifetime (a store without TTL
//     enforcement must not extend it);
//   · a configured Redis that is down (no silent local fallback);
//   · a consumed challenge in Redis mode (never resurrected from memory);
//   · out-of-range tokens, before the store is even touched.
// In single-node mode a challenge is consumed exactly once, even under
// concurrent claims.
'use strict';

const originalRedisUrl = process.env.REDIS_URL;
const TTL_MS = 5 * 60 * 1000;

type Mod = typeof import('../lib/twoFactorLoginChallenge');

function loadConfigured(available = true) {
  process.env.REDIS_URL = 'redis://configured-authority.test:6379';
  jest.resetModules();
  const cache = {
    setAuthoritative: jest.fn(async () => undefined),
    getAuthoritative: jest.fn(async (): Promise<unknown> => null),
    luaEvalAuthoritative: jest.fn(async (): Promise<unknown> => null),
    get: jest.fn(async () => { throw new Error('process-local get used in Redis mode'); }),
    del: jest.fn(async () => { throw new Error('process-local del used in Redis mode'); }),
  };
  const isRedisAvailable = jest.fn(() => available);
  jest.doMock('../lib/redisAdapter', () => ({ cache, isRedisAvailable }));
  return { mod: require('../lib/twoFactorLoginChallenge') as Mod, cache, isRedisAvailable };
}

/** Explicit single-node mode: an in-memory store with the adapter's API shape. */
function loadSingleNode() {
  delete process.env.REDIS_URL;
  jest.resetModules();
  const store = new Map<string, unknown>();
  const cache = {
    setAuthoritative: jest.fn(async (key: string, value: unknown) => { store.set(key, value); }),
    getAuthoritative: jest.fn(async (key: string) => store.get(key) ?? null),
    luaEvalAuthoritative: jest.fn(async () => null),            // no Redis: the script cannot run
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    del: jest.fn(async (key: string) => { store.delete(key); }),
  };
  jest.doMock('../lib/redisAdapter', () => ({ cache, isRedisAvailable: () => false }));
  return { mod: require('../lib/twoFactorLoginChallenge') as Mod, cache, store };
}

afterEach(() => {
  jest.resetModules();
  jest.dontMock('../lib/redisAdapter');
  if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = originalRedisUrl;
});

const TOKEN = 't'.repeat(43);

describe('malformed or out-of-lifetime stored challenges are refused', () => {
  const now = Date.now();
  const cases: Array<[string, unknown]> = [
    ['an empty owner', { userId: '', tokenVersion: 0, issuedAt: now }],
    ['an over-long owner', { userId: 'u'.repeat(257), tokenVersion: 0, issuedAt: now }],
    ['a non-string owner', { userId: 42, tokenVersion: 0, issuedAt: now }],
    ['a non-canonical version', { userId: 'u1', tokenVersion: '01', issuedAt: now }],
    ['a negative version', { userId: 'u1', tokenVersion: -1, issuedAt: now }],
    ['an issue time in the future', { userId: 'u1', tokenVersion: 0, issuedAt: now + 61_000 }],
    ['an issue time past the lifetime', { userId: 'u1', tokenVersion: 0, issuedAt: now - TTL_MS - 61_000 }],
    ['an array', [{ userId: 'u1', tokenVersion: 0, issuedAt: now }]],
  ];
  it.each(cases)('peek refuses %s', async (_name, row) => {
    const { mod, cache } = loadConfigured();
    cache.getAuthoritative.mockResolvedValueOnce(row);
    await expect(mod.peekTwoFactorLoginChallenge(TOKEN)).resolves.toBeNull();
  });
  it.each(cases)('claim refuses %s', async (_name, row) => {
    const { mod, cache } = loadConfigured();
    cache.luaEvalAuthoritative.mockResolvedValueOnce(JSON.stringify(row));
    await expect(mod.claimTwoFactorLoginChallenge(TOKEN)).resolves.toBeNull();
  });

  it('a challenge just inside its lifetime and clock-skew allowance is still accepted', async () => {
    const { mod, cache } = loadConfigured();
    cache.getAuthoritative.mockResolvedValueOnce({ userId: 'u1', tokenVersion: 2, issuedAt: Date.now() - TTL_MS - 30_000 });
    await expect(mod.peekTwoFactorLoginChallenge(TOKEN)).resolves.toMatchObject({ userId: 'u1', tokenVersion: 2 });
  });

  it('an unparsable stored value is refused, not thrown', async () => {
    const { mod, cache } = loadConfigured();
    cache.luaEvalAuthoritative.mockResolvedValueOnce('{not json');
    await expect(mod.claimTwoFactorLoginChallenge(TOKEN)).resolves.toBeNull();
  });
});

describe('the store must be authoritative', () => {
  it('a configured Redis that is down refuses issue, peek and claim instead of falling back', async () => {
    const { mod, cache } = loadConfigured(false);
    await expect(mod.issueTwoFactorLoginChallenge('u1', 0)).rejects.toThrow('Two-factor challenge store unavailable');
    await expect(mod.peekTwoFactorLoginChallenge(TOKEN)).rejects.toThrow('Two-factor challenge store unavailable');
    await expect(mod.claimTwoFactorLoginChallenge(TOKEN)).rejects.toThrow('Two-factor challenge store unavailable');
    expect(cache.setAuthoritative).not.toHaveBeenCalled();
    expect(cache.luaEvalAuthoritative).not.toHaveBeenCalled();
  });

  it('in Redis mode an absent key is final: process-local memory is never consulted', async () => {
    const { mod, cache } = loadConfigured();
    await expect(mod.claimTwoFactorLoginChallenge(TOKEN)).resolves.toBeNull();
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.del).not.toHaveBeenCalled();
  });

  it('out-of-range tokens are refused before the store is touched', async () => {
    const { mod, cache } = loadConfigured();
    for (const token of ['x'.repeat(31), 'x'.repeat(129), 7 as unknown as string]) {
      await expect(mod.peekTwoFactorLoginChallenge(token)).resolves.toBeNull();
      await expect(mod.claimTwoFactorLoginChallenge(token)).resolves.toBeNull();
    }
    expect(cache.getAuthoritative).not.toHaveBeenCalled();
    expect(cache.luaEvalAuthoritative).not.toHaveBeenCalled();
  });

  it('issuing for an invalid owner or version is refused', async () => {
    const { mod, cache } = loadConfigured();
    await expect(mod.issueTwoFactorLoginChallenge('', 0)).rejects.toThrow(TypeError);
    await expect(mod.issueTwoFactorLoginChallenge('u'.repeat(257), 0)).rejects.toThrow(TypeError);
    await expect(mod.issueTwoFactorLoginChallenge('u1', -1)).rejects.toThrow();
    expect(cache.setAuthoritative).not.toHaveBeenCalled();
  });
});

describe('single-node mode', () => {
  it('a challenge can be peeked repeatedly but claimed only once', async () => {
    const { mod } = loadSingleNode();
    const token = await mod.issueTwoFactorLoginChallenge('u1', 3);
    await expect(mod.peekTwoFactorLoginChallenge(token)).resolves.toMatchObject({ userId: 'u1', tokenVersion: 3 });
    await expect(mod.peekTwoFactorLoginChallenge(token)).resolves.toMatchObject({ userId: 'u1' });
    await expect(mod.claimTwoFactorLoginChallenge(token)).resolves.toMatchObject({ userId: 'u1', tokenVersion: 3 });
    await expect(mod.claimTwoFactorLoginChallenge(token)).resolves.toBeNull();
    await expect(mod.peekTwoFactorLoginChallenge(token)).resolves.toBeNull();
  });

  it('concurrent claims of one challenge produce exactly one winner', async () => {
    const { mod } = loadSingleNode();
    const token = await mod.issueTwoFactorLoginChallenge('u1', 0);
    const results = await Promise.all(Array.from({ length: 5 }, () => mod.claimTwoFactorLoginChallenge(token)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('the stored record never contains the token itself', async () => {
    const { mod, store } = loadSingleNode();
    const token = await mod.issueTwoFactorLoginChallenge('u1', 0);
    const keys = [...store.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^2fa:login:[a-f0-9]{64}$/);
    expect(JSON.stringify([...store.entries()])).not.toContain(token);
  });
});
