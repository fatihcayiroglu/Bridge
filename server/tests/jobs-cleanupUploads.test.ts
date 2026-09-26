// server/tests/jobs-cleanupUploads.test.ts
// cleanupUploads job — unit tests (filesystem & DB mocked)
process.env.NODE_ENV = 'test';

import path from 'path';
import { v4 as uuidv4 } from 'uuid';

// ── fs mock ───────────────────────────────────────────────────────
// Dönüş tipleri AÇIK yazılır: `jest.fn(() => [])` TypeScript'e `never[]`
// dedirtiyordu ve `mockReturnValue(['a.png'])` yazan her satır TS2322
// veriyordu (ölçüldü: bu tek sebep 12 hata).
const _fsMock = {
  existsSync:  jest.fn<boolean, [path: unknown]>(() => true),
  readdirSync: jest.fn<string[], [path: unknown]>(() => []),
  statSync:    jest.fn<{ mtimeMs: number }, [path: unknown]>(() => ({ mtimeMs: 0 })),
  unlinkSync:  jest.fn<void, [path: unknown]>(),
};
// Faz 12 — MOCK SÖZLEŞMESİ DÜZELTİLDİ.
//
// Eskiden `fs` modülünün TAMAMI yalnız bu dört fonksiyonla değiştiriliyordu.
// Sonuç: `fs`'i kullanan ilgisiz her şey kırılıyordu. Somut olarak
// `getStorageAdapter()` (lib/storageAdapter.ts:482) Pino ile log yazıyor,
// Pino'nun SonicBoom'u `fs.write` çağırıyor ve mock'ta olmadığı için
// `TypeError: fs.write is not a function` fırlıyordu — testin konusuyla
// hiç ilgisi olmayan bir hata.
//
// Gerçek modül korunur; YALNIZ testin kontrol etmesi gereken dört API
// override edilir. Üretim davranışı değişmedi.
jest.mock('fs', () => ({ ...jest.requireActual('fs'), ..._fsMock }));

// ── DB mock ───────────────────────────────────────────────────────
/** Mesaj ikizinin bu testte okunan alanları. */
interface UploadMessage { type?: string; fileUrl?: string; content?: string; [key: string]: unknown }

let _messages: UploadMessage[] = [];
let _dms: UploadMessage[]      = [];

jest.mock('../db/repositories', () => ({
  Messages: {
    findWhere: (q: Record<string, unknown>) => Promise.resolve(_messages.filter(m => m.type === 'file')),
    findProjected: (_q: Record<string, unknown>, _projection: Record<string, unknown>) => Promise.resolve(_messages.filter(m => m.type === 'file')),
  },
  Dms: {
    findMessagesWhere: (q: Record<string, unknown>) => Promise.resolve(_dms),
  },
}));

jest.mock('../db/loader', () => ({
  __esModule: true,
  default: {
    _pool: null,
    // Fallback cleanup is deliberately fail-closed unless every root-upload
    // owner it knows about can be scanned. This suite has no group-DM rows.
    groupDmMessages: { find: jest.fn(async () => []) },
  },
}));

import { runCleanup, startCleanupJob, stopCleanupJob } from '../jobs/cleanupUploads';

// ── helpers ──────────────────────────────────────────────────────
const OLD_TS = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago → past grace period

function setupDir(files: string[], oldFiles: string[] = []) {
  _fsMock.existsSync.mockReturnValue(true);
  _fsMock.readdirSync.mockReturnValue([...files, ...oldFiles]);
  _fsMock.statSync.mockImplementation((fp: unknown) => {
    const name = path.basename(String(fp));
    return { mtimeMs: oldFiles.includes(name) ? OLD_TS : Date.now() };
  });
  _fsMock.unlinkSync.mockClear();
}

// ── Tests ─────────────────────────────────────────────────────────

describe('runCleanup — upload dir does not exist', () => {
  beforeEach(() => {
    _messages = []; _dms = [];
    _fsMock.existsSync.mockReturnValue(false);
    _fsMock.readdirSync.mockClear();
    _fsMock.unlinkSync.mockClear();
  });

  it('returns early when upload dir does not exist', async () => {
    await runCleanup();
    expect(_fsMock.readdirSync).not.toHaveBeenCalled();
    expect(_fsMock.unlinkSync).not.toHaveBeenCalled();
  });
});

describe('runCleanup — empty dir', () => {
  beforeEach(() => {
    _messages = []; _dms = [];
    _fsMock.existsSync.mockReturnValue(true);
    _fsMock.readdirSync.mockReturnValue([]);
    _fsMock.unlinkSync.mockClear();
  });

  it('does nothing when no files present', async () => {
    await runCleanup();
    expect(_fsMock.unlinkSync).not.toHaveBeenCalled();
  });
});

describe('runCleanup — referenced files', () => {
  beforeEach(() => _fsMock.unlinkSync.mockClear());

  it('does NOT delete files that are referenced by a message', async () => {
    _messages = [{ _id: uuidv4(), type: 'file', fileUrl: 'http://cdn.example/uploads/image.png' }];
    _dms      = [];
    setupDir([], ['image.png']); // image.png is old but referenced

    await runCleanup();

    expect(_fsMock.unlinkSync).not.toHaveBeenCalled();
  });

  it('does NOT delete files referenced by DM messages', async () => {
    _messages = [];
    _dms      = [{ _id: uuidv4(), fileUrl: 'http://cdn.example/uploads/doc.pdf' }];
    setupDir([], ['doc.pdf']);

    await runCleanup();

    expect(_fsMock.unlinkSync).not.toHaveBeenCalled();
  });
});

describe('runCleanup — orphaned files', () => {
  beforeEach(() => {
    _messages = [];
    _dms      = [];
    _fsMock.unlinkSync.mockClear();
  });

  it('deletes old unreferenced files', async () => {
    setupDir([], ['orphan1.png', 'orphan2.mp4']);

    await runCleanup();

    expect(_fsMock.unlinkSync).toHaveBeenCalledTimes(2);
  });

  it('does NOT delete new files even if unreferenced (grace period)', async () => {
    // New files have mtimeMs = Date.now() → within 1h grace period
    _fsMock.existsSync.mockReturnValue(true);
    _fsMock.readdirSync.mockReturnValue(['new-upload.png']);
    _fsMock.statSync.mockReturnValue({ mtimeMs: Date.now() - 30_000 }); // 30s old
    _fsMock.unlinkSync.mockClear();

    await runCleanup();

    expect(_fsMock.unlinkSync).not.toHaveBeenCalled();
  });

  it('deletes only orphaned old files, preserving referenced ones', async () => {
    _messages = [{ _id: uuidv4(), type: 'file', fileUrl: 'http://cdn.example/uploads/keep.png' }];
    _fsMock.existsSync.mockReturnValue(true);
    _fsMock.readdirSync.mockReturnValue(['keep.png', 'orphan.png']);
    _fsMock.statSync.mockReturnValue({ mtimeMs: OLD_TS });
    _fsMock.unlinkSync.mockClear();

    await runCleanup();

    const deleted = _fsMock.unlinkSync.mock.calls.map(([fp]) => path.basename(String(fp)));
    expect(deleted).toContain('orphan.png');
    expect(deleted).not.toContain('keep.png');
  });
});

describe('runCleanup — error resilience', () => {
  beforeEach(() => _fsMock.unlinkSync.mockClear());

  it('handles readdirSync errors gracefully', async () => {
    _messages = []; _dms = [];
    _fsMock.existsSync.mockReturnValue(true);
    _fsMock.readdirSync.mockImplementation(() => { throw new Error('EPERM'); });

    await expect(runCleanup()).resolves.toBeUndefined();
  });

  it('continues when unlinkSync fails for one file', async () => {
    _messages = []; _dms = [];
    _fsMock.existsSync.mockReturnValue(true);
    _fsMock.readdirSync.mockReturnValue(['a.png', 'b.png']);
    _fsMock.statSync.mockReturnValue({ mtimeMs: OLD_TS });
    _fsMock.unlinkSync
      .mockImplementationOnce(() => { throw new Error('EBUSY'); })
      .mockImplementation(() => {});

    await expect(runCleanup()).resolves.toBeUndefined();
    // Should still attempt to delete the second file
    expect(_fsMock.unlinkSync).toHaveBeenCalledTimes(2);
  });
});

describe('startCleanupJob', () => {
  afterEach(() => {
    stopCleanupJob();
    jest.useRealTimers();
  });
  it('registers timers without throwing', () => {
    jest.useFakeTimers();
    expect(() => startCleanupJob()).not.toThrow();
  });
});
