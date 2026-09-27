describe('permission cache cluster safety', () => {
  const previous = process.env.REDIS_URL;
  afterEach(() => {
    jest.resetModules();
    if (previous === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previous;
  });

  it('does not reuse process-local authorization state when shared cluster authority is configured', async () => {
    process.env.REDIS_URL = 'redis://cluster.test';
    const { getCachedPerms } = require('../lib/permCache');
    const resolve = jest.fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);

    await expect(getCachedPerms('u', 's', resolve, 'c')).resolves.toBe(1);
    await expect(getCachedPerms('u', 's', resolve, 'c')).resolves.toBe(0);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('retains the bounded local cache in explicit single-node mode', async () => {
    delete process.env.REDIS_URL;
    const { getCachedPerms } = require('../lib/permCache');
    const resolve = jest.fn().mockResolvedValue(123);
    await expect(getCachedPerms('u', 's', resolve, 'c')).resolves.toBe(123);
    await expect(getCachedPerms('u', 's', resolve, 'c')).resolves.toBe(123);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
