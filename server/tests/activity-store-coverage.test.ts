process.env.NODE_ENV = 'test';

type MockRedis = {
  available: boolean;
  cache: {
    getAuthoritative: jest.Mock;
    setAuthoritative: jest.Mock;
    delAuthoritative: jest.Mock;
    withKeyLock: jest.Mock;
  };
  logger: { warn: jest.Mock };
};

const ORIGINAL_REDIS = process.env.REDIS_URL;

afterAll(() => {
  if (ORIGINAL_REDIS === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = ORIGINAL_REDIS;
});

function loadStore(configured: boolean, available = false): { store: typeof import('../socket/handlers/activity-store').activityStore; mocks: MockRedis } {
  jest.resetModules();
  if (configured) process.env.REDIS_URL = 'redis://configured.test:6379';
  else delete process.env.REDIS_URL;

  const mocks: MockRedis = {
    available,
    cache: {
      getAuthoritative: jest.fn(),
      setAuthoritative: jest.fn(),
      delAuthoritative: jest.fn(),
      withKeyLock: jest.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
    },
    logger: { warn: jest.fn() },
  };
  jest.doMock('../lib/redisAdapter', () => ({
    cache: mocks.cache,
    isRedisAvailable: () => mocks.available,
  }));
  jest.doMock('../lib/logger', () => ({ __esModule: true, default: mocks.logger }));
  return { store: require('../socket/handlers/activity-store').activityStore, mocks };
}

function session(channelId = 'channel-1') {
  return {
    activityId: 'chess', channelId, serverId: 'server-1', hostUserId: 'user-1',
    participants: new Set(['user-1', 'user-2']), startedAt: 123, sessionId: 'session-1',
  };
}

describe('activityStore authoritative/local behavior', () => {
  test('intentional single-node mode stores, reads and deletes local session identity', async () => {
    const { store } = loadStore(false, false);
    store._localSessions_TEST_ONLY.clear();
    const value = session();
    await store.set('channel-1', value);
    expect(await store.get('channel-1')).toBe(value);
    await store.del('channel-1');
    expect(await store.get('channel-1')).toBeNull();
  });

  test('local set rejects a mismatched channel before any mutation', async () => {
    const { store } = loadStore(false, false);
    store._localSessions_TEST_ONLY.clear();
    await expect(store.set('other', session('channel-1'))).rejects.toThrow(/mismatch/i);
    expect(store._localSessions_TEST_ONLY.size).toBe(0);
  });

  test('configured Redis unavailable fails closed for get/set/delete', async () => {
    const { store } = loadStore(true, false);
    await expect(store.get('channel-1')).rejects.toThrow(/coordination unavailable.*get/i);
    await expect(store.set('channel-1', session())).rejects.toThrow(/coordination unavailable.*set/i);
    await expect(store.del('channel-1')).rejects.toThrow(/coordination unavailable.*delete/i);
  });

  test('Redis path serializes Set participants, decodes a valid record and deletes by canonical key', async () => {
    const { store, mocks } = loadStore(true, true);
    mocks.cache.getAuthoritative.mockResolvedValueOnce({
      activityId: 'poker', channelId: 'channel-1', serverId: 'server-1', hostUserId: 'host',
      participants: ['host', 'guest'], startedAt: 0, sessionId: 'sid',
    });
    const got = await store.get('channel-1');
    expect(got).toMatchObject({ activityId: 'poker', channelId: 'channel-1', startedAt: 0 });
    expect(got?.participants).toEqual(new Set(['host', 'guest']));

    await store.set('channel-1', session());
    expect(mocks.cache.setAuthoritative).toHaveBeenCalledWith(
      'activity:session:channel-1',
      expect.objectContaining({ participants: ['user-1', 'user-2'] }),
      6 * 60 * 60,
    );
    await store.del('channel-1');
    expect(mocks.cache.delAuthoritative).toHaveBeenCalledWith('activity:session:channel-1');
  });

  test('Redis null maps to no session while impossible undefined state fails closed', async () => {
    const { store, mocks } = loadStore(true, true);
    mocks.cache.getAuthoritative.mockResolvedValueOnce(null).mockResolvedValueOnce(undefined);
    expect(await store.get('channel-1')).toBeNull();
    await expect(store.get('channel-1')).rejects.toThrow(/invalid persisted activity session/i);
  });

  test.each([
    ['bad', 'primitive'],
    [{ channelId: 'other', activityId: 'x', serverId: 's', hostUserId: 'h', sessionId: 'id', participants: [], startedAt: 1 }, 'channel mismatch'],
    [{ channelId: 'channel-1', activityId: '', serverId: 's', hostUserId: 'h', sessionId: 'id', participants: [], startedAt: 1 }, 'empty activity'],
    [{ channelId: 'channel-1', activityId: 'x', serverId: '', hostUserId: 'h', sessionId: 'id', participants: [], startedAt: 1 }, 'empty server'],
    [{ channelId: 'channel-1', activityId: 'x', serverId: 's', hostUserId: '', sessionId: 'id', participants: [], startedAt: 1 }, 'empty host'],
    [{ channelId: 'channel-1', activityId: 'x', serverId: 's', hostUserId: 'h', sessionId: '', participants: [], startedAt: 1 }, 'empty session id'],
    [{ channelId: 'channel-1', activityId: 'x', serverId: 's', hostUserId: 'h', sessionId: 'id', participants: 'u', startedAt: 1 }, 'participants not array'],
    [{ channelId: 'channel-1', activityId: 'x', serverId: 's', hostUserId: 'h', sessionId: 'id', participants: [''], startedAt: 1 }, 'empty participant'],
    [{ channelId: 'channel-1', activityId: 'x', serverId: 's', hostUserId: 'h', sessionId: 'id', participants: [7], startedAt: 1 }, 'nonstring participant'],
    [{ channelId: 'channel-1', activityId: 'x', serverId: 's', hostUserId: 'h', sessionId: 'id', participants: [], startedAt: -1 }, 'negative time'],
    [{ channelId: 'channel-1', activityId: 'x', serverId: 's', hostUserId: 'h', sessionId: 'id', participants: [], startedAt: 1.5 }, 'noninteger time'],
    [{ channelId: 'channel-1', activityId: 'x', serverId: 's', hostUserId: 'h', sessionId: 'id', participants: [], startedAt: Number.MAX_SAFE_INTEGER + 1 }, 'unsafe time'],
  ] as Array<[unknown, string]>)('corrupt authoritative state fails closed: %s (%s)', async (raw) => {
    const { store, mocks } = loadStore(true, true);
    mocks.cache.getAuthoritative.mockResolvedValueOnce(raw);
    await expect(store.get('channel-1')).rejects.toThrow(/invalid persisted activity session/i);
  });

  test('configured Redis transport errors are logged and propagated for every authority operation', async () => {
    const { store, mocks } = loadStore(true, true);
    mocks.cache.getAuthoritative.mockRejectedValueOnce(new Error('get down'));
    mocks.cache.setAuthoritative.mockRejectedValueOnce(new Error('set down'));
    mocks.cache.delAuthoritative.mockRejectedValueOnce(new Error('del down'));
    await expect(store.get('c')).rejects.toThrow('get down');
    await expect(store.set('c', session('c'))).rejects.toThrow('set down');
    await expect(store.del('c')).rejects.toThrow('del down');
    expect(mocks.logger.warn).toHaveBeenCalledTimes(3);
  });

  test('unconfigured transient Redis failures degrade to the intentional local store', async () => {
    const { store, mocks } = loadStore(false, true);
    store._localSessions_TEST_ONLY.clear();
    const local = session('c');
    store._localSessions_TEST_ONLY.set('c', local);
    mocks.cache.getAuthoritative.mockRejectedValueOnce(new Error('get down'));
    expect(await store.get('c')).toBe(local);
    mocks.cache.setAuthoritative.mockRejectedValueOnce(new Error('set down'));
    const newer = { ...local, sessionId: 'new' };
    await store.set('c', newer);
    expect(store._localSessions_TEST_ONLY.get('c')).toBe(newer);
    mocks.cache.delAuthoritative.mockRejectedValueOnce(new Error('del down'));
    await store.del('c');
    expect(store._localSessions_TEST_ONLY.has('c')).toBe(false);
  });

  test('withLock rejects malformed ids and delegates a bounded canonical lock', async () => {
    const { store, mocks } = loadStore(false, false);
    await expect(store.withLock('', async () => 1)).rejects.toThrow(/invalid activity channel/i);
    await expect(store.withLock('x'.repeat(257), async () => 1)).rejects.toThrow(/invalid activity channel/i);
    await expect(store.withLock('channel-1', async () => 42)).resolves.toBe(42);
    expect(mocks.cache.withKeyLock).toHaveBeenCalledWith(
      'activity-session:channel-1', expect.any(Function),
      { leaseSeconds: 5, waitMs: 2_000, retryMs: 10 },
    );
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
