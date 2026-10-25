const mockPub = { connect: jest.fn(async () => undefined), quit: jest.fn(async () => undefined),
  on: jest.fn(), duplicate: jest.fn(), ping: jest.fn(async () => 'PONG'),
  set: jest.fn(async () => 'OK'), info: jest.fn(async () => 'used_memory_human:2M\r\n') };
const mockSub = { connect: jest.fn(async () => undefined), quit: jest.fn(async () => undefined), on: jest.fn() };
const mockCreateClient = jest.fn(() => mockPub);
const mockAdapter = {};
jest.mock('../lib/_optional-require', () => ({
  tryRequire: (name: string) => name === 'redis' ? { createClient: mockCreateClient }
    : name === '@socket.io/redis-adapter' ? { createAdapter: () => mockAdapter } : null,
}));

const originalRedisUrl = process.env.REDIS_URL;
beforeEach(() => {
  jest.clearAllMocks();
  mockPub.duplicate.mockReturnValue(mockSub);
});
afterEach(() => {
  if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = originalRedisUrl;
  jest.restoreAllMocks();
});

it.each([
  'redis://private-account:prefix@private-password-tail@private-cache.invalid:6379/4?private-query=private-value',
  'rediss://private-account:private-password%40private-tail@private-cache.invalid:6380/4',
  'redis://private-cache.invalid:6379/4?private-query=private-value',
])('does not publish Redis connection configuration through actual Pino: case %#', async redisUrl => {
  // A literal @ in a password is accepted by URL parsing; regex masking only
  // through its first @ can leave the remaining credential in public output.
  expect(new URL(redisUrl).hostname).toBe('private-cache.invalid');
  process.env.REDIS_URL = redisUrl;
  await jest.isolateModulesAsync(async () => {
    const { captureActualLogRecords } = require('./helpers/capture-actual-log-records') as
      typeof import('./helpers/capture-actual-log-records');
    const adapter = require('../lib/redisAdapter') as typeof import('../lib/redisAdapter');
    const capture = captureActualLogRecords();
    const io = { adapter: jest.fn() };
    try {
      await expect(adapter.applyAdapter(io)).resolves.toBe(true);
      // The actual transport configuration is preserved, including credentials.
      expect(mockCreateClient).toHaveBeenCalledWith(expect.objectContaining({ url: redisUrl }));
      expect(mockPub.connect).toHaveBeenCalledTimes(1);
      expect(mockSub.connect).toHaveBeenCalledTimes(1);
      expect(io.adapter).toHaveBeenCalledWith(mockAdapter);
      expect(adapter.isRedisAvailable()).toBe(true);
      const connected = capture.records.filter(row => row.event === 'redis.connected');
      expect(connected).toHaveLength(1);
      expect(connected[0]).toMatchObject({ level: 30, event: 'redis.connected' });
      expect(JSON.stringify(capture.records)).not.toContain('private-');
      expect(connected[0]).not.toHaveProperty('url');
    } finally {
      await adapter.disconnect();
      capture.restore();
    }
  });
});

export {};

it.each([
  'redis://private-account:prefix@private-password-tail@private-cache.invalid:6379/4?private-query=private-value',
  'rediss://private-account:private-password%40private-tail@private-cache.invalid:6380/4',
  'redis://private-cache.invalid:6379/4?private-query=private-value#private-fragment',
  'rediss://private-account:private-password@[2001:db8::42]:6380/4?private-query=private-value#private-fragment',
])('health metadata strips all credentials/query/fragment while preserving the write probe: case %#', async redisUrl => {
  process.env.REDIS_URL = redisUrl;
  await jest.isolateModulesAsync(async () => {
    const adapter = require('../lib/redisAdapter') as typeof import('../lib/redisAdapter');
    try {
      await expect(adapter.applyAdapter({})).resolves.toBe(true);
      const health = await adapter.healthCheck();
      expect(health).toMatchObject({ redis: true, mode: 'redis', usedMemory: '2M' });
      for (const secret of ['private-account', 'private-password', 'private-tail', 'private-query', 'private-value', 'private-fragment']) {
        expect(JSON.stringify(health)).not.toContain(secret);
      }
      const safe = new URL(health.url!);
      const configured = new URL(redisUrl);
      expect(safe.protocol).toBe(configured.protocol);
      expect(safe.host).toBe(configured.host);
      expect(safe.pathname).toBe(configured.pathname);
      expect(safe.password).toBe('');
      expect(safe.search).toBe('');
      expect(safe.hash).toBe('');
      expect(mockPub.set).toHaveBeenCalledWith(expect.stringMatching(/^bridge:health:write:/), expect.any(String), { EX: 60 });
      expect(mockCreateClient).toHaveBeenCalledWith(expect.objectContaining({ url: redisUrl }));
    } finally { await adapter.disconnect(); }
  });
});

it.each(['not-a-uri-private-secret', 'https://private-account:private-password@private-cache.invalid'])(
  'omits unparseable or unsupported health URL metadata: case %#', async redisUrl => {
    // A transport stub establishes the health formatter's defensive boundary;
    // this does not claim a real Redis client accepts either configuration.
    process.env.REDIS_URL = redisUrl;
    await jest.isolateModulesAsync(async () => {
      const adapter = require('../lib/redisAdapter') as typeof import('../lib/redisAdapter');
      try {
        await expect(adapter.applyAdapter({})).resolves.toBe(true);
        const health = await adapter.healthCheck();
        expect(health.redis).toBe(true);
        expect(health.url).toBeUndefined();
        expect(JSON.stringify(health)).not.toContain('private');
      } finally { await adapter.disconnect(); }
    });
  },
);
