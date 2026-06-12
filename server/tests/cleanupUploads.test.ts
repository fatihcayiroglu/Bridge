// server/tests/cleanupUploads.test.ts
// cleanupUploads — birim testleri (adapter mock'lu, timer-free)
//
// Sprint 54 odağı: grace period hem local hem de remote adaptörlerde
// doğru çalıştığını doğrular.
//
// Sprint 62: getReferencedKeys() refactor testleri eklendi.
//   - Collection API yolu: Messages.findProjected + Dms.findMessagesWhere
//   - PostgreSQL yolu: db._pool.query ile UNION ALL sorgusu

process.env.NODE_ENV = 'test';

import type { StorageAdapter, StorageObject } from '../lib/storageAdapter';

// ── Logger mock ───────────────────────────────────────────────────────────────

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../lib/logger', () => mockLogger);

// ── Repositories mock ─────────────────────────────────────────────────────────

let mockChannelMessages: Array<{ fileUrl?: string }> = [];
let mockDmMessages:      Array<{ fileUrl?: string }> = [];

jest.mock('../db/repositories', () => ({
  Messages: {
    findProjected: jest.fn(async () => mockChannelMessages),
  },
  Dms: {
    findMessagesWhere: jest.fn(async () => mockDmMessages),
  },
}));

// ── DB loader mock — PostgreSQL yolu test edilebilmesi için ───────────────────

let mockPoolQuery: jest.Mock | null = null;

jest.mock('../db/loader', () => ({
  get _pool() { return mockPoolQuery ? { query: mockPoolQuery } : undefined; },
}));

// ── storageAdapter mock ───────────────────────────────────────────────────────

let mockObjects: StorageObject[]             = [];
const mockDeleteFile  = jest.fn(async () => {});
const mockListFiles   = jest.fn(async () => mockObjects);
const mockKeyFromUrl  = jest.fn((url: string) => url.split('/').pop() ?? url);
const mockHealthCheck = jest.fn(async () => true);

const mockAdapter: StorageAdapter = {
  listFiles:   mockListFiles,
  deleteFile:  mockDeleteFile,
  keyFromUrl:  mockKeyFromUrl,
  healthCheck: mockHealthCheck,
};

jest.mock('../lib/storageAdapter', () => ({
  getStorageAdapter: jest.fn(() => mockAdapter),
}));




// ── Test yardımcıları ─────────────────────────────────────────────────────────

const GRACE_MS = 10 * 60 * 1000; // cleanupUploads MAX_FILE_AGE_MS ile aynı

function makeObject(key: string, ageMs: number): StorageObject {
  return { key, lastModifiedMs: Date.now() - ageMs };
}

function makeOldObject(key: string): StorageObject {
  return makeObject(key, GRACE_MS + 1);   // grace period dışında
}

function makeNewObject(key: string): StorageObject {
  return makeObject(key, GRACE_MS - 1000); // grace period içinde — korunmalı
}

function makeUnknownAgeObject(key: string): StorageObject {
  return { key }; // lastModifiedMs: undefined
}

// ── Import (mock'lar hazır olduktan sonra) ────────────────────────────────────

import { runCleanup } from '../jobs/cleanupUploads';

// ─────────────────────────────────────────────────────────────────────────────
// Testler
// ─────────────────────────────────────────────────────────────────────────────

describe('runCleanup()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockObjects          = [];
    mockChannelMessages  = [];
    mockDmMessages       = [];
    mockPoolQuery        = null; // varsayılan: Collection API yolu
    process.env.CDN_PROVIDER = 'local';
  });

  // ── Temel davranış ─────────────────────────────────────────

  it('dosya yoksa erken döner, delete çağrılmaz', async () => {
    mockObjects = [];
    await runCleanup();
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it('tüm dosyalar referanslıysa hiçbirini silmez', async () => {
    mockObjects = [makeOldObject('img.png')];
    mockChannelMessages = [{ fileUrl: '/uploads/img.png' }];
    await runCleanup();
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it('referanssız + eski dosyayı siler', async () => {
    mockObjects = [makeOldObject('orphan.png')];
    await runCleanup();
    expect(mockDeleteFile).toHaveBeenCalledWith('orphan.png');
  });

  it('birden fazla dosyadan yalnızca referanssız olanı siler', async () => {
    mockObjects = [makeOldObject('keep.png'), makeOldObject('orphan.png')];
    mockChannelMessages = [{ fileUrl: '/uploads/keep.png' }];
    await runCleanup();
    expect(mockDeleteFile).toHaveBeenCalledTimes(1);
    expect(mockDeleteFile).toHaveBeenCalledWith('orphan.png');
  });

  // ── Grace period ───────────────────────────────────────────

  it('[local] yeni dosyayı grace period nedeniyle korur', async () => {
    process.env.CDN_PROVIDER = 'local';
    mockObjects = [makeNewObject('fresh.png')];
    await runCleanup();
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it('[remote/r2] yeni dosyayı grace period nedeniyle korur', async () => {
    process.env.CDN_PROVIDER = 'r2';
    mockObjects = [makeNewObject('fresh-remote.png')];
    await runCleanup();
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it('[remote/s3] eski ve referanssız dosyayı siler', async () => {
    process.env.CDN_PROVIDER = 's3';
    mockObjects = [makeOldObject('old-remote.png')];
    await runCleanup();
    expect(mockDeleteFile).toHaveBeenCalledWith('old-remote.png');
  });

  // ── lastModifiedMs bilinmiyor — güvenli taraf ──────────────

  it('lastModifiedMs undefined ise dosyayı silmez', async () => {
    process.env.CDN_PROVIDER = 'r2';
    mockObjects = [makeUnknownAgeObject('mystery.png')];
    await runCleanup();
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it('lastModifiedMs bilinmeyen + eski dosya karışık — sadece eski bilineni siler', async () => {
    process.env.CDN_PROVIDER = 's3';
    mockObjects = [
      makeUnknownAgeObject('unknown.png'),
      makeOldObject('old.png'),
    ];
    await runCleanup();
    expect(mockDeleteFile).toHaveBeenCalledTimes(1);
    expect(mockDeleteFile).toHaveBeenCalledWith('old.png');
  });

  // ── DM mesaj referansları ──────────────────────────────────

  it('DM mesajındaki dosya URL\'sini korur', async () => {
    mockObjects = [makeOldObject('dm-file.png')];
    mockDmMessages = [{ fileUrl: '/uploads/dm-file.png' }];
    await runCleanup();
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  // ── Hata toleransı ─────────────────────────────────────────

  it('listFiles hata fırlatırsa erken döner, error loglanır', async () => {
    mockListFiles.mockRejectedValueOnce(new Error('S3 timeout'));
    await runCleanup();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'cleanup.list.failed' }),
      expect.any(String),
    );
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it('deleteFile hata fırlatırsa diğer dosyalar silinmeye devam eder', async () => {
    mockObjects = [makeOldObject('fail.png'), makeOldObject('ok.png')];
    mockDeleteFile
      .mockRejectedValueOnce(new Error('yarış koşulu'))
      .mockResolvedValueOnce(undefined);
    await runCleanup();
    expect(mockDeleteFile).toHaveBeenCalledTimes(2);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'fail.png' }),
      expect.any(String),
    );
  });

  // ── PostgreSQL yolu (Sprint 62) ────────────────────────────

  it('[pg] UNION ALL sorgusu ile referenced key set oluşturulur', async () => {
    mockPoolQuery = jest.fn().mockResolvedValueOnce({
      rows: [{ fileUrl: '/uploads/keep-pg.png' }],
    });
    mockObjects = [makeOldObject('keep-pg.png'), makeOldObject('orphan-pg.png')];
    await runCleanup();
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining('UNION ALL'),
    );
    expect(mockDeleteFile).toHaveBeenCalledTimes(1);
    expect(mockDeleteFile).toHaveBeenCalledWith('orphan-pg.png');
  });

  it('[pg] pool.query hatası runCleanup\'u durdurmamalı — error loglanır', async () => {
    mockPoolQuery = jest.fn().mockRejectedValueOnce(new Error('pg connect fail'));
    mockObjects   = [makeOldObject('some.png')];
    // getReferencedKeys içindeki hata runCleanup'a fırlatılır ve erken çıkılır
    await expect(runCleanup()).rejects.toThrow('pg connect fail');
  });

  // ── startCleanupJob timer testi ────────────────────────────

  it('startCleanupJob — setTimeout ve setInterval kaydeder', () => {
    jest.useFakeTimers();
    const setTimeoutSpy  = jest.spyOn(global, 'setTimeout');
    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    const { startCleanupJob } = require('../jobs/cleanupUploads');
    startCleanupJob();

    expect(setTimeoutSpy).toHaveBeenCalledWith(
      expect.any(Function),
      5 * 60 * 1000,
    );
    expect(setIntervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      24 * 60 * 60 * 1000,
    );

    jest.useRealTimers();
  });
});
