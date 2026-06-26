// server/tests/embedHistory.test.ts
// Sprint 113 — pgvector Faz 2: embedHistory job birim testleri
// Test framework: Jest 29 (ts-jest) — projeyle tutarlı

import { runEmbedHistoryJob, scheduleEmbedHistoryJob, cancelEmbedHistoryJob } from '../jobs/embedHistory';

// ── Mock'lar ─────────────────────────────────────────────────────────────

jest.mock('../lib/pgvector', () => ({
  PGVECTOR_ENABLED: true,
  generateEmbedding: jest.fn(),
}));

jest.mock('../lib/logger', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { __esModule: true, default: logger, ...logger };
});

import { generateEmbedding } from '../lib/pgvector';
const mockGenerateEmbedding = generateEmbedding as jest.MockedFunction<typeof generateEmbedding>;

// ── Mock DB ───────────────────────────────────────────────────────────────

function makeMockDb(rows: { _id: string; content: string }[][] = []) {
  let callCount = 0;
  return {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('SELECT _id')) {
        const batch = rows[callCount++] ?? [];
        return { rows: batch };
      }
      return { rows: [] }; // UPDATE
    }),
  };
}

// ── Testler ───────────────────────────────────────────────────────────────

describe('runEmbedHistoryJob — temel çalışma', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('embed edilecek mesaj yoksa sıfır stat döner', async () => {
    const db = makeMockDb([[]] as { _id: string; content: string }[][]);
    const stats = await runEmbedHistoryJob(db);
    expect(stats.embedded).toBe(0);
    expect(stats.processed).toBe(0);
    expect(stats.failed).toBe(0);
  });

  it('mesajları embed eder ve istatistik döner', async () => {
    const rows = [
      { _id: 'm1', content: 'Merhaba dünya' },
      { _id: 'm2', content: 'Test mesaj' },
    ];
    const db = makeMockDb([rows, []]); // ikinci batch boş → döngü biter
    mockGenerateEmbedding.mockResolvedValue(new Array(768).fill(0.1));

    const stats = await runEmbedHistoryJob(db, { batchDelayMs: 0 });
    expect(stats.processed).toBe(2);
    expect(stats.embedded).toBe(2);
    expect(stats.failed).toBe(0);
  });

  it('generateEmbedding hata verirse failed artar', async () => {
    const rows = [{ _id: 'm1', content: 'Hata mesajı' }];
    const db = makeMockDb([rows, []]);
    mockGenerateEmbedding.mockRejectedValue(new Error('API hatası'));

    const stats = await runEmbedHistoryJob(db, { batchDelayMs: 0 });
    expect(stats.failed).toBe(1);
    expect(stats.embedded).toBe(0);
  });

  it('generateEmbedding null dönerse skipped artar', async () => {
    const rows = [{ _id: 'm1', content: 'Boş embedding' }];
    const db = makeMockDb([rows, []]);
    mockGenerateEmbedding.mockResolvedValue(null as unknown as number[]);

    const stats = await runEmbedHistoryJob(db, { batchDelayMs: 0 });
    expect(stats.skipped).toBe(1);
    expect(stats.embedded).toBe(0);
  });

  it('UPDATE sorgusu doğru vektör ile çağrılır', async () => {
    const rows = [{ _id: 'msg-abc', content: 'Test' }];
    const db = makeMockDb([rows, []]);
    const fakeVec = new Array(768).fill(0.5);
    mockGenerateEmbedding.mockResolvedValue(fakeVec);

    await runEmbedHistoryJob(db, { batchDelayMs: 0 });

    const updateCalls = (db.query.mock.calls as [string, unknown[]][])
      .filter(([sql]) => sql.includes('UPDATE messages'));
    expect(updateCalls.length).toBe(1);
    const [, params] = updateCalls[0];
    expect(params[1]).toBe('msg-abc');
    expect((params[0] as string).startsWith('[')).toBe(true); // vektör literal
  });

  it('historyLimit=1 ile SQL yalnızca 1 satır ister', async () => {
    // Düzeltme sonrası: historyLimit SQL LIMIT'e dönüşür, verimsiz fetch+skip yok
    const db = makeMockDb([[{ _id: 'm1', content: 'Bir' }], []]);
    mockGenerateEmbedding.mockResolvedValue(new Array(768).fill(0.1));

    const stats = await runEmbedHistoryJob(db, { batchDelayMs: 0, historyLimit: 1 });
    expect(stats.embedded).toBe(1);
    expect(stats.skipped).toBe(0); // artık skipped yok — SQL seviyesinde kısıtlanır

    // İlk SELECT çağrısında LIMIT $1 = 1 olmalı (historyLimit = batchSize minimum)
    const selectCall = (db.query.mock.calls as [string, unknown[]][])
      .find(([sql]) => sql.includes('SELECT _id'));
    expect(selectCall?.[1]?.[0]).toBe(1); // effectiveBatch = min(50, 1) = 1
  });

  it('AbortSignal ile job iptal edilir', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ _id: `m${i}`, content: `msg ${i}` }));
    const db = makeMockDb([rows, rows, []]);
    mockGenerateEmbedding.mockResolvedValue(new Array(768).fill(0.1));

    const ac = new AbortController();
    ac.abort(); // hemen iptal

    const stats = await runEmbedHistoryJob(db, { batchDelayMs: 0, signal: ac.signal });
    expect(stats.processed).toBe(0); // abort ilk kontrolde yakalanır
  });

  it('finishedAt ve durationMs set edilir', async () => {
    const db = makeMockDb([[]]);
    const stats = await runEmbedHistoryJob(db);
    expect(stats.finishedAt).toBeInstanceOf(Date);
    expect(typeof stats.durationMs).toBe('number');
    expect(stats.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('onProgress callback çağrılır', async () => {
    const rows = [{ _id: 'm1', content: 'Test' }];
    const db = makeMockDb([rows, []]);
    mockGenerateEmbedding.mockResolvedValue(new Array(768).fill(0.1));

    const progressFn = jest.fn();
    await runEmbedHistoryJob(db, { batchDelayMs: 0, onProgress: progressFn });
    expect(progressFn).toHaveBeenCalled();
  });

  it('batchSize seçeneği SELECT sorgusuna uygulanır', async () => {
    const db = makeMockDb([[]]);
    await runEmbedHistoryJob(db, { batchSize: 10, batchDelayMs: 0 });
    const selectCall = (db.query.mock.calls as [string, unknown[]][])
      .find(([sql]) => sql.includes('SELECT _id'));
    expect(selectCall?.[1]?.[0]).toBe(10);
  });
});

describe('runEmbedHistoryJob — PGVECTOR_ENABLED=false', () => {
  it('disabled ise job DB sorgusu çalıştırmaz ve sıfır stat döner', async () => {
    jest.resetModules();
    jest.doMock('../lib/pgvector', () => ({
      PGVECTOR_ENABLED: false,
      generateEmbedding: jest.fn(),
    }));
    jest.doMock('../lib/logger', () => {
      const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
      return { __esModule: true, default: logger, ...logger };
    });

    const { runEmbedHistoryJob: runDisabled } =
      await import('../jobs/embedHistory');

    const db = makeMockDb([
      [{ _id: 'm1', content: 'test' }],
    ]);

    const stats = await runDisabled(db);

    // PGVECTOR_ENABLED=false → erken çıkış, DB'ye hiç dokunmaz
    expect(db.query).not.toHaveBeenCalled();
    expect(stats.embedded).toBe(0);
    expect(stats.processed).toBe(0);
    expect(stats.durationMs).toBe(0);

    jest.dontMock('../lib/pgvector');
    jest.dontMock('../lib/logger');
    jest.resetModules();
  });
});

describe('scheduleEmbedHistoryJob', () => {
  it('PGVECTOR_ENABLED=true ise hata vermez', () => {
    const db = makeMockDb([[]]);
    expect(() => scheduleEmbedHistoryJob(db)).not.toThrow();
    cancelEmbedHistoryJob(); // cleanup
  });

  it('cancelEmbedHistoryJob çift çağrıda hata vermez', () => {
    cancelEmbedHistoryJob();
    expect(() => cancelEmbedHistoryJob()).not.toThrow();
  });
});

describe('runEmbedHistoryJob — çok batch', () => {
  it('iki tam batch + boş batch işlenir', async () => {
    const batch1 = Array.from({ length: 3 }, (_, i) => ({ _id: `a${i}`, content: `msg a${i}` }));
    const batch2 = Array.from({ length: 3 }, (_, i) => ({ _id: `b${i}`, content: `msg b${i}` }));
    const db = makeMockDb([batch1, batch2, []]);
    mockGenerateEmbedding.mockResolvedValue(new Array(768).fill(0.2));

    const stats = await runEmbedHistoryJob(db, { batchSize: 3, batchDelayMs: 0 });
    expect(stats.embedded).toBe(6);
    expect(stats.processed).toBe(6);
  });

  it('batch arasında bekleme süresi geçiyor', async () => {
    const batch1 = Array.from({ length: 2 }, (_, i) => ({ _id: `c${i}`, content: `c${i}` }));
    const db = makeMockDb([batch1, batch1, []]); // 2 tam batch
    mockGenerateEmbedding.mockResolvedValue(new Array(768).fill(0.1));

    const start = Date.now();
    await runEmbedHistoryJob(db, { batchSize: 2, batchDelayMs: 50 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40); // en az bir bekleme
  });
});
