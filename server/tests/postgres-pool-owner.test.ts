const mockPool = {
  on: jest.fn(),
  query: jest.fn(),
  connect: jest.fn(),
};
const mockPoolCtor = jest.fn((..._args: unknown[]) => mockPool);
const mockSetTypeParser = jest.fn((_oid: number, _parse: (value: string) => unknown) => undefined);
const mockLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };

// The double mirrors the part of `pg` the pool owner uses: `Pool` AND `types` (Final21 Faz 19 /
// 19-27: the owner registers the INT8 parser at import; a double without `types` made every
// import throw).
jest.mock('pg', () => ({
  Pool: function MockPool(...args: unknown[]) { return mockPoolCtor(...args); },
  types: { setTypeParser: (oid: number, parse: (value: string) => unknown) => mockSetTypeParser(oid, parse) },
}));
jest.mock('../lib/logger', () => ({ __esModule: true, default: mockLogger }));

const originalEnv = { ...process.env };

afterAll(() => { process.env = originalEnv; });

describe('PostgreSQL pool canonical owner', () => {
  beforeEach(() => {
    jest.resetModules(); jest.clearAllMocks();
    process.env = { ...originalEnv, DATABASE_URL: 'postgres://bridge@test/db', PG_POOL_MAX: '37', DATABASE_SSL: 'true' };
  });

  it('constructs the singleton with bounded configuration and logs idle pool errors structurally', () => {
    require('../db/postgres/pool');
    expect(mockPoolCtor).toHaveBeenCalledTimes(1);
    expect(mockPoolCtor).toHaveBeenCalledWith(expect.objectContaining({
      connectionString: 'postgres://bridge@test/db', max: 37,
      idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000,
      ssl: { rejectUnauthorized: false },
    }));
    const errorHandler = mockPool.on.mock.calls.find(call => call[0] === 'error')?.[1] as ((err: Error) => void) | undefined;
    expect(errorHandler).toBeDefined();
    errorHandler?.(new Error('socket reset'));
    expect(mockLogger.error).toHaveBeenCalledWith(
      { event: 'db.pool.error', message: 'socket reset' },
      expect.stringContaining('PostgreSQL pool'),
    );
  });

  it('registers the BIGINT (INT8, OID 20) parser before any query can run', () => {
    require('../db/postgres/pool');
    const int8 = mockSetTypeParser.mock.calls.filter(([oid]) => oid === 20);
    expect(int8).toHaveLength(1);
    const parse = int8[0]?.[1];
    expect(parse?.('1790328275717')).toBe(1790328275717);
    expect(parse?.('9007199254740993')).toBe('9007199254740993');
  });

  it('reports health latency on success and contains query errors without throwing', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    const now = jest.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValueOnce(117);
    const mod = require('../db/postgres/pool') as typeof import('../db/postgres/pool');
    await expect(mod.checkPoolHealth()).resolves.toEqual({ ok: true, latencyMs: 17 });
    expect(mockPool.query).toHaveBeenCalledWith('SELECT 1');
    now.mockRestore();

    mockPool.query.mockRejectedValueOnce(new Error('db unavailable'));
    await expect(mod.checkPoolHealth()).resolves.toEqual({ ok: false, error: 'db unavailable' });
  });

  it('returns the real connected PoolClient and disables SSL when not requested', async () => {
    process.env.DATABASE_SSL = 'false';
    const client = { query: jest.fn(), release: jest.fn() };
    mockPool.connect.mockResolvedValueOnce(client);
    const mod = require('../db/postgres/pool') as typeof import('../db/postgres/pool');
    await expect(mod.getClient()).resolves.toBe(client);
    expect(mod.pool).toBe(mockPool);
    expect(mockPoolCtor).toHaveBeenCalledWith(expect.objectContaining({ ssl: false }));
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
