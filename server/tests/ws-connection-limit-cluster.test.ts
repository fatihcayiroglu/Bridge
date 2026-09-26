// Cluster-active WebSocket quotas must be Redis-authoritative. These tests run
// the real middleware with only the Redis transport mocked, so the lease Lua
// contract and the internal auth transition remain executable behavior.

describe('WebSocket connection limits — Redis cluster leases', () => {
  const originalRedisUrl = process.env.REDIS_URL;
  const originalInstance = process.env.INSTANCE_ID;
  const luaEvalAuthoritative = jest.fn<Promise<unknown>, [string, string[], string[]]>();

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    process.env.REDIS_URL = 'redis://cluster.example:6379';
    process.env.INSTANCE_ID = 'node-a';
    luaEvalAuthoritative.mockReset();
    jest.doMock('../lib/redisAdapter', () => ({ cache: { luaEvalAuthoritative } }));
    jest.doMock('../lib/logger', () => ({
      __esModule: true,
      createLogger: () => ({ warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() }),
      default: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() },
    }));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.dontMock('../lib/redisAdapter');
    jest.dontMock('../lib/logger');
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
    if (originalInstance === undefined) delete process.env.INSTANCE_ID;
    else process.env.INSTANCE_ID = originalInstance;
  });

  function makeSocket() {
    const onceHandlers = new Map<string, Function>();
    return {
      id: 'sock-redis-1',
      handshake: { address: '203.0.113.20', headers: {}, auth: { token: 'candidate-token' }, time: 1 },
      once: jest.fn((event: string, handler: Function) => { onceHandlers.set(event, handler); }),
      emit: jest.fn(),
      disconnect: jest.fn(),
      _onceHandlers: onceHandlers,
    };
  }

  async function load() {
    return (await import('../socket/middleware/wsConnectionLimit')).wsConnectionLimitMiddleware;
  }

  async function admit(middleware: Function, socket: ReturnType<typeof makeSocket>) {
    return await new Promise<Error | null>((resolve) => {
      middleware({ sockets: { sockets: new Map() } } as never)(socket as never, (err?: Error) => resolve(err ?? null));
    });
  }

  test('claims both total-IP and pre-auth scopes before the next middleware runs', async () => {
    luaEvalAuthoritative.mockResolvedValueOnce(['ok', '1', '1']);
    const middleware = await load();
    const socket = makeSocket();
    await expect(admit(middleware, socket)).resolves.toBeNull();

    expect(luaEvalAuthoritative).toHaveBeenCalledTimes(1);
    expect(luaEvalAuthoritative.mock.calls[0][1]).toEqual([
      'bridge:ws-limit:ip-total:203.0.113.20',
      'bridge:ws-limit:ip-unauth:203.0.113.20',
    ]);
    expect(typeof (socket as any)._bridgeMarkAuthenticated).toBe('function');
    expect(typeof (socket as any)._bridgeReleaseConnectionLimit).toBe('function');
  });

  test('global per-user overflow returns false and releases the pre-auth lease', async () => {
    luaEvalAuthoritative
      .mockResolvedValueOnce(['ok', '1', '1'])
      .mockResolvedValueOnce(['user', '5'])
      .mockResolvedValueOnce(1);
    const middleware = await load();
    const socket = makeSocket();
    await expect(admit(middleware, socket)).resolves.toBeNull();

    await expect((socket as any)._bridgeMarkAuthenticated('u1')).resolves.toBe(false);
    expect(luaEvalAuthoritative.mock.calls[1][1]).toContain('bridge:ws-limit:user:u1');
    expect(luaEvalAuthoritative.mock.calls[2][0]).toContain("ZREM");
  });

  test('configured Redis authority failure rejects the handshake instead of using worker-local counters', async () => {
    luaEvalAuthoritative.mockRejectedValueOnce(new Error('redis unavailable'));
    const middleware = await load();
    const socket = makeSocket();
    const err = await admit(middleware, socket);
    expect(err?.message).toBe('CONNECTION_LIMIT_UNAVAILABLE');
  });

  test('explicit release removes the shared reservation even when Socket.IO never emits disconnect', async () => {
    luaEvalAuthoritative.mockResolvedValueOnce(['ok', '1', '1']).mockResolvedValueOnce(1);
    const middleware = await load();
    const socket = makeSocket();
    await expect(admit(middleware, socket)).resolves.toBeNull();

    await (socket as any)._bridgeReleaseConnectionLimit();
    expect(luaEvalAuthoritative).toHaveBeenCalledTimes(2);
    expect(luaEvalAuthoritative.mock.calls[1][1]).toEqual([
      'bridge:ws-limit:ip-total:203.0.113.20',
      'bridge:ws-limit:ip-unauth:203.0.113.20',
    ]);
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
