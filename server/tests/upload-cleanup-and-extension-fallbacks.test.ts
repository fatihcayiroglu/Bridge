// server/tests/upload-cleanup-and-extension-fallbacks.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// YÜKLEME — REDDEDİLEN BAYTLARIN TEMİZLİĞİ VE UZANTI YEDEĞİ
// ════════════════════════════════════════════════════════════════════════════
//
// Bir yükleme reddedildiğinde geriye HİÇBİR ŞEY kalmamalıdır: multer baytları
// zaten diske yazmıştır, dolayısıyla ret yolu bir SİLME yoludur. Ölçülenler:
//
//   · TEMİZLİK, dosya ARADA KAYBOLSA BİLE çalışmalıdır. Tarayıcı (scanner)
//     karantinaya alıp dosyayı kendisi silmiş olabilir; `unlink` o zaman
//     patlamamalı ve istek yine doğru durum koduyla bitmelidir.
//   · TARAYICI DURUM KODU çağırana AKTARILIR (ör. 451), yoksa 422 kullanılır.
//     Genel bir 500, istemciye "sunucu bozuk" der; oysa dosya reddedilmiştir.
//   · UZANTI YEDEĞİ. Kanonik uzantısı olmayan bir MIME türü için dosya adı
//     uzantısız üretilir — `undefined` metni dosya adına GİRMEZ.
//   · SUNUCU GIF dizini zaten varsa yeniden oluşturulmaz.

import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-upload-cleanup-'));
// Pre-create the server-GIF directory so module load takes the "already
// exists" path rather than creating it.
fs.mkdirSync(path.join(ROOT, 'server-gifs'), { recursive: true });

process.env.NODE_ENV = 'test';
process.env.BRIDGE_UPLOAD_ROOT = ROOT;
process.env.MAX_FILE_SIZE_MB = '64';
delete process.env.WEBP_CONVERT;

// Imza ACIKCA yazilir: @types/jest'te `Mock<T, Y>` icin Y varsayilani
// `any`dir (`any[]` DEGIL), yani bare `jest.fn()` REST parametresi
// tasimaz ve `mock(...args)` TS2556 verir.
const mockCheckMagic = jest.fn<boolean, unknown[]>(() => true);
const mockScanFile = jest.fn().mockResolvedValue(undefined);
const mockSanitizeSvg = jest.fn().mockResolvedValue({ safe: true });
const mockUploadFile = jest.fn<Promise<{ url: string; key: string | null; provider: string }>, [path: string, key: string]>(
  async (_p, key) => ({ url: `/public/${key}`, key: null, provider: 'local' }));
const mockDeleteFile = jest.fn().mockResolvedValue(undefined);
const mockUploadsInsert = jest.fn().mockResolvedValue({ _id: 'row' });
const mockTier = jest.fn().mockResolvedValue(3);
const mockProvider = jest.fn(() => 'local');

jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    const value = String(req.headers.authorization || '');
    if (!value.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const id = value.slice(7);
    // `no-id` models an auth context that authenticated but carries no user id.
    req.user = id === 'no-id' ? { username: 'anonymous' } : { id, username: `user-${id}` };
    next();
  },
}));
jest.mock('../middleware/rateLimit', () => ({ limits: { upload: () => (_r: any, _s: any, n: any) => n() } }));
jest.mock('../lib/adminAuthority', () => ({
  isDatabaseAdmin: jest.fn(async () => false),
  databaseAdminOnly: (_r: any, _s: any, n: any) => n(),
}));
jest.mock('../lib/contentScanner', () => ({ scanFile: (...a: any[]) => mockScanFile(...a) }));
jest.mock('../lib/svgSanitizer', () => ({ sanitizeSvgFile: (...a: any[]) => mockSanitizeSvg(...a) }));
jest.mock('../lib/uploadFileSafety', () => ({
  // Unmapped types deliberately return undefined so the route's own `?? ''`
  // fallback is what decides the stored name.
  canonicalExtensionForMime: (mime: string) => ({
    'image/png': '.png', 'image/gif': '.gif', 'text/plain': '.txt',
  } as Record<string, string>)[mime],
  checkMagicBytes: (...a: any[]) => mockCheckMagic(...a),
}));
jest.mock('../lib/storageAdapter', () => ({
  getStorageAdapter: () => ({ uploadFile: mockUploadFile, deleteFile: mockDeleteFile }),
  getPrivateStorageAdapter: () => ({ uploadFile: mockUploadFile, deleteFile: mockDeleteFile }),
  getProvider: () => mockProvider(),
  getPrivateStorageProvider: () => 'local',
}));
jest.mock('../db/postgres', () => ({ db: { _pool: { query: async () => ({ rows: [{ referenced: false }] }) } } }));
jest.mock('../db/repositories', () => ({ Boosts: { getHighestActiveTierForUser: (...a: any[]) => mockTier(...a) } }));
jest.mock('../db/loader', () => ({
  __esModule: true,
  default: { uploads: { insert: (...a: any[]) => mockUploadsInsert(...a), findOne: async () => null, remove: jest.fn() } },
}));
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const router = require('../routes/upload').default;

const app = express();
app.use('/api/upload', router);
app.use((err: any, _req: any, res: any, _next: any) => res.status(err.status || 500).json({ error: err.message }));

const BYTES = Buffer.from('some payload bytes');

function upload(filename: string, contentType: string, auth = 'u1') {
  return request(app).post('/api/upload').set('Authorization', `Bearer ${auth}`)
    .attach('file', BYTES, { filename, contentType });
}
function uploadGif(filename = 'sticker.gif', contentType = 'image/gif', auth = 'u1') {
  return request(app).post('/api/upload/server-gif').set('Authorization', `Bearer ${auth}`)
    .attach('gif', BYTES, { filename, contentType });
}
function chunkOnce(id: string, name: string, type: string) {
  return request(app).post('/api/upload/chunk')
    .set('Authorization', 'Bearer u1')
    .set('Content-Type', 'application/octet-stream')
    .set('x-upload-id', id).set('x-chunk-index', '0').set('x-total-chunks', '1')
    .set('x-file-name', name).set('x-file-type', type)
    .send(BYTES);
}

/** A scanner that quarantines (removes) the file before rejecting. */
function quarantiningScanner(rejection: unknown) {
  return jest.fn(async (filePath: string) => {
    try { fs.unlinkSync(filePath); } catch { /* already gone */ }
    throw rejection;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCheckMagic.mockReturnValue(true);
  mockScanFile.mockResolvedValue(undefined);
  mockSanitizeSvg.mockResolvedValue({ safe: true });
  mockUploadFile.mockImplementation(async (_p: string, key: string) => ({ url: `/public/${key}`, key: null, provider: 'local' }));
  mockUploadsInsert.mockResolvedValue({ _id: 'row' });
  mockTier.mockResolvedValue(3);
  mockProvider.mockReturnValue('local');
  // Each case asserts "nothing was left behind", so start from a clean root.
  for (const name of storedFiles()) fs.rmSync(path.join(ROOT, name), { recursive: true, force: true });
});

afterAll(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

function storedFiles(dir = ROOT): string[] {
  return fs.readdirSync(dir).filter(n => n !== '_chunks' && n !== 'server-gifs');
}

describe('a rejected single upload leaves nothing behind', () => {
  it('propagates the scanner status even when the scanner already removed the file', async () => {
    mockScanFile.mockImplementation(quarantiningScanner({ statusCode: 451, message: 'malware', code: 'MALWARE' }));

    const res = await upload('infected.png', 'image/png');

    expect(res.status).toBe(451);
    expect(res.body).toEqual({ error: 'malware', code: 'MALWARE' });
    expect(storedFiles()).toEqual([]);
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('falls back to 422 when the scanner gives no status', async () => {
    mockScanFile.mockImplementation(quarantiningScanner(new Error('scanner unavailable')));
    const res = await upload('unknown.png', 'image/png');
    expect(res.status).toBe(422);
    expect(storedFiles()).toEqual([]);
  });

  it('a storage failure removes the bytes even if they already vanished', async () => {
    mockUploadFile.mockImplementation(async (filePath: string) => {
      fs.unlinkSync(filePath);
      throw new Error('object store offline');
    });

    const res = await upload('lost.png', 'image/png');

    expect(res.status).toBe(500);
    expect(storedFiles()).toEqual([]);
    expect(mockUploadsInsert).not.toHaveBeenCalled();
  });

  it('a type with no canonical extension is stored under a bare id', async () => {
    const res = await upload('data.bin', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^\/uploads\/[0-9a-f-]+$/);
  });

  it('an auth context with no user id skips the boost lookup but still stores', async () => {
    const res = await upload('anon.png', 'image/png', 'no-id');
    expect(res.status).toBe(200);
    expect(mockTier).not.toHaveBeenCalled();
  });

  it('a disallowed type is a 400 that names the reason', async () => {
    const res = await upload('page.html', 'text/html');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/File type not allowed/);
    expect(storedFiles()).toEqual([]);
  });

  it('a request with no file at all is a 400', async () => {
    const res = await request(app).post('/api/upload').set('Authorization', 'Bearer u1');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('No file uploaded');
  });
});

describe('a rejected chunked upload leaves nothing behind', () => {
  it('propagates the scanner status when the merged file was quarantined', async () => {
    mockScanFile.mockImplementation(quarantiningScanner({ statusCode: 451, message: 'malware', code: 'MALWARE' }));

    const res = await chunkOnce('cleanup-scan', 'infected.png', 'image/png');

    expect(res.status).toBe(451);
    expect(res.body.code).toBe('MALWARE');
    expect(storedFiles()).toEqual([]);
  });

  it('a chunked type with no canonical extension is stored under a bare id', async () => {
    const res = await chunkOnce('cleanup-ext', 'payload.bin', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^\/uploads\/[0-9a-f-]+$/);
    // The client name keeps its own extension only when the type maps to one;
    // with no canonical extension the stored name is the bare base.
    expect(res.body.fileName).toBe('payload');
    expect(res.body.fileType).toBe('application/json');
  });

  it('a storage failure during finalization is reported and cleaned up', async () => {
    mockUploadFile.mockImplementation(async (filePath: string) => {
      fs.unlinkSync(filePath);
      throw new Error('object store offline');
    });

    const res = await chunkOnce('cleanup-store', 'file.txt', 'text/plain');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/^Finalization failed: object store offline$/);
    expect(storedFiles()).toEqual([]);
  });
});

describe('server GIF uploads', () => {
  it('stores an allowed image and records ownership under the gif namespace', async () => {
    const res = await uploadGif();
    expect(res.status).toBe(200);
    expect(res.body.fileType).toBe('image/gif');
    expect(mockUploadsInsert).toHaveBeenCalledWith(expect.objectContaining({
      key: expect.stringMatching(/^uploads\/server-gifs\/gif_[0-9a-f-]+\.gif$/),
    }));
  });

  it('a type with no canonical extension still produces a bare gif id', async () => {
    const res = await uploadGif('x.webp', 'image/webp');
    expect(res.status).toBe(200);
    expect(mockUploadsInsert).toHaveBeenCalledWith(expect.objectContaining({
      key: expect.stringMatching(/^uploads\/server-gifs\/gif_[0-9a-f-]+$/),
    }));
  });

  it('propagates the scanner status when the file was already quarantined', async () => {
    mockScanFile.mockImplementation(quarantiningScanner({ statusCode: 451, message: 'malware', code: 'MALWARE' }));
    const res = await uploadGif();
    expect(res.status).toBe(451);
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('a storage failure removes the bytes even if they already vanished', async () => {
    mockUploadFile.mockImplementation(async (filePath: string) => {
      fs.unlinkSync(filePath);
      throw new Error('object store offline');
    });
    const res = await uploadGif();
    expect(res.status).toBe(500);
    expect(mockUploadsInsert).not.toHaveBeenCalled();
  });

  it('a magic-byte mismatch is refused and nothing is stored', async () => {
    mockCheckMagic.mockReturnValue(false);
    const res = await uploadGif();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('File content mismatch');
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('a non-image type is refused by the filter', async () => {
    const res = await uploadGif('notes.txt', 'text/plain');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Only image files allowed for GIFs/);
  });

  it('a request with no file is a 400', async () => {
    const res = await request(app).post('/api/upload/server-gif').set('Authorization', 'Bearer u1');
    expect(res.status).toBe(400);
  });

  it('a remote provider stores under an explicit CDN key', async () => {
    mockProvider.mockReturnValue('s3');
    mockUploadFile.mockImplementation(async (_p: string, key: string) => ({ url: `https://cdn/${key}`, key, provider: 's3' }));

    const res = await uploadGif();

    expect(res.status).toBe(200);
    expect(res.body.cdn).toBe('s3');
    expect(mockUploadFile.mock.calls[0]![1]).toMatch(/^uploads\/server-gifs\/gif_/);
  });

  it('a boost tier below the file size refuses the upload', async () => {
    mockTier.mockResolvedValue(99);
    const big = Buffer.alloc(26 * 1024 * 1024, 0x41);
    const res = await request(app).post('/api/upload/server-gif').set('Authorization', 'Bearer u1')
      .attach('gif', big, { filename: 'huge.gif', contentType: 'image/gif' });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('BOOST_LIMIT');
  });
});
