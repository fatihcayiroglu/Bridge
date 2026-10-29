const mockPub = { connect: jest.fn(async () => undefined), quit: jest.fn(async () => undefined),
  on: jest.fn(), duplicate: jest.fn() };
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
