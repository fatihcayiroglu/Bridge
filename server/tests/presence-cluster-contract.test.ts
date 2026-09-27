describe('presence cluster ownership contract', () => {
  const runLock = async (_key: string, fn: () => Promise<unknown>) => fn();
  const previousRedisUrl = process.env.REDIS_URL;

  beforeEach(() => {
    // presenceCache owns a process-lifetime Redis heartbeat. Keep each isolated
    // module instance on fake timers so resetModules cannot orphan that interval.
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.resetModules();
    if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousRedisUrl;
    jest.clearAllMocks();
  });

  // P1 multi-node ND-07: a user whose sockets all belonged to a dead node was
  // never re-examined and stayed online forever.
  it('the stale-presence reaper performs the offline transition once, and a reconnect in between wins', async () => {
    process.env.REDIS_URL = 'redis://cluster.test';
    const luaEval = jest.fn();
    jest.doMock('../lib/redisAdapter', () => ({
      cache: { withKeyLock: runLock, luaEval, luaEvalAuthoritative: luaEval,
        get: jest.fn().mockResolvedValue(null), getAuthoritative: jest.fn().mockResolvedValue('visible'),
        set: jest.fn(), setAuthoritative: jest.fn(), del: jest.fn(), delAuthoritative: jest.fn().mockResolvedValue(undefined) },
      subscribeToChannel: jest.fn().mockResolvedValue(null),
      publishToChannel: jest.fn().mockResolvedValue(undefined),
    }));
    jest.doMock('../lib/logger', () => ({ debug: jest.fn(), warn: jest.fn(), info: jest.fn() }));
    const presence = require('../lib/presenceCache');
    const onExpired = jest.fn(async () => undefined);

    luaEval
      .mockResolvedValueOnce(['dead-node-user', 'reconnected-user']) // candidates
      .mockResolvedValueOnce(1)   // dead-node-user: this caller won the transition
      .mockResolvedValueOnce(1)   // reconnected-user: won too...
      .mockResolvedValueOnce(0)   // re-check dead-node-user: no live socket
      .mockResolvedValueOnce(1);  // re-check reconnected-user: reconnected meanwhile
    presence.startPresenceReaper(onExpired, 1_000);
    await jest.advanceTimersByTimeAsync(1_000);
    presence.stopPresenceReaper();

    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(onExpired).toHaveBeenCalledWith('dead-node-user');
  });

  it('does not persist a false global offline when another node still owns a socket', async () => {
    process.env.REDIS_URL = 'redis://cluster.test';
    const luaEval = jest.fn()
      .mockResolvedValueOnce(2) // track: two sockets cluster-wide
      .mockResolvedValueOnce(1); // release: remote socket remains
    const get = jest.fn().mockResolvedValue(null);
    const set = jest.fn().mockResolvedValue(undefined);
    const del = jest.fn().mockResolvedValue(undefined);
    jest.doMock('../lib/redisAdapter', () => ({
      cache: { withKeyLock: runLock,
        luaEval, luaEvalAuthoritative: luaEval, get, getAuthoritative: get,
        set, setAuthoritative: set, del, delAuthoritative: del,
      },
      subscribeToChannel: jest.fn().mockResolvedValue(null),
      publishToChannel: jest.fn().mockResolvedValue(undefined),
    }));
    jest.doMock('../lib/logger', () => ({ debug: jest.fn(), warn: jest.fn() }));

    const presence = require('../lib/presenceCache');
    expect(await presence.trackSocket('u1', 'local-socket')).toBe(2);
    del.mockClear();
    expect(await presence.releaseSocket('u1', 'local-socket')).toBe(1);
    expect(set).not.toHaveBeenCalledWith(expect.stringContaining('manual_offline'), 1, 0);
  });

  it('fails closed instead of returning zero when Redis ownership cannot be read on disconnect', async () => {
    process.env.REDIS_URL = 'redis://cluster.test';
    const luaEval = jest.fn()
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error('redis down'));
    jest.doMock('../lib/redisAdapter', () => ({
      cache: (() => {
        const get = jest.fn().mockResolvedValue(null), set = jest.fn().mockResolvedValue(undefined), del = jest.fn().mockResolvedValue(undefined);
        return { withKeyLock: runLock, luaEval, luaEvalAuthoritative: luaEval, get, getAuthoritative:get, set, setAuthoritative:set, del, delAuthoritative:del };
      })(),
      subscribeToChannel: jest.fn().mockResolvedValue(null),
      publishToChannel: jest.fn().mockResolvedValue(undefined),
    }));
    jest.doMock('../lib/logger', () => ({ debug: jest.fn(), warn: jest.fn() }));

    const presence = require('../lib/presenceCache');
    await presence.trackSocket('u2', 's2');
    expect(await presence.releaseSocket('u2', 's2')).toBe(1);
  });

  it('uses shared live-socket count rather than a process-local socket as cluster truth', async () => {
    process.env.REDIS_URL = 'redis://cluster.test';
    const luaEval = jest.fn().mockResolvedValue(0);
    const get = jest.fn().mockResolvedValue('visible');
    jest.doMock('../lib/redisAdapter', () => ({
      cache: { withKeyLock: runLock, luaEval, luaEvalAuthoritative:luaEval, get, getAuthoritative:get, set: jest.fn(), setAuthoritative:jest.fn(), del: jest.fn(), delAuthoritative:jest.fn() },
      subscribeToChannel: jest.fn().mockResolvedValue(null),
      publishToChannel: jest.fn().mockResolvedValue(undefined),
    }));
    jest.doMock('../lib/logger', () => ({ debug: jest.fn(), warn: jest.fn() }));

    const presence = require('../lib/presenceCache');
    expect(await presence.isUserOnline('remote')).toBe(false);
    expect(luaEval).toHaveBeenCalled();
  });

  it('fails closed and rolls back local registration when shared ownership cannot be established', async () => {
    process.env.REDIS_URL = 'redis://cluster.test';
    const luaEval = jest.fn().mockRejectedValue(new Error('redis down'));
    const get = jest.fn().mockResolvedValue(null), set = jest.fn(), del = jest.fn();
    jest.doMock('../lib/redisAdapter', () => ({
      cache: { withKeyLock: runLock, luaEvalAuthoritative:luaEval, getAuthoritative:get, setAuthoritative:set, delAuthoritative:del },
      subscribeToChannel: jest.fn().mockResolvedValue(null), publishToChannel: jest.fn().mockResolvedValue(undefined),
    }));
    jest.doMock('../lib/logger', () => ({ debug: jest.fn(), warn: jest.fn() }));
    const presence = require('../lib/presenceCache');
    await expect(presence.trackSocket('u-fail', 's-fail')).rejects.toThrow('redis down');
    expect(presence.socketCount('u-fail')).toBe(0);
  });

  it('keeps a successfully claimed socket when only the legacy online heartbeat write fails', async () => {
    process.env.REDIS_URL = 'redis://cluster.test';
    const luaEval = jest.fn().mockResolvedValue(1);
    const get = jest.fn().mockResolvedValue(null);
    const set = jest.fn()
      .mockResolvedValueOnce(undefined) // explicit visibility authority
      .mockRejectedValueOnce(new Error('legacy key unavailable'));
    const del = jest.fn().mockResolvedValue(undefined);
    jest.doMock('../lib/redisAdapter', () => ({
      cache: { withKeyLock: runLock, luaEvalAuthoritative:luaEval, getAuthoritative:get, setAuthoritative:set, delAuthoritative:del },
      subscribeToChannel: jest.fn().mockResolvedValue(null), publishToChannel: jest.fn().mockResolvedValue(undefined),
    }));
    jest.doMock('../lib/logger', () => ({ debug: jest.fn(), warn: jest.fn() }));

    const presence = require('../lib/presenceCache');
    await expect(presence.trackSocket('u-claimed', 's-claimed')).resolves.toBe(1);
    expect(presence.socketCount('u-claimed')).toBe(1);
  });

  it('reports authoritative zero even if compatibility heartbeat cleanup fails afterward', async () => {
    process.env.REDIS_URL = 'redis://cluster.test';
    const luaEval = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const get = jest.fn().mockResolvedValue(null);
    const set = jest.fn().mockResolvedValue(undefined);
    const del = jest.fn()
      .mockResolvedValueOnce(undefined) // markOnline manual-offline cleanup
      .mockRejectedValueOnce(new Error('legacy cleanup unavailable'));
    const publish = jest.fn().mockResolvedValue(undefined);
    jest.doMock('../lib/redisAdapter', () => ({
      cache: { withKeyLock: runLock, luaEvalAuthoritative:luaEval, getAuthoritative:get, setAuthoritative:set, delAuthoritative:del },
      subscribeToChannel: jest.fn().mockResolvedValue(null), publishToChannel: publish,
    }));
    jest.doMock('../lib/logger', () => ({ debug: jest.fn(), warn: jest.fn() }));

    const presence = require('../lib/presenceCache');
    await presence.trackSocket('u-release', 's-release');
    await expect(presence.releaseSocket('u-release', 's-release')).resolves.toBe(0);
    expect(publish).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('presence:left'));
  });

  it('does not mutate local hidden state before Redis accepts a hide transition', async () => {
    process.env.REDIS_URL = 'redis://cluster.test';
    const set = jest.fn().mockRejectedValue(new Error('redis down'));
    const get = jest.fn().mockResolvedValue('visible');
    jest.doMock('../lib/redisAdapter', () => ({
      cache: { withKeyLock: runLock, setAuthoritative:set, getAuthoritative:get },
      subscribeToChannel: jest.fn().mockResolvedValue(null), publishToChannel: jest.fn().mockResolvedValue(undefined),
    }));
    jest.doMock('../lib/logger', () => ({ debug: jest.fn(), warn: jest.fn() }));

    const presence = require('../lib/presenceCache');
    await expect(presence.setPresenceVisibility('u-hide-order', false)).rejects.toThrow('redis down');
    await expect(presence.isPresenceVisible('u-hide-order')).resolves.toBe(true);
    expect(get).toHaveBeenCalledWith('presence:visibility:u-hide-order');
  });

  it('keeps the authoritative hidden state when an unhide write fails', async () => {
    process.env.REDIS_URL = 'redis://cluster.test';
    const set = jest.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('redis down'));
    const get = jest.fn().mockResolvedValue('hidden');
    jest.doMock('../lib/redisAdapter', () => ({
      cache: { withKeyLock: runLock, setAuthoritative:set, getAuthoritative:get },
      subscribeToChannel: jest.fn().mockResolvedValue(null), publishToChannel: jest.fn().mockResolvedValue(undefined),
    }));
    jest.doMock('../lib/logger', () => ({ debug: jest.fn(), warn: jest.fn() }));

    const presence = require('../lib/presenceCache');
    await presence.setPresenceVisibility('u-show-order', false);
    await expect(presence.setPresenceVisibility('u-show-order', true)).rejects.toThrow('redis down');
    await expect(presence.isPresenceVisible('u-show-order')).resolves.toBe(false);
    expect(get).toHaveBeenCalledWith('presence:visibility:u-show-order');
  });

  it('recovers missing explicit Redis visibility from durable DB truth under the authority lock', async () => {
    process.env.REDIS_URL = 'redis://cluster.test';
    const get = jest.fn().mockResolvedValue(null);
    const set = jest.fn().mockResolvedValue(undefined);
    jest.doMock('../lib/redisAdapter', () => ({
      cache: { withKeyLock: runLock, getAuthoritative:get, setAuthoritative:set },
      subscribeToChannel: jest.fn().mockResolvedValue(null), publishToChannel: jest.fn().mockResolvedValue(undefined),
    }));
    jest.doMock('../db/repositories', () => ({
      Users: { findById: jest.fn().mockResolvedValue({ presenceVisibility: 'visible' }) },
    }));
    jest.doMock('../lib/userUtils', () => ({
      normalizePresenceVisibility: (value: unknown) => value === 'visible' ? 'visible' : 'hidden',
    }));
    jest.doMock('../lib/logger', () => ({ debug: jest.fn(), warn: jest.fn() }));

    const presence = require('../lib/presenceCache');
    await expect(presence.isPresenceVisible('u-recover-visible')).resolves.toBe(true);
    expect(set).toHaveBeenCalledWith('presence:visibility:u-recover-visible', 'visible', 0);
  });

  it('fails closed when missing visibility authority cannot be recovered from durable DB truth', async () => {
    process.env.REDIS_URL = 'redis://cluster.test';
    const get = jest.fn().mockResolvedValue(null);
    jest.doMock('../lib/redisAdapter', () => ({
      cache: { withKeyLock: runLock, getAuthoritative:get, setAuthoritative:jest.fn() },
      subscribeToChannel: jest.fn().mockResolvedValue(null), publishToChannel: jest.fn().mockResolvedValue(undefined),
    }));
    jest.doMock('../db/repositories', () => ({
      Users: { findById: jest.fn().mockRejectedValue(new Error('db down')) },
    }));
    jest.doMock('../lib/userUtils', () => ({
      normalizePresenceVisibility: (value: unknown) => value === 'visible' ? 'visible' : 'hidden',
    }));
    jest.doMock('../lib/logger', () => ({ debug: jest.fn(), warn: jest.fn() }));

    const presence = require('../lib/presenceCache');
    await expect(presence.isPresenceVisible('u-recover-fail')).resolves.toBe(false);
  });

});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
