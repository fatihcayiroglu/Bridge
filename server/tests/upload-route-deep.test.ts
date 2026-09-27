import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-upload-route-deep-'));
process.env.NODE_ENV = 'test';
process.env.BRIDGE_UPLOAD_ROOT = ROOT;
process.env.MAX_FILE_SIZE_MB = '2048';
delete process.env.WEBP_CONVERT;

const mockCheckMagic = jest.fn((..._args: unknown[]) => true);
const mockScanFile = jest.fn().mockResolvedValue(undefined);
const mockSanitizeSvg = jest.fn().mockResolvedValue({ safe: true });
// `key` GERCEKTE dizge de donebiliyor (saglayici anahtari); cikarilan
// `key: null` tipi o senaryolari kurmayi engelliyordu.
const mockUploadFile = jest.fn<Promise<{ url: string; key: string | null; provider: string }>, [path: string, key: string]>(
  async (_path, key) => ({ url: `/public/${key}`, key: null, provider: 'local' }));
const mockDeleteFile = jest.fn().mockResolvedValue(undefined);
const mockUploadsInsert = jest.fn().mockResolvedValue({ _id: 'upload-row' });
const mockUploadsFindOne = jest.fn().mockResolvedValue(null);
const mockUploadsRemove = jest.fn().mockResolvedValue(undefined);
const mockGetHighestActiveTier = jest.fn().mockResolvedValue(3);
const mockGetProvider = jest.fn(() => 'local');
const mockGetPrivateProvider = jest.fn(() => 'local');
const mockCommitChunk = jest.fn();
const mockAllChunksPresent = jest.fn();
const mockMergeChunks = jest.fn();
const mockTryAcquireFinalization = jest.fn();
const mockValidateFinalSize = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();
const mockPgQuery = jest.fn(async (sql: string, _params?: unknown[]) => {
  if (sql.includes('MAX(s."boostTier")')) return { rows: [{ boostTier: 3 }] };
  return { rows: [{ referenced: false }] };
});

jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    const value = String(req.headers.authorization || '');
    if (!value.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const id = value.slice(7) || 'u1';
    req.user = id === 'missing-id'
      ? { username: 'missing-id' }
      : { id, username: `user-${id}`, displayName: `User ${id}`, isAdmin: id === 'admin' };
    next();
  },
}));
jest.mock('../middleware/rateLimit', () => ({ limits: { upload: () => (_req: any, _res: any, next: any) => next(), uploadChunk: () => (_req: any, _res: any, next: any) => next() } }));
jest.mock('../lib/adminAuthority', () => ({
  isDatabaseAdmin: jest.fn(async (id: unknown) => id === 'admin'),
  databaseAdminOnly: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../lib/contentScanner', () => ({ scanFile: (...args: any[]) => mockScanFile(...args) }));
jest.mock('../lib/svgSanitizer', () => ({ sanitizeSvgFile: (...args: any[]) => mockSanitizeSvg(...args) }));
jest.mock('../lib/uploadFileSafety', () => ({
  canonicalExtensionForMime: (mime: string) => ({
    'text/plain': '.txt', 'image/png': '.png', 'image/svg+xml': '.svg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/jpeg': '.jpg',
  } as Record<string,string>)[mime] ?? '',
  checkMagicBytes: (...args: unknown[]) => mockCheckMagic(...args),
}));
jest.mock('../lib/storageAdapter', () => ({
  getStorageAdapter: () => ({ uploadFile: mockUploadFile, deleteFile: mockDeleteFile }),
  getPrivateStorageAdapter: () => ({ uploadFile: mockUploadFile, deleteFile: mockDeleteFile }),
  getProvider: () => mockGetProvider(),
  getPrivateStorageProvider: () => mockGetPrivateProvider(),
}));
jest.mock('../lib/chunkUploadSafety', () => {
  const actual = jest.requireActual('../lib/chunkUploadSafety');
  return {
    ...actual,
    commitChunkTempFile: (...args: any[]) => mockCommitChunk(...args),
    allChunksPresent: (...args: any[]) => mockAllChunksPresent(...args),
    mergeChunkFiles: (...args: any[]) => mockMergeChunks(...args),
    tryAcquireChunkFinalization: (...args: any[]) => mockTryAcquireFinalization(...args),
    validateFinalUploadSize: (...args: any[]) => mockValidateFinalSize(...args),
  };
});
jest.mock('../db/postgres', () => ({ db: { _pool: { query: (sql: string, params?: unknown[]) => mockPgQuery(sql, params) } } }));
jest.mock('../db/repositories', () => ({
  Boosts: { getHighestActiveTierForUser: (...args: any[]) => mockGetHighestActiveTier(...args) },
}));
jest.mock('../db/loader', () => ({
  __esModule: true,
  default: { uploads: { insert: (...args: any[]) => mockUploadsInsert(...args), findOne: (...args: any[]) => mockUploadsFindOne(...args), remove: (...args: any[]) => mockUploadsRemove(...args) } },
}));
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: (...args: any[]) => mockLoggerWarn(...args), error: (...args: any[]) => mockLoggerError(...args), debug: jest.fn() },
}));

const router = require('../routes/upload').default;
const { chunkSessionKey } = require('../lib/chunkUploadSafety') as typeof import('../lib/chunkUploadSafety');
// Chunk quota state (sessions/bytes per user) is module-level; each test here
// exercises finalization, not the quota, so every test starts from zero.
const { _resetChunkQuotaForTest } = require('../lib/chunkUploadQuota') as typeof import('../lib/chunkUploadQuota');

function buildApp() {
  const app = express();
  app.use('/api/upload', router);
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}
const app = buildApp();

function auth(id = 'u1') { return `Bearer ${id}`; }
function chunkReq(id: string, index: number, total: number, body: Buffer, opts: { user?: string; name?: string; type?: string } = {}) {
  return request(app)
    .post('/api/upload/chunk')
    .set('Authorization', auth(opts.user ?? 'u1'))
    .set('Content-Type', 'application/octet-stream')
    .set('x-upload-id', id)
    .set('x-chunk-index', String(index))
    .set('x-total-chunks', String(total))
    .set('x-file-name', opts.name ?? 'file.txt')
    .set('x-file-type', opts.type ?? 'text/plain')
    .send(body);
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetChunkQuotaForTest();
  mockCheckMagic.mockReturnValue(true);
  mockScanFile.mockResolvedValue(undefined);
  mockSanitizeSvg.mockResolvedValue({ safe: true });
  mockUploadFile.mockImplementation(async (_p: string, key: string) => ({ url: `/public/${key}`, key: null, provider: 'local' }));
  mockDeleteFile.mockResolvedValue(undefined);
  mockUploadsInsert.mockResolvedValue({ _id: 'upload-row' });
  mockUploadsFindOne.mockResolvedValue(null);
  mockUploadsRemove.mockResolvedValue(undefined);
  mockGetHighestActiveTier.mockResolvedValue(3);
  mockGetProvider.mockReturnValue('local');
  mockGetPrivateProvider.mockReturnValue('local');
  const actualChunkSafety = jest.requireActual('../lib/chunkUploadSafety') as typeof import('../lib/chunkUploadSafety');
  mockCommitChunk.mockImplementation(actualChunkSafety.commitChunkTempFile);
  mockAllChunksPresent.mockImplementation(actualChunkSafety.allChunksPresent);
  mockMergeChunks.mockImplementation(actualChunkSafety.mergeChunkFiles);
  mockTryAcquireFinalization.mockImplementation(actualChunkSafety.tryAcquireChunkFinalization);
  mockValidateFinalSize.mockImplementation(actualChunkSafety.validateFinalUploadSize);
  mockPgQuery.mockImplementation(async (sql: string) => sql.includes('MAX(s."boostTier")')
    ? { rows: [{ boostTier: 3 }] }
    : { rows: [{ referenced: false }] });
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('single upload deep error/safety paths', () => {
  const bytes = Buffer.from('plain payload');

  it('fails closed on magic mismatch and removes the uploaded temp file', async () => {
    mockCheckMagic.mockReturnValueOnce(false);
    const res = await request(app).post('/api/upload').set('Authorization', auth()).attach('file', bytes, { filename: 'fake.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('propagates scanner status/code and never stores rejected bytes', async () => {
    mockScanFile.mockRejectedValueOnce({ statusCode: 451, message: 'malware', code: 'MALWARE' });
    const res = await request(app).post('/api/upload').set('Authorization', auth()).attach('file', bytes, { filename: 'scan.txt', contentType: 'text/plain' });
    expect(res.status).toBe(451);
    expect(res.body).toEqual({ error: 'malware', code: 'MALWARE' });
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('rejects unsafe SVG after scanning', async () => {
    mockSanitizeSvg.mockResolvedValueOnce({ safe: false });
    const res = await request(app).post('/api/upload').set('Authorization', auth()).attach('file', Buffer.from('<svg/>'), { filename: 'x.svg', contentType: 'image/svg+xml' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SVG_UNSAFE');
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('sanitizes client filename but stores protected bytes behind Bridge URL', async () => {
    const res = await request(app).post('/api/upload').set('Authorization', auth('owner')).attach('file', bytes, { filename: '../bad name?.txt', contentType: 'text/plain' });
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^\/uploads\//);
    expect(res.body.url).not.toContain('/public/');
    expect(res.body.fileName).toMatch(/bad_name_.txt$/);
    expect(mockUploadsInsert).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner', mimeType: 'text/plain' }));
  });

  it('storage failure returns 500 and never writes ownership metadata', async () => {
    mockUploadFile.mockRejectedValueOnce(new Error('private bucket down'));
    const res = await request(app).post('/api/upload').set('Authorization', auth()).attach('file', bytes, { filename: 'x.txt', contentType: 'text/plain' });
    expect(res.status).toBe(500);
    expect(mockUploadsInsert).not.toHaveBeenCalled();
  });

  it('ownership persistence failure rolls the stored object back', async () => {
    mockUploadsInsert.mockRejectedValueOnce(new Error('ownership DB down'));
    const res = await request(app).post('/api/upload').set('Authorization', auth()).attach('file', bytes, { filename: 'x.txt', contentType: 'text/plain' });
    expect(res.status).toBe(500);
    expect(mockDeleteFile).toHaveBeenCalledTimes(1);
  });

  it('enforces the live boost entitlement before scanning or storing a large single upload', async () => {
    mockGetHighestActiveTier.mockResolvedValueOnce(0);
    const overFreeTier = Buffer.alloc(25 * 1024 * 1024 + 1, 0x61);
    const res = await request(app).post('/api/upload').set('Authorization', auth('free-user'))
      .attach('file', overFreeTier, { filename: 'large.txt', contentType: 'text/plain' });
    expect(res.status).toBe(413);
    expect(res.body).toEqual(expect.objectContaining({ code: 'BOOST_LIMIT' }));
    expect(mockScanFile).not.toHaveBeenCalled();
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('fails to the conservative free-tier limit when boost authority is unavailable', async () => {
    mockGetHighestActiveTier.mockRejectedValueOnce(new Error('boost store down'));
    const overFallback = Buffer.alloc(25 * 1024 * 1024 + 1, 0x62);
    const res = await request(app).post('/api/upload').set('Authorization', auth('unknown-tier'))
      .attach('file', overFallback, { filename: 'large.txt', contentType: 'text/plain' });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('BOOST_LIMIT');
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('keeps ownership failure primary when storage rollback also fails', async () => {
    mockUploadsInsert.mockRejectedValueOnce(new Error('ownership down'));
    mockDeleteFile.mockRejectedValueOnce(new Error('rollback storage down'));
    const res = await request(app).post('/api/upload').set('Authorization', auth())
      .attach('file', bytes, { filename: 'x.txt', contentType: 'text/plain' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/ownership down/i);
    expect(mockDeleteFile).toHaveBeenCalledTimes(1);
  });

  it('accepts a clean SVG and preserves the sanitized result', async () => {
    const res = await request(app).post('/api/upload').set('Authorization', auth())
      .attach('file', Buffer.from('<svg/>'), { filename: 'clean.svg', contentType: 'image/svg+xml' });
    expect(res.status).toBe(200);
    expect(mockSanitizeSvg).toHaveBeenCalledTimes(1);
    expect(mockUploadFile).toHaveBeenCalledTimes(1);
  });

  it('uses the remote private key for storage while returning only the protected application URL', async () => {
    mockGetPrivateProvider.mockReturnValue('s3');
    mockUploadFile.mockImplementationOnce(async (_p: string, key: string) => ({
      url: `https://private.invalid/${key}`, key, provider: 's3',
    }));
    const res = await request(app).post('/api/upload').set('Authorization', auth('remote-owner'))
      .attach('file', bytes, { filename: 'remote.txt', contentType: 'text/plain' });
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^\/uploads\/[^/]+\.txt$/);
    expect(res.body.url).not.toContain('private.invalid');
    expect(mockUploadFile.mock.calls[0][1]).toMatch(/^uploads\//);
    expect(mockUploadsInsert).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'remote-owner', key: expect.stringMatching(/^uploads\//),
    }));
  });

  it('routes Multer and status-marked storage failures through the bounded upload error contract', async () => {
    const multerModule = require('multer') as typeof import('multer');
    mockUploadFile.mockRejectedValueOnce(new multerModule.MulterError('LIMIT_FILE_SIZE'));
    let res = await request(app).post('/api/upload').set('Authorization', auth())
      .attach('file', bytes, { filename: 'x.txt', contentType: 'text/plain' });
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/too large/i);

    mockUploadFile.mockRejectedValueOnce(Object.assign(new Error('unsupported downstream representation'), { status: 415 }));
    res = await request(app).post('/api/upload').set('Authorization', auth())
      .attach('file', bytes, { filename: 'x.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unsupported downstream/i);
  });
});

describe('chunk route resumability and finalization', () => {
  it('finalizes a one-chunk upload through scan, storage and ownership', async () => {
    const res = await chunkReq('onechunk', 0, 1, Buffer.from('hello'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ done: true, fileName: 'file.txt', fileType: 'text/plain', size: 5 });
    expect(res.body.url).toMatch(/^\/uploads\//);
    expect(mockScanFile).toHaveBeenCalled();
    expect(mockUploadFile).toHaveBeenCalled();
    expect(mockUploadsInsert).toHaveBeenCalled();
  });

  it('supports out-of-order arrival and finalizes when the set becomes complete', async () => {
    const first = await chunkReq('outoforder', 1, 2, Buffer.from('B'));
    expect(first.status).toBe(200);
    expect(first.body.done).toBe(false);
    const second = await chunkReq('outoforder', 0, 2, Buffer.from('A'));
    expect(second.status).toBe(200);
    expect(second.body.done).toBe(true);
    expect(second.body.size).toBe(2);
  });

  it('accepts an identical retry as duplicate but rejects changed bytes for the same index', async () => {
    const one = await chunkReq('retry-identical', 0, 2, Buffer.from('same'));
    expect(one.body).toMatchObject({ done: false, duplicate: false });
    const duplicate = await chunkReq('retry-identical', 0, 2, Buffer.from('same'));
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({ done: false, duplicate: true });

    const initial = await chunkReq('retry-conflict', 0, 2, Buffer.from('first'));
    expect(initial.status).toBe(200);
    const conflict = await chunkReq('retry-conflict', 0, 2, Buffer.from('DIFFERENT'));
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatch(/do not match/i);
  });

  it('binds uploadId to immutable metadata', async () => {
    expect((await chunkReq('manifest-binding', 0, 2, Buffer.from('A'))).status).toBe(200);
    const mismatch = await chunkReq('manifest-binding', 1, 3, Buffer.from('B'));
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error).toMatch(/different metadata/i);
  });

  it('scopes the same uploadId to different authenticated users', async () => {
    const a = await chunkReq('same-id', 0, 2, Buffer.from('A'), { user: 'alice' });
    const b = await chunkReq('same-id', 0, 2, Buffer.from('B'), { user: 'bob' });
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    expect(a.body.done).toBe(false); expect(b.body.done).toBe(false);
    const chunkRoot = path.join(ROOT, '_chunks');
    expect(fs.existsSync(path.join(chunkRoot, chunkSessionKey('alice', 'same-id')))).toBe(true);
    expect(fs.existsSync(path.join(chunkRoot, chunkSessionKey('bob', 'same-id')))).toBe(true);
  });

  it('reports another active finalizer instead of racing storage', async () => {
    await chunkReq('locked-finalize', 0, 2, Buffer.from('A'));
    const session = path.join(ROOT, '_chunks', chunkSessionKey('u1', 'locked-finalize'));
    fs.writeFileSync(path.join(session, 'finalizing.lock'), JSON.stringify({ startedAt: Date.now(), pid: 1 }));
    const res = await chunkReq('locked-finalize', 1, 2, Buffer.from('B'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ done: false, finalizing: true });
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('purges a completed session on scanner rejection', async () => {
    mockScanFile.mockRejectedValueOnce({ statusCode: 422, message: 'blocked', code: 'SCAN_BLOCK' });
    const res = await chunkReq('scan-reject', 0, 1, Buffer.from('bad'));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SCAN_BLOCK');
    // The purge is fire-and-forget, so the assertion must WAIT FOR THE
    // CONDITION rather than guess a duration: a fixed 20 ms sleep passed on a
    // bare run and failed under `jest --coverage`, where instrumentation slows
    // the unlink past the deadline. CI runs the suite WITH coverage, so the
    // fixed sleep was an intermittent red build.
    const sessionDir = path.join(ROOT, '_chunks', chunkSessionKey('u1', 'scan-reject'));
    const deadline = Date.now() + 5_000;
    while (fs.existsSync(sessionDir) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 10));
    }
    expect(fs.existsSync(sessionDir)).toBe(false);
  });

  it('rejects unsafe SVG during finalization', async () => {
    mockSanitizeSvg.mockResolvedValueOnce({ safe: false });
    const res = await chunkReq('svg-reject', 0, 1, Buffer.from('<svg/>'), { name: 'x.svg', type: 'image/svg+xml' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SVG_UNSAFE');
  });

  it('keeps committed chunks retryable after transient private-storage failure', async () => {
    mockUploadFile.mockRejectedValueOnce(new Error('storage down'));
    const res = await chunkReq('storage-retry', 0, 1, Buffer.from('retry'));
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Finalization failed/);
    const session = path.join(ROOT, '_chunks', chunkSessionKey('u1', 'storage-retry'));
    expect(fs.existsSync(session)).toBe(true);
    const retry = await chunkReq('storage-retry', 0, 1, Buffer.from('retry'));
    expect(retry.status).toBe(200);
    expect(retry.body.done).toBe(true);
  });

  it('storage ownership failure invokes rollback and keeps the upload retryable', async () => {
    mockUploadsInsert.mockRejectedValueOnce(new Error('ownership down'));
    const res = await chunkReq('ownership-retry', 0, 1, Buffer.from('retry'));
    expect(res.status).toBe(500);
    expect(mockDeleteFile).toHaveBeenCalled();
    const retry = await chunkReq('ownership-retry', 0, 1, Buffer.from('retry'));
    expect(retry.status).toBe(200);
  });

  it('rejects a request body that exceeds the per-chunk limit and discards the partial file', async () => {
    const res = await chunkReq('oversized-chunk-body', 0, 2, Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/single chunk too large/i);
    expect(mockCommitChunk).not.toHaveBeenCalled();
  });

  it('turns manifest creation and read failures into 500s and purges the corrupt session', async () => {
    const originalWrite = fs.writeFileSync.bind(fs);
    const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: any[]) => {
      if (String(file).endsWith('manifest.json')) {
        const err = Object.assign(new Error('manifest disk unavailable'), { code: 'EIO' });
        throw err;
      }
      return (originalWrite as any)(file, ...args);
    }) as any);
    try {
      const failed = await chunkReq('manifest-write-error', 0, 2, Buffer.from('A'));
      expect(failed.status).toBe(500);
      expect(failed.body.error).toMatch(/manifest disk unavailable/i);
    } finally {
      writeSpy.mockRestore();
    }

    expect((await chunkReq('manifest-read-error', 0, 2, Buffer.from('A'))).status).toBe(200);
    const originalRead = fs.readFileSync.bind(fs);
    const readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: any[]) => {
      if (String(file).endsWith('manifest.json')) throw new Error('manifest unreadable');
      return (originalRead as any)(file, ...args);
    }) as any);
    try {
      const failed = await chunkReq('manifest-read-error', 0, 2, Buffer.from('A'));
      expect(failed.status).toBe(500);
      expect(failed.body.error).toMatch(/manifest unreadable/i);
    } finally {
      readSpy.mockRestore();
    }
  });

  it('reports atomic chunk-commit and finalization-lock failures without storing bytes', async () => {
    mockCommitChunk.mockImplementationOnce(() => { throw new Error('commit disk failed'); });
    let res = await chunkReq('commit-failure', 0, 1, Buffer.from('A'));
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/chunk commit failed/i);

    mockTryAcquireFinalization.mockImplementationOnce(() => { throw new Error('lock disk failed'); });
    res = await chunkReq('lock-failure', 0, 1, Buffer.from('A'));
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/finalization lock/i);
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('distinguishes boost entitlement overflow from the absolute upload-size policy', async () => {
    mockValidateFinalSize.mockReturnValueOnce({ ok: false, code: 'BOOST_LIMIT', maxBytes: 25 * 1024 * 1024 });
    let res = await chunkReq('boost-size-reject', 0, 1, Buffer.from('A'));
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('BOOST_LIMIT');

    mockValidateFinalSize.mockReturnValueOnce({ ok: false, code: 'MAX_FILE_SIZE', maxBytes: 2 * 1024 * 1024 * 1024 });
    res = await chunkReq('absolute-size-reject', 0, 1, Buffer.from('A'));
    expect(res.status).toBe(413);
    expect(res.body.code).toBeUndefined();
    expect(res.body.error).toMatch(/2048MB/);
  });

  it('purges a complete chunk session on magic mismatch', async () => {
    mockCheckMagic.mockReturnValueOnce(false);
    const res = await chunkReq('chunk-magic-mismatch', 0, 1, Buffer.from('not-the-declared-type'));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/declared type/i);
    expect(mockScanFile).not.toHaveBeenCalled();
  });

  it('uses the scanner default status and accepts a safe chunked SVG', async () => {
    mockScanFile.mockRejectedValueOnce(new Error('scanner rejected'));
    let res = await chunkReq('scanner-default-status', 0, 1, Buffer.from('bad'));
    expect(res.status).toBe(422);

    res = await chunkReq('safe-chunk-svg', 0, 1, Buffer.from('<svg/>'), { name: 'safe.svg', type: 'image/svg+xml' });
    expect(res.status).toBe(200);
    expect(mockSanitizeSvg).toHaveBeenCalledTimes(1);
  });

  it('returns a successful response even if best-effort finalization-lock cleanup fails', async () => {
    mockTryAcquireFinalization.mockReturnValueOnce({
      acquired: true,
      release: () => { throw new Error('unlock failed'); },
    });
    const res = await chunkReq('unlock-cleanup-failure', 0, 1, Buffer.from('A'));
    expect(res.status).toBe(200);
    expect(res.body.done).toBe(true);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'upload.chunk_finalize_unlock_failed' }),
      expect.any(String),
    );
  });

  it('stores a completed chunk under a remote private key without leaking that origin', async () => {
    mockGetPrivateProvider.mockReturnValue('r2');
    mockUploadFile.mockImplementationOnce(async (_p: string, key: string) => ({
      url: `https://private.invalid/${key}`, key, provider: 'r2',
    }));
    const res = await chunkReq('remote-private-chunk', 0, 1, Buffer.from('A'), { name: '../remote name.txt' });
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^\/uploads\//);
    expect(res.body.url).not.toContain('private.invalid');
    expect(mockUploadFile.mock.calls[0][1]).toMatch(/^uploads\//);
  });
});

describe('server GIF upload deep behavior', () => {
  const gif = Buffer.from('GIF89a123456');

  it('stores a valid image and records ownership', async () => {
    const res = await request(app).post('/api/upload/server-gif').set('Authorization', auth('gif-owner')).attach('gif', gif, { filename: 'x.gif', contentType: 'image/gif' });
    expect(res.status).toBe(200);
    expect(res.body.fileType).toBe('image/gif');
    expect(mockUploadFile).toHaveBeenCalled();
    expect(mockUploadsInsert).toHaveBeenCalledWith(expect.objectContaining({ userId: 'gif-owner', mimeType: 'image/gif' }));
  });

  it('rejects magic mismatch before storage', async () => {
    mockCheckMagic.mockReturnValueOnce(false);
    const res = await request(app).post('/api/upload/server-gif').set('Authorization', auth()).attach('gif', gif, { filename: 'x.gif', contentType: 'image/gif' });
    expect(res.status).toBe(400);
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('runs public server GIF bytes through the canonical content scanner', async () => {
    mockScanFile.mockRejectedValueOnce({ statusCode: 451, message: 'known malicious image', code: 'MALWARE' });
    const res = await request(app).post('/api/upload/server-gif').set('Authorization', auth())
      .attach('gif', gif, { filename: 'malware.gif', contentType: 'image/gif' });
    expect(res.status).toBe(451);
    expect(res.body).toEqual({ error: 'known malicious image', code: 'MALWARE' });
    expect(mockUploadFile).not.toHaveBeenCalled();
    expect(mockUploadsInsert).not.toHaveBeenCalled();
  });

  it('reports a truncated multipart body as bounded client input failure', async () => {
    const boundary = 'bridge-truncated-gif-boundary';
    const res = await request(app).post('/api/upload/server-gif')
      .set('Authorization', auth())
      .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
      .send(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="gif"; filename="x.gif"\r\n` +
        'Content-Type: image/gif\r\n\r\nGIF89a',
      ));
    expect(res.status).toBe(400);
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('enforces the same live boost entitlement as ordinary uploads', async () => {
    mockGetHighestActiveTier.mockResolvedValueOnce(0);
    const overFreeTier = Buffer.alloc(25 * 1024 * 1024 + 1, 0x61);
    const res = await request(app).post('/api/upload/server-gif').set('Authorization', auth('free-gif-user'))
      .attach('gif', overFreeTier, { filename: 'large.gif', contentType: 'image/gif' });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('BOOST_LIMIT');
    expect(mockScanFile).not.toHaveBeenCalled();
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('propagates storage failure without recording ownership', async () => {
    mockUploadFile.mockRejectedValueOnce(new Error('gif store down'));
    const res = await request(app).post('/api/upload/server-gif').set('Authorization', auth()).attach('gif', gif, { filename: 'x.gif', contentType: 'image/gif' });
    expect(res.status).toBe(500);
    expect(mockUploadsInsert).not.toHaveBeenCalled();
  });

  it('uses scanner status fallback and emits provider metadata for a remote GIF', async () => {
    mockScanFile.mockRejectedValueOnce(new Error('scanner rejected gif'));
    let res = await request(app).post('/api/upload/server-gif').set('Authorization', auth())
      .attach('gif', gif, { filename: 'x.gif', contentType: 'image/gif' });
    expect(res.status).toBe(422);

    mockGetProvider.mockReturnValue('s3');
    mockUploadFile.mockImplementationOnce(async (_p: string, key: string) => ({
      url: `https://cdn.invalid/${key}`, key, provider: 's3',
    }));
    res = await request(app).post('/api/upload/server-gif').set('Authorization', auth('gif-remote'))
      .attach('gif', gif, { filename: 'remote.gif', contentType: 'image/gif' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ cdn: 's3', key: expect.stringMatching(/^uploads\/server-gifs\//) }));
  });
});

describe('CDN delete provider and metadata compatibility branches', () => {
  const rootKey = 'uploads/private.txt';
  const publicKey = 'uploads/server-gifs/public.gif';

  it('rejects an authenticated request whose canonical user id is missing', async () => {
    const res = await request(app).delete('/api/upload/cdn').set('Authorization', auth('missing-id')).query({ key: rootKey });
    expect(res.status).toBe(401);
    expect(mockUploadsFindOne).not.toHaveBeenCalled();
  });

  it('uses the public adapter branch for subdirectory assets', async () => {
    mockUploadsFindOne.mockResolvedValueOnce({ _id: 'row', userId: 'owner', key: publicKey });
    mockGetProvider.mockReturnValue('s3');
    const res = await request(app).delete('/api/upload/cdn').set('Authorization', auth('owner')).query({ key: publicKey });
    expect(res.status).toBe(200);
    expect(mockDeleteFile).toHaveBeenCalledWith('uploads/server-gifs/public.gif');
  });

  it('still succeeds when a legacy metadata adapter exposes neither remove nor delete', async () => {
    mockUploadsFindOne.mockResolvedValueOnce({ _id: 'row', userId: 'owner', key: rootKey });
    const loader = require('../db/loader').default as { uploads: { remove?: unknown; delete?: unknown } };
    const oldRemove = loader.uploads.remove;
    const oldDelete = loader.uploads.delete;
    loader.uploads.remove = undefined;
    loader.uploads.delete = undefined;
    try {
      const res = await request(app).delete('/api/upload/cdn').set('Authorization', auth('owner')).query({ key: rootKey });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ deleted: true, key: rootKey });
    } finally {
      loader.uploads.remove = oldRemove;
      loader.uploads.delete = oldDelete;
    }
  });
});
