const mockRedisAvailable = jest.fn(() => false);
const mockStore = new Map<string, string>();
const mockClient = {
  get: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  set: jest.fn(async (k: string, v: string) => { mockStore.set(k, v); return 'OK'; }),
  del: jest.fn(async (k: string) => { mockStore.delete(k); return 1; }),
};
const mockRedisClient = jest.fn(() => mockClient);

const mockWithKeyLock = jest.fn(async (_key: string, fn: () => Promise<unknown>) => fn());

jest.mock('../lib/redisAdapter', () => ({
  isRedisAvailable: () => mockRedisAvailable(),
  redisClient: () => mockRedisClient(),
  redisAuthoritativeCommand: async (_operation: string, command: (client: unknown) => Promise<unknown>) => {
    if (!mockRedisAvailable()) throw new Error('Redis security state unavailable');
    return command(mockRedisClient());
  },
  cache: { withKeyLock: (...args: unknown[]) => mockWithKeyLock(...args as [string, () => Promise<unknown>]) },
}));

import {
  escapeHtml, sanitizeMessage, sanitizeUsername, sanitizeDisplayName, isSafeUrl,
  validateInput, checkSpam, checkSpamAsync, generateCsrfToken, verifyCsrfToken,
  progressiveRateLimit, progressiveRateLimitAsync, securityHeaders,
} from '../lib/security';

beforeEach(() => {
  mockStore.clear(); jest.clearAllMocks(); mockRedisAvailable.mockReturnValue(false);
  delete process.env.REDIS_URL;
  jest.useRealTimers();
});
afterAll(() => { jest.useRealTimers(); delete process.env.REDIS_URL; });

describe('sanitization and validation branch matrix', () => {
  it('escape/sanitizers reject non strings and neutralize active markup', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(`<a x='1'>&/=\``)).toContain('&lt;');
    expect(sanitizeMessage(null)).toBe('');
    expect(sanitizeMessage(' <script>alert(1)</script><b>x</b> javascript: data: onclick= y ')).not.toMatch(/script|<b>|javascript:|data:|onclick=/i);
    expect(sanitizeMessage('x'.repeat(2500))).toHaveLength(2000);
    expect(sanitizeUsername(null)).toBe('');
    expect(sanitizeUsername('  a!b@c Ç_-.  ')).toBe('abcÇ_-.');
    expect(sanitizeUsername('x'.repeat(40))).toHaveLength(32);
    expect(sanitizeDisplayName(null)).toBe('');
    expect(sanitizeDisplayName('<b>A</b> javascript: data: onerror=\u0000\u200b B')).toBe('A    B');
    expect(sanitizeDisplayName('x'.repeat(40))).toHaveLength(32);
  });

  it('URL policy only accepts parseable http/https', () => {
    expect(isSafeUrl('https://example.com')).toBe(true);
    expect(isSafeUrl('http://example.com')).toBe(true);
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('not a url')).toBe(false);
  });

  it.each([
    ['messageContent', 42, 'content must be a string'],
    ['messageContent', '   ', 'content cannot be empty'],
    ['messageContent', 'x'.repeat(2001), 'content too long (max 2000)'],
    ['username', 1, 'username must be a string'],
    ['username', 'ab', 'username too short (min 3)'],
    ['username', 'x'.repeat(33), 'username too long (max 32)'],
    ['username', 'bad-name', 'username can only contain letters, numbers, underscores'],
    ['username', 'ADMIN', 'username is reserved'],
    ['password', 1, 'password must be a string'],
    ['password', 'short', 'password too short (min 8)'],
    ['password', 'x'.repeat(129), 'password too long'],
    ['password', 'aaaaaaaa', 'password too simple'],
    ['serverName', 1, 'name must be a string'],
    ['serverName', ' ', 'name required'],
    ['serverName', 'x'.repeat(51), 'name too long (max 50)'],
    ['serverName', '<b>x</b>', 'name contains invalid characters'],
    ['channelName', 1, 'name must be a string'],
    ['channelName', ' ', 'name required'],
    ['channelName', 'x'.repeat(33), 'channel name too long (max 32)'],
    ['channelName', 'bad/name', 'channel name has invalid characters'],
  ] as const)('%s invalid %#', (field, value, expected) => expect(validateInput(field, value)).toBe(expected));

  it('valid and unknown fields return null', () => {
    for (const [f,v] of [['messageContent','hello'],['username','valid_user'],['password','GoodPass123'],['serverName','Server'],['channelName','kanal-1']] as const)
      expect(validateInput(f,v)).toBeNull();
    expect(validateInput('futureField', 'anything')).toBeNull();
  });
});

describe('spam state machine', () => {
  it('duplicate content blocks before generic rate mute', () => {
    const k='dup-'+Math.random();
    expect(checkSpam(k,' same ')).toEqual({ blocked:false });
    checkSpam(k,'same'); checkSpam(k,'SAME');
    expect(checkSpam(k,'same')).toEqual({ blocked:true, reason:'spam_duplicate' });
  });

  it('rate path warns once, short-rejects excess, then mutes only after three strikes', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const k='rate-'+Math.random();
    for (let i=0;i<5;i++) expect(checkSpam(k,'m'+i).blocked).toBe(false);
    expect(checkSpam(k,'m5')).toEqual({ blocked:false, warning:true, reason:'spam_warning' });

    const first=checkSpam(k,'m6') as { blocked: boolean; reason: string; remainingMs?: number };
    expect(first).toMatchObject({ blocked:true, reason:'spam_rate' });
    expect(first.remainingMs).toBeGreaterThanOrEqual(1_000);
    expect(first.remainingMs).toBeLessThan(30_000);

    const second=checkSpam(k,'m7') as { blocked: boolean; reason: string; remainingMs?: number };
    expect(second).toMatchObject({ blocked:true, reason:'spam_rate' });
    expect(second.remainingMs).toBeLessThan(30_000);

    const third=checkSpam(k,'m8') as { blocked: boolean; reason: string; remainingMs?: number };
    expect(third).toMatchObject({ blocked:true, reason:'spam_rate', remainingMs:30_000 });

    const muted=checkSpam(k,'new');
    expect(muted.blocked).toBe(true); expect((muted as any).reason).toBe('spam_muted');
  });

  it('async Redis state is read/written atomically when configured and available', async () => {
    process.env.REDIS_URL = 'redis://security-test';
    mockRedisAvailable.mockReturnValue(true);
    const key='security:spam:redis-user';
    mockStore.set(key, JSON.stringify({ messages:[{content:'a',ts:Date.now()}], warned:false, muteUntil:0 }));
    expect((await checkSpamAsync('redis-user','b')).blocked).toBe(false);
    expect(mockClient.get).toHaveBeenCalledWith(key);
    expect(mockClient.set).toHaveBeenCalledWith(key, expect.any(String), expect.objectContaining({EX:expect.any(Number)}));
  });

  it('configured Redis failure is fail-closed instead of diluting spam state per node', async () => {
    process.env.REDIS_URL = 'redis://security-test';
    mockRedisAvailable.mockReturnValue(true);
    mockClient.get.mockRejectedValueOnce(new Error('redis down'));
    await expect(checkSpamAsync('redis-fail-'+Math.random(),'hello')).rejects.toThrow('redis down');
  });

  it('rejects malformed persisted spam state instead of silently resetting it', async () => {
    process.env.REDIS_URL = 'redis://security-test';
    mockRedisAvailable.mockReturnValue(true);
    mockStore.set('security:spam:corrupt', JSON.stringify({ messages: 'bad', warned: false, muteUntil: 0 }));
    await expect(checkSpamAsync('corrupt', 'hello')).rejects.toThrow(/Corrupt spam security state/);
  });
});

describe('CSRF backing store and expiry', () => {
  it('fallback token is user-bound, format-checked and valid', async () => {
    const token=await generateCsrfToken('csrf-u1');
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(await verifyCsrfToken('csrf-u1',token)).toBe(true);
    expect(await verifyCsrfToken('csrf-u2',token)).toBe(false);
    expect(await verifyCsrfToken('',token)).toBe(false);
    expect(await verifyCsrfToken('csrf-u1','bad')).toBe(false);
  });

  it('Redis-backed token verifies from stored expiry', async () => {
    process.env.REDIS_URL = 'redis://security-test';
    mockRedisAvailable.mockReturnValue(true);
    const token=await generateCsrfToken('redis-csrf');
    expect(mockClient.set).toHaveBeenCalled();
    expect(await verifyCsrfToken('redis-csrf',token)).toBe(true);
  });

  it('expired Redis record is rejected', async () => {
    process.env.REDIS_URL = 'redis://security-test';
    mockRedisAvailable.mockReturnValue(true);
    const token='a'.repeat(64);
    mockStore.set(`security:csrf:u:${token}`,JSON.stringify({expiresAt:Date.now()-1}));
    expect(await verifyCsrfToken('u',token)).toBe(false);
  });

  it('configured Redis never resurrects a prior process-local CSRF token', async () => {
    const localToken = await generateCsrfToken('csrf-authority-switch');
    expect(await verifyCsrfToken('csrf-authority-switch', localToken)).toBe(true);

    process.env.REDIS_URL = 'redis://security-test';
    mockRedisAvailable.mockReturnValue(true);
    // Redis has no corresponding key. Its negative lookup is authoritative;
    // the old local token must not remain valid on only this worker.
    expect(await verifyCsrfToken('csrf-authority-switch', localToken)).toBe(false);
  });

  it('configured Redis outage fails closed for CSRF mint and verification', async () => {
    process.env.REDIS_URL = 'redis://security-test';
    mockRedisAvailable.mockReturnValue(false);
    await expect(generateCsrfToken('redis-down')).rejects.toThrow(/Redis security state unavailable/);
    await expect(verifyCsrfToken('redis-down', 'a'.repeat(64))).rejects.toThrow(/Redis security state unavailable/);
  });
});

describe('progressive rate limit state machine', () => {
  it('sync escalates and subsequent call observes active ban', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const k='sync-'+Math.random();
    expect(progressiveRateLimit(k,2,1000)).toEqual({blocked:false});
    expect(progressiveRateLimit(k,2,1000)).toEqual({blocked:false});
    const third=progressiveRateLimit(k,2,1000) as any;
    expect(third.blocked).toBe(true); expect(third.violations).toBe(1);
    expect((progressiveRateLimit(k,2,1000) as any).bannedUntil).toBe(third.bannedUntil);
  });

  it('async Redis path serializes, persists state and enforces stored ban', async () => {
    process.env.REDIS_URL = 'redis://security-test';
    mockRedisAvailable.mockReturnValue(true);
    const k='async-user', rk=`security:violation:${k}`;
    expect((await progressiveRateLimitAsync(k,1,1000)).blocked).toBe(false);
    expect((await progressiveRateLimitAsync(k,1,1000)).blocked).toBe(true);
    const state=JSON.parse(mockStore.get(rk)!);
    expect(state.violations).toBe(1);
    expect((await progressiveRateLimitAsync(k,1,1000)).blocked).toBe(true);
  });

  it('configured Redis failure is fail-closed for progressive limits', async () => {
    process.env.REDIS_URL = 'redis://security-test';
    mockRedisAvailable.mockReturnValue(true);
    mockClient.get.mockRejectedValueOnce(new Error('down'));
    await expect(progressiveRateLimitAsync('redis-down-'+Math.random(),10,1000)).rejects.toThrow('down');
  });

  it.each([[0, 1000], [1.5, 1000], [1, 0], [1, 1.5], [Number.MAX_SAFE_INTEGER + 1, 1]])
  ('rejects malformed limiter bounds max=%s window=%s', async (max, windowMs) => {
    await expect(progressiveRateLimitAsync('bad-bounds', max, windowMs)).rejects.toThrow(RangeError);
  });

  it('rejects malformed persisted limiter state', async () => {
    process.env.REDIS_URL = 'redis://security-test';
    mockRedisAvailable.mockReturnValue(true);
    mockStore.set('security:violation:corrupt-limit', JSON.stringify({ hits: ['bad'], violations: 0, bannedUntil: 0 }));
    await expect(progressiveRateLimitAsync('corrupt-limit', 2, 1000)).rejects.toThrow(/Corrupt progressive rate-limit state/);
  });
});

describe('security headers', () => {
  it('sets browser security policies and calls next', () => {
    const setHeader=jest.fn(), next=jest.fn();
    securityHeaders({} as any,{setHeader} as any,next);
    expect(setHeader).toHaveBeenCalledWith('X-Content-Type-Options','nosniff');
    expect(setHeader).toHaveBeenCalledWith('X-Frame-Options','DENY');
    expect(setHeader).toHaveBeenCalledWith('Permissions-Policy','camera=(self), microphone=(self), geolocation=()');
    expect(next).toHaveBeenCalledTimes(1);
  });
});
