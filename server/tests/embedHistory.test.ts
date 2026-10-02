// server/tests/embedHistory.test.ts
// Sprint 113 — pgvector Faz 2: embedHistory job birim testleri
// Test framework: Jest 29 (ts-jest) — projeyle tutarlı

import { runEmbedHistoryJob, scheduleEmbedHistoryJob, cancelEmbedHistoryJob, runEmbedSweep, embedSweepTick, scheduleEmbedSweep, cancelEmbedSweep, purgeIneligibleEmbeddings } from '../jobs/embedHistory';
import { makeDirectPoolDouble, type DirectPoolDouble } from './helpers/pgPoolDouble';

// ── Mock'lar ─────────────────────────────────────────────────────────────

// P6: the job no longer writes vectors itself — every row goes through the
// single guarded writer (`saveMessageEmbedding`, tested in pgvector.test.ts).
// Here the writer is a double; its outcome drives the job's statistics.
jest.mock('../lib/pgvector', () => ({
  PGVECTOR_ENABLED: true,
  saveMessageEmbedding: jest.fn(),
  EMBEDDABLE_ROW_PREDICATE: jest.requireActual('../lib/pgvector').EMBEDDABLE_ROW_PREDICATE,
}));

jest.mock('../lib/logger', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { __esModule: true, default: logger, ...logger };
});

jest.mock('../lib/redisAdapter', () => ({
  cache: { setIfAbsentAuthoritative: jest.fn(async () => true) },
}));

import { saveMessageEmbedding } from '../lib/pgvector';
import { cache } from '../lib/redisAdapter';
const mockSave = saveMessageEmbedding as jest.MockedFunction<typeof saveMessageEmbedding>;
const mockDailyClaim = cache.setIfAbsentAuthoritative as jest.MockedFunction<typeof cache.setIfAbsentAuthoritative>;

// ── Mock DB ───────────────────────────────────────────────────────────────

// Ikiz, URUN sozlesmesini (`DirectQueryingPool`) tasiyan kanonik yardimciyla
// kurulur. Eskiden burada elle bir `jest.fn` vardi ve TypeScript donus tipini
// ilk `return`den cikardigi icin is imzasina UYMUYORDU (18 strict hatasi).
function makeMockDb(rows: { _id: string; content: string; createdAt?: number }[][] = []): DirectPoolDouble {
  let callCount = 0;
  return makeDirectPoolDouble(async (sql) => {
    if (sql.includes('WHERE m.embedding IS NULL')) {
      const batch = rows[callCount++] ?? [];
      return {
        rows: batch.map((row, i) => ({
          createdAt: row.createdAt ?? (1000 + callCount * 100 + i),
          ...row,
        })),
      };
    }
    return { rows: [], rowCount: 0 }; // purge / other
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
    mockSave.mockResolvedValue('saved');

    const stats = await runEmbedHistoryJob(db, { batchDelayMs: 0 });
    expect(stats.processed).toBe(2);
    expect(stats.embedded).toBe(2);
    expect(stats.failed).toBe(0);
  });

  it('yazıcı hata fırlatırsa failed artar', async () => {
    const rows = [{ _id: 'm1', content: 'Hata mesajı' }];
    const db = makeMockDb([rows, []]);
    mockSave.mockRejectedValue(new Error('API hatası'));

    const stats = await runEmbedHistoryJob(db, { batchDelayMs: 0 });
    expect(stats.failed).toBe(1);
    expect(stats.embedded).toBe(0);
  });

  it.each(['provider_failed', 'save_failed', 'check_failed'] as const)('writer outcome %s counts as failed (retried later)', async (outcome) => {
    const db = makeMockDb([[{ _id: 'm1', content: 'x' }], []]);
    mockSave.mockResolvedValue(outcome);
    const stats = await runEmbedHistoryJob(db, { batchDelayMs: 0 });
    expect(stats.failed).toBe(1);
    expect(stats.embedded).toBe(0);
  });

  it.each(['ineligible', 'stale', 'skipped_e2ee', 'disabled'] as const)('writer outcome %s counts as skipped', async (outcome) => {
    const db = makeMockDb([[{ _id: 'm1', content: 'Boş embedding' }], []]);
    mockSave.mockResolvedValue(outcome);
    const stats = await runEmbedHistoryJob(db, { batchDelayMs: 0 });
    expect(stats.skipped).toBe(1);
    expect(stats.embedded).toBe(0);
  });

  it('her satır, okunan içerikle tek korumalı yazıcıya verilir', async () => {
    const rows = [{ _id: 'msg-abc', content: 'Test' }];
    const db = makeMockDb([rows, []]);
    mockSave.mockResolvedValue('saved');

    await runEmbedHistoryJob(db, { batchDelayMs: 0 });

    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockSave).toHaveBeenCalledWith({ db, messageId: 'msg-abc', content: 'Test' });
    // The job itself never writes a vector (only the writer does).
    expect((db.query.mock.calls as [string, unknown[]][]).some(([sql]) => /SET embedding = \$1/.test(sql))).toBe(false);
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
    mockSave.mockResolvedValue('saved');

    const stats = await runEmbedHistoryJob(db, { batchSize: 2, batchDelayMs: 0 });

    expect(stats.embedded).toBe(4);
    const selects = (db.query.mock.calls as [string, unknown[]][])
      .filter(([sql]) => sql.includes('WHERE m.embedding IS NULL'));
    expect(selects[0][0]).not.toContain('OFFSET');
    expect(selects[0][0]).toContain('ORDER BY m."createdAt" ASC, m._id ASC');
    expect(selects[1][1][1]).toBe(1000);
    expect(selects[1][1][2]).toBe('m2');
  });

  it('historyLimit=1 ile SQL yalnızca 1 satır ister', async () => {
    // Düzeltme sonrası: historyLimit SQL LIMIT'e dönüşür, verimsiz fetch+skip yok
    const db = makeMockDb([[{ _id: 'm1', content: 'Bir' }], []]);
    mockSave.mockResolvedValue('saved');

    const stats = await runEmbedHistoryJob(db, { batchDelayMs: 0, historyLimit: 1 });
    expect(stats.embedded).toBe(1);
    expect(stats.skipped).toBe(0); // artık skipped yok — SQL seviyesinde kısıtlanır

    // İlk SELECT çağrısında LIMIT $1 = 1 olmalı (historyLimit = batchSize minimum)
    const selectCall = (db.query.mock.calls as [string, unknown[]][])
      .find(([sql]) => sql.includes('WHERE m.embedding IS NULL'));
    expect(selectCall?.[1]?.[0]).toBe(1); // effectiveBatch = min(50, 1) = 1
  });

  it('AbortSignal ile job iptal edilir', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ _id: `m${i}`, content: `msg ${i}` }));
    const db = makeMockDb([rows, rows, []]);
    mockSave.mockResolvedValue('saved');

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
    mockSave.mockResolvedValue('saved');

    const progressFn = jest.fn();
    await runEmbedHistoryJob(db, { batchDelayMs: 0, onProgress: progressFn });
    expect(progressFn).toHaveBeenCalled();
  });

  it('batchSize seçeneği SELECT sorgusuna uygulanır', async () => {
    const db = makeMockDb([[]]);
    await runEmbedHistoryJob(db, { batchSize: 10, batchDelayMs: 0 });
    const selectCall = (db.query.mock.calls as [string, unknown[]][])
      .find(([sql]) => sql.includes('WHERE m.embedding IS NULL'));
    expect(selectCall?.[1]?.[0]).toBe(10);
  });
});

describe('runEmbedHistoryJob — PGVECTOR_ENABLED=false', () => {
  it('disabled ise job DB sorgusu çalıştırmaz ve sıfır stat döner', async () => {
    jest.resetModules();
    jest.doMock('../lib/pgvector', () => ({
      PGVECTOR_ENABLED: false,
      saveMessageEmbedding: jest.fn(),
      EMBEDDABLE_ROW_PREDICATE: 'TRUE',
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
    const selectsAfterFirstTick = db.query.mock.calls.filter(([sql]) => String(sql).includes('WHERE m.embedding IS NULL')).length;
    expect(selectsAfterFirstTick).toBe(1);

    mockDailyClaim.mockResolvedValue(false);
    await jest.advanceTimersByTimeAsync(60_000);
    const selectsAfterSecondTick = db.query.mock.calls.filter(([sql]) => String(sql).includes('WHERE m.embedding IS NULL')).length;
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
    mockSave.mockResolvedValue('saved');

    const stats = await runEmbedHistoryJob(db, { batchSize: 3, batchDelayMs: 0 });
    expect(stats.embedded).toBe(6);
    expect(stats.processed).toBe(6);
  });

  it('batch arasında bekleme süresi geçiyor', async () => {
    const batch1 = Array.from({ length: 2 }, (_, i) => ({ _id: `c${i}`, content: `c${i}` }));
    const db = makeMockDb([batch1, batch1, []]); // 2 tam batch
    mockSave.mockResolvedValue('saved');

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
  beforeEach(() => { jest.clearAllMocks(); });
  it('excludes deleted rows, E2EE payloads, system messages and servers with AI off', async () => {
    const db = makeMockDb([[]] as { _id: string; content: string }[][]);
    await runEmbedHistoryJob(db, { batchSize: 10 });
    const select = String((db.query.mock.calls as [string, unknown[]][]).find(([sql]) => String(sql).includes('WHERE m.embedding IS NULL'))?.[0] ?? '');
    expect(select).toMatch(/m\."deletedAt" IS NULL/);
    expect(select).toMatch(/m\."encryptedContent" IS NULL/);
    expect(select).toMatch(/m\.content NOT LIKE '🔒e2e:%'/);
    expect(select).toMatch(/m\.type <> 'system'/);
    expect(select).toMatch(/EXISTS \(SELECT 1 FROM servers s WHERE s\._id = m\."serverId" AND s\."aiEnabled" = TRUE\)/);
  });

  it('first removes vectors that may no longer exist (bounded chunks), before embedding anything', async () => {
    const db = makeMockDb([[]] as { _id: string; content: string }[][]);
    await runEmbedHistoryJob(db, { batchSize: 10 });
    const calls = (db.query.mock.calls as [string, unknown[]][]).map(([sql]) => String(sql));
    const purgeAt = calls.findIndex((sql) => sql.includes('UPDATE messages SET embedding = NULL'));
    const selectAt = calls.findIndex((sql) => sql.includes('WHERE m.embedding IS NULL'));
    expect(purgeAt).toBeGreaterThanOrEqual(0);
    expect(purgeAt).toBeLessThan(selectAt);
    expect(calls[purgeAt]).toMatch(/m\.embedding IS NOT NULL\s+AND NOT \(/);
    expect(calls[purgeAt]).toMatch(/LIMIT \$1/);
  });

  it('AI_PROVIDER=none: the batch does not even select rows to embed', async () => {
    process.env.AI_PROVIDER = 'none';
    try {
      const db = makeMockDb([[{ _id: 'm1', content: 'x' }], []]);
      const stats = await runEmbedHistoryJob(db, { batchSize: 10 });
      expect(stats.processed).toBe(0);
      expect(mockSave).not.toHaveBeenCalled();
      expect((db.query.mock.calls as [string, unknown[]][]).some(([sql]) => String(sql).includes('WHERE m.embedding IS NULL'))).toBe(false);
    } finally {
      delete process.env.AI_PROVIDER;
    }
  });
});

describe('P6: purgeIneligibleEmbeddings', () => {
  it('loops in chunks until a short chunk, and stops at maxChunks', async () => {
    const counts = [3, 3, 1];
    const db = makeDirectPoolDouble(async () => ({ rows: [], rowCount: counts.shift() ?? 0 }));
    expect(await purgeIneligibleEmbeddings(db, { chunk: 3, maxChunks: 10 })).toBe(7);
    expect(db.query).toHaveBeenCalledTimes(3);
    expect((db.query.mock.calls[0] as [string, unknown[]])[1]).toEqual([3]);

    const always = makeDirectPoolDouble(async () => ({ rows: [], rowCount: 5 }));
    expect(await purgeIneligibleEmbeddings(always, { chunk: 5, maxChunks: 4 })).toBe(20);
    expect(always.query).toHaveBeenCalledTimes(4);
  });
});

describe('P6: runEmbedSweep — the live caller', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  const sweepDb = (rows: Array<{ _id: string; content: string }>) =>
    makeDirectPoolDouble(async (sql) => (sql.includes('WHERE m.embedding IS NULL') ? { rows: rows.map((r) => ({ ...r })) } : { rows: [] }));

  it('selects the newest un-embedded eligible rows inside the window, bounded by the batch', async () => {
    const db = sweepDb([{ _id: 'a', content: 'one' }, { _id: 'b', content: 'two' }]);
    mockSave.mockResolvedValue('saved');
    const stats = await runEmbedSweep(db, { batchSize: 7, windowMs: 1_000, now: 10_000 });
    expect(stats).toEqual({ selected: 2, embedded: 2, failed: 0, skipped: 0, stopped: null });
    const [sql, params] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('m."createdAt" > $1');
    expect(sql).toContain('ORDER BY m."createdAt" DESC');
    expect(sql).toContain('s."aiEnabled" = TRUE');
    expect(params).toEqual([9_000, 7]);
    expect(mockSave).toHaveBeenNthCalledWith(1, { db, messageId: 'a', content: 'one' });
  });

  it('a provider outage stops the pass after maxFailures (no hammering); rows stay pending', async () => {
    const db = sweepDb(Array.from({ length: 50 }, (_, i) => ({ _id: `m${i}`, content: `t${i}` })));
    mockSave.mockResolvedValue('provider_failed');
    const stats = await runEmbedSweep(db, { maxFailures: 3 });
    expect(stats.failed).toBe(3);
    expect(stats.stopped).toBe('failures');
    expect(mockSave).toHaveBeenCalledTimes(3);
  });

  it('a writer exception counts as a failure and does not end the process', async () => {
    const db = sweepDb([{ _id: 'a', content: 'x' }, { _id: 'b', content: 'y' }]);
    mockSave.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('saved');
    const stats = await runEmbedSweep(db, { maxFailures: 5 });
    expect(stats).toMatchObject({ failed: 1, embedded: 1, stopped: null });
  });

  it('respects the time budget and an abort', async () => {
    const db = sweepDb([{ _id: 'a', content: 'x' }, { _id: 'b', content: 'y' }]);
    mockSave.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 15)); return 'saved'; });
    const budget = await runEmbedSweep(db, { budgetMs: 5 });
    expect(budget.stopped).toBe('budget');
    expect(budget.selected).toBe(1);
    const ac = new AbortController(); ac.abort();
    const aborted = await runEmbedSweep(db, { signal: ac.signal });
    expect(aborted).toMatchObject({ selected: 0, stopped: 'aborted' });
  });

  it('skips malformed rows; AI_PROVIDER=none → no query at all', async () => {
    const db = makeDirectPoolDouble(async () => ({ rows: [{ _id: 1, content: 'x' }, { _id: 'ok', content: 'y' }] }));
    mockSave.mockResolvedValue('stale');
    expect(await runEmbedSweep(db)).toMatchObject({ selected: 1, skipped: 1 });
    process.env.AI_PROVIDER = 'off';
    try {
      const quiet = sweepDb([{ _id: 'a', content: 'x' }]);
      expect(await runEmbedSweep(quiet)).toMatchObject({ selected: 0 });
      expect(quiet.query).not.toHaveBeenCalled();
    } finally {
      delete process.env.AI_PROVIDER;
    }
  });
});

describe('P6: embedSweepTick / scheduleEmbedSweep', () => {
  afterEach(() => { cancelEmbedSweep(); mockDailyClaim.mockReset(); mockDailyClaim.mockResolvedValue(true); jest.useRealTimers(); });

  it('one node per interval: the claim decides; a lost claim does no work', async () => {
    const db = makeDirectPoolDouble(async () => ({ rows: [] }));
    mockDailyClaim.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await embedSweepTick(db, 120_000)).toMatchObject({ selected: 0 });
    expect(await embedSweepTick(db, 120_000)).toBeNull();
    expect(db.query).toHaveBeenCalledTimes(1);
    const [key, , ttl] = mockDailyClaim.mock.calls[0] as [string, unknown, number];
    expect(key).toBe('jobs:embed-sweep:2'); // 120 000 ms / 60 000 ms interval
    expect(ttl).toBe(120);
  });

  it('a claim error skips the tick (fail closed, no duplicate provider traffic)', async () => {
    const db = makeDirectPoolDouble(async () => ({ rows: [] }));
    mockDailyClaim.mockRejectedValueOnce(new Error('redis down'));
    expect(await embedSweepTick(db)).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  it('a failing pass is logged and the next tick runs again', async () => {
    const db = makeDirectPoolDouble(async () => { throw new Error('pg down'); });
    expect(await embedSweepTick(db, 0)).toBeNull();
    expect(await embedSweepTick(db, 60_000)).toBeNull();
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('scheduling runs ticks on the interval; no pool → not scheduled', async () => {
    jest.useFakeTimers();
    const db = makeDirectPoolDouble(async () => ({ rows: [] }));
    scheduleEmbedSweep(db);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockDailyClaim).toHaveBeenCalledTimes(1);
    cancelEmbedSweep();
    await jest.advanceTimersByTimeAsync(120_000);
    expect(mockDailyClaim).toHaveBeenCalledTimes(1);
    expect(() => scheduleEmbedSweep(null)).not.toThrow();
  });
});
