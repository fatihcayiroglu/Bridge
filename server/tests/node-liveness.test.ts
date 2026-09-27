// server/tests/node-liveness.test.ts — per-process liveness lease (P1 multi-node).

describe('node liveness lease', () => {
  const saved = { REDIS_URL: process.env.REDIS_URL, INSTANCE_ID: process.env.INSTANCE_ID };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    jest.resetModules();
    jest.useRealTimers();
  });

  function load(store: Map<string, unknown>, setAuthoritative = jest.fn(async (k: string, v: unknown) => { store.set(k, v); })) {
    jest.doMock('../lib/redisAdapter', () => ({
      cache: { setAuthoritative, getAuthoritative: async (k: string) => (store.has(k) ? store.get(k) : null) },
    }));
    jest.doMock('../lib/logger', () => ({ __esModule: true, default: { warn: jest.fn() } }));
    return { mod: require('../lib/nodeLiveness') as typeof import('../lib/nodeLiveness'), setAuthoritative };
  }

  it('renews a 30 s lease every 10 s and reports peers by their lease', async () => {
    jest.useFakeTimers();
    process.env.REDIS_URL = 'redis://cluster.test';
    process.env.INSTANCE_ID = 'node-a';
    const store = new Map<string, unknown>();
    const { mod, setAuthoritative } = load(store);
    mod.startNodeLiveness();
    await jest.advanceTimersByTimeAsync(20_000);
    expect(setAuthoritative).toHaveBeenCalledWith('node:alive:node-a', expect.any(Number), 30);
    expect(setAuthoritative.mock.calls.length).toBeGreaterThanOrEqual(3);
    mod.stopNodeLiveness();

    expect(await mod.isNodeAlive('node-a')).toBe(true);
    store.set('node:alive:node-b', 1);
    expect(await mod.isNodeAlive('node-b')).toBe(true);
    // negative control: a node whose lease expired
    expect(await mod.isNodeAlive('node-dead')).toBe(false);
  });

  it('a deliberately single-node deployment runs no lease and treats every node as alive', async () => {
    delete process.env.REDIS_URL;
    const { mod, setAuthoritative } = load(new Map());
    mod.startNodeLiveness();
    expect(setAuthoritative).not.toHaveBeenCalled();
    expect(await mod.isNodeAlive('anything')).toBe(true);
  });
});

export {};
