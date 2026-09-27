describe('permission cache local-owner lifecycle', () => {
  const previous = process.env.REDIS_URL;

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    jest.resetModules();
    if (previous === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previous;
  });

  function localOwner() {
    delete process.env.REDIS_URL;
    jest.resetModules();
    return require('../lib/permCache') as typeof import('../lib/permCache');
  }

  it('keys server and channel permissions independently and caches only successful resolutions', async () => {
    const { getCachedPerms, _cacheSize } = localOwner();
    const resolve = jest.fn(async (_u: string, _s: string, c: string | null) => c ? 7 : 3);

    await expect(getCachedPerms('u1', 's1', resolve)).resolves.toBe(3);
    await expect(getCachedPerms('u1', 's1', resolve, 'c1')).resolves.toBe(7);
    await expect(getCachedPerms('u1', 's1', resolve)).resolves.toBe(3);
    await expect(getCachedPerms('u1', 's1', resolve, 'c1')).resolves.toBe(7);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(_cacheSize()).toBe(2);

    const failing = jest.fn().mockRejectedValue(new Error('repository down'));
    await expect(getCachedPerms('u2', 's1', failing)).rejects.toThrow('repository down');
    await expect(getCachedPerms('u2', 's1', failing)).rejects.toThrow('repository down');
    expect(failing).toHaveBeenCalledTimes(2);
    expect(_cacheSize()).toBe(2);
  });

  it('expires a local entry before reuse', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-31T00:00:00Z'));
    const { getCachedPerms } = localOwner();
    const resolve = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    await expect(getCachedPerms('u', 's', resolve, 'c')).resolves.toBe(1);
    jest.setSystemTime(new Date('2026-08-31T00:00:31Z'));
    await expect(getCachedPerms('u', 's', resolve, 'c')).resolves.toBe(2);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('invalidates the narrow channel, then user scope, then the whole server without touching peers', async () => {
    const { getCachedPerms, invalidatePerms, _cacheSize } = localOwner();
    const resolve = jest.fn(async (_u: string, _s: string, c: string | null) => c ? 10 : 20);

    await getCachedPerms('u1', 's1', resolve, 'c1');
    await getCachedPerms('u2', 's1', resolve, 'c1');
    await getCachedPerms('u1', 's1', resolve, 'c2');
    await getCachedPerms('u1', 's1', resolve);
    await getCachedPerms('u1', 's2', resolve, 'c1');
    expect(_cacheSize()).toBe(5);

    invalidatePerms('s1', null, 'c1');
    expect(_cacheSize()).toBe(3);

    invalidatePerms('s1', 'u1');
    expect(_cacheSize()).toBe(1);

    invalidatePerms('s2');
    expect(_cacheSize()).toBe(0);
  });

  it('bounds local memory by evicting the oldest ten percent before inserting at capacity', async () => {
    const { getCachedPerms, _cacheSize } = localOwner();
    const resolve = jest.fn(async () => 1);

    for (let i = 0; i < 50_000; i += 1) {
      await getCachedPerms(`u${i}`, 's', resolve);
    }
    expect(_cacheSize()).toBe(50_000);

    await getCachedPerms('overflow', 's', resolve);
    expect(_cacheSize()).toBe(45_001);
    expect(resolve).toHaveBeenCalledTimes(50_001);
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
