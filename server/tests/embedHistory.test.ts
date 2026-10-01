// server/tests/embedHistory.test.ts
// Sprint 113 — pgvector Faz 2: embedHistory job birim testleri
// Test framework: Jest 29 (ts-jest) — projeyle tutarlı

import { runEmbedHistoryJob, scheduleEmbedHistoryJob, cancelEmbedHistoryJob } from '../jobs/embedHistory';
import { makeDirectPoolDouble, type DirectPoolDouble } from './helpers/pgPoolDouble';

// ── Mock'lar ─────────────────────────────────────────────────────────────

jest.mock('../lib/pgvector', () => ({
  PGVECTOR_ENABLED: true,
  generateEmbedding: jest.fn(),
}));

jest.mock('../lib/logger', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { __esModule: true, default: logger, ...logger };
});

jest.mock('../lib/redisAdapter', () => ({
  cache: { setIfAbsentAuthoritative: jest.fn(async () => true) },
}));

import { generateEmbedding } from '../lib/pgvector';
import { cache } from '../lib/redisAdapter';
const mockGenerateEmbedding = generateEmbedding as jest.MockedFunction<typeof generateEmbedding>;
const mockDailyClaim = cache.setIfAbsentAuthoritative as jest.MockedFunction<typeof cache.setIfAbsentAuthoritative>;

// ── Mock DB ───────────────────────────────────────────────────────────────

// Ikiz, URUN sozlesmesini (`DirectQueryingPool`) tasiyan kanonik yardimciyla
// kurulur. Eskiden burada elle bir `jest.fn` vardi ve TypeScript donus tipini
// ilk `return`den cikardigi icin is imzasina UYMUYORDU (18 strict hatasi).
function makeMockDb(rows: { _id: string; content: string; createdAt?: number }[][] = []): DirectPoolDouble {
  let callCount = 0;
  return makeDirectPoolDouble(async (sql) => {
    if (sql.includes('SELECT _id')) {
      const batch = rows[callCount++] ?? [];
      return {
        rows: batch.map((row, i) => ({
          createdAt: row.createdAt ?? (1000 + callCount * 100 + i),
          ...row,
        })),
      };
    }
    return { rows: [] }; // UPDATE
  });
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


  it('uses canonical keyset pagination instead of OFFSET so shrinking NULL sets are not skipped', async () => {
    const batch1 = [
      { _id: 'm1', content: 'one', createdAt: 1000 },
      { _id: 'm2', content: 'two', createdAt: 1000 },
    ];
    const batch2 = [
      { _id: 'm3', content: 'three', createdAt: 2000 },
      { _id: 'm4', content: 'four', createdAt: 3000 },
    ];
    const db = makeMockDb([batch1, batch2, []]);
    mockGenerateEmbedding.mockResolvedValue(new Array(768).fill(0.1));

    const stats = await runEmbedHistoryJob(db, { batchSize: 2, batchDelayMs: 0 });

    expect(stats.embedded).toBe(4);
    const selects = (db.query.mock.calls as [string, unknown[]][])
      .filter(([sql]) => sql.includes('SELECT _id'));
    expect(selects[0][0]).not.toContain('OFFSET');
    expect(selects[0][0]).toContain('ORDER BY "createdAt" ASC, _id ASC');
    expect(selects[1][1][1]).toBe(1000);
    expect(selects[1][1][2]).toBe('m2');
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
  afterEach(() => {
    cancelEmbedHistoryJob();
    jest.useRealTimers();
    mockDailyClaim.mockReset();
    mockDailyClaim.mockResolvedValue(true);
  });

  it('PGVECTOR_ENABLED=true ise hata vermez', () => {
    const db = makeMockDb([[]]);
    expect(() => scheduleEmbedHistoryJob(db)).not.toThrow();
    cancelEmbedHistoryJob(); // cleanup
  });

  it('03:00 UTC penceresinde cluster-wide günlük claim alıp yalnız bir kez çalışır', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-30T03:01:00.000Z'));
    const db = makeMockDb([[]]);
    scheduleEmbedHistoryJob(db);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockDailyClaim).toHaveBeenCalledWith(
      'jobs:embed-history:daily:2026-08-30',
      expect.objectContaining({ claimedAt: expect.stringContaining('2026-08-30T03:02:') }),
      26 * 60 * 60,
    );
    const selectsAfterFirstTick = db.query.mock.calls.filter(([sql]) => String(sql).includes('SELECT _id')).length;
    expect(selectsAfterFirstTick).toBe(1);

    mockDailyClaim.mockResolvedValue(false);
    await jest.advanceTimersByTimeAsync(60_000);
    const selectsAfterSecondTick = db.query.mock.calls.filter(([sql]) => String(sql).includes('SELECT _id')).length;
    expect(selectsAfterSecondTick).toBe(1);
  });

  it('configured authority claim hata verirse duplicate-risk yerine fail-closed skip eder', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-30T03:01:00.000Z'));
    mockDailyClaim.mockRejectedValue(new Error('redis unavailable'));
    const db = makeMockDb([[]]);
    scheduleEmbedHistoryJob(db);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('UTC penceresi dışında host timezone ne olursa olsun günlük claim denemez', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-30T02:57:00.000Z'));
    const db = makeMockDb([[]]);
    scheduleEmbedHistoryJob(db);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockDailyClaim).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
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

// P6 — the batch embedder sends message text to the embedding provider, so its
// SELECT is the boundary: deleted placeholders, E2EE payloads and every server
// whose owner turned AI off stay out. (Real-PostgreSQL evidence needs the
// pgvector extension; the SQL itself is pinned here.)
describe('P6: what the batch embedder may read', () => {
  it('excludes deleted rows, E2EE payloads and servers with AI off', async () => {
    const db = makeMockDb([[]] as { _id: string; content: string }[][]);
    await runEmbedHistoryJob(db, { batchSize: 10 });
    const select = String((db.query.mock.calls as [string, unknown[]][]).find(([sql]) => String(sql).includes('SELECT _id'))?.[0] ?? '');
    expect(select).toMatch(/"deletedAt" IS NULL/);
    expect(select).toMatch(/"encryptedContent" IS NULL/);
    expect(select).toMatch(/content NOT LIKE '🔒e2e:%'/);
    expect(select).toMatch(/EXISTS \(SELECT 1 FROM servers s WHERE s\._id = messages\."serverId" AND s\."aiEnabled" = TRUE\)/);
  });
});
