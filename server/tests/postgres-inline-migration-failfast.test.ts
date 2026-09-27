const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.mock('../lib/logger', () => ({ __esModule: true, default: logger }));

describe('PostgreSQL inline migration failure policy', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fails startup on a real migration defect instead of announcing a partial schema as ready', async () => {
    const { runInlineMigrations } = require('../db/postgres/migrations');
    const defect = new Error('function definitely_missing(jsonb) does not exist');
    const pool = { query: jest.fn().mockRejectedValueOnce(defect) };

    await expect(runInlineMigrations(pool)).rejects.toBe(defect);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'db.migration.failed', label: 'column-migration' }),
      expect.stringContaining('BAŞARISIZ'),
    );
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('continues an explicitly legacy missing-column backfill but then fails on a real defect', async () => {
    const { runInlineMigrations } = require('../db/postgres/migrations');
    const legacy = new Error('column "subscription" does not exist');
    const defect = new Error('type definitely_missing does not exist');
    const pool = {
      query: jest.fn()
        .mockRejectedValueOnce(legacy)
        .mockRejectedValueOnce(defect),
    };

    await expect(runInlineMigrations(pool)).rejects.toBe(defect);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'db.migration.skipped_legacy' }),
      expect.stringContaining('legacy'),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'db.migration.failed' }),
      expect.any(String),
    );
    expect(pool.query).toHaveBeenCalledTimes(2);
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
