process.env.NODE_ENV = 'test';

describe('BotMarketplaceRepository pool resolution', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../db/postgres/pool');
  });

  it('uses an exported getPool factory when a direct pool export is absent', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ c: '4' }] });
    jest.doMock('../db/postgres/pool', () => ({
      getPool: () => ({ query }),
      getClient: jest.fn(),
    }));
    const { BotMarketplace } = await import('../db/repositories/BotMarketplaceRepository');
    await expect(BotMarketplace.count()).resolves.toBe(4);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('uses a default pool export and rejects an absent PostgreSQL pool', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ category: 'utility' }] });
    jest.doMock('../db/postgres/pool', () => ({
      __esModule: true,
      default: { query },
      getClient: jest.fn(),
    }));
    let module = await import('../db/repositories/BotMarketplaceRepository');
    await expect(module.BotMarketplace.getCategories()).resolves.toEqual(['utility']);

    jest.resetModules();
    jest.doMock('../db/postgres/pool', () => ({ __esModule: true, getClient: jest.fn() }));
    module = await import('../db/repositories/BotMarketplaceRepository');
    await expect(module.BotMarketplace.count()).rejects.toThrow('PostgreSQL pool is not available');
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
