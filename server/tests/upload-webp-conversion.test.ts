// server/tests/upload-webp-conversion.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// YÜKLEME — İSTEĞE BAĞLI WEBP DÖNÜŞÜMÜ (WEBP_CONVERT=true)
// ════════════════════════════════════════════════════════════════════════════
//
// `WEBP_CONVERT` modül yüklenirken bir kez okunur, bu yüzden dönüşüm yolu
// yalnızca AYRI bir test dosyasında ölçülebilir. Kapsanan sözleşme:
//
//   · KİMLİK TUTARLILIĞI — dönüşüm dosya adını, uzantısını, MIME türünü ve
//     depolama anahtarını AYNI ANDA değiştirmelidir. Yalnız biri değişirse
//     istemci var olmayan bir adresi indirmeye çalışır ya da `.png` adıyla
//     WebP baytları servis edilir.
//   · SEÇİCİLİK — GIF (animasyon) ve SVG (vektör) dönüştürülmez; dönüşüm
//     bunları bozardı.
//   · TEMİZLİK — dönüşüm yarıda kalırsa yarım `.webp` dosyası diskte
//     KALMAMALIDIR; sonlandırma başarısız olursa hem dönüştürülmüş hem de
//     kaynak dosya silinmelidir.

import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-upload-webp-'));
process.env.NODE_ENV = 'test';
process.env.BRIDGE_UPLOAD_ROOT = ROOT;
process.env.MAX_FILE_SIZE_MB = '8';
process.env.WEBP_CONVERT = 'true';
process.env.WEBP_QUALITY = '61';

const toFile = jest.fn(async (out: string) => {
  fs.writeFileSync(out, Buffer.from('RIFF....WEBPVP8 '));
  return { size: 16 };
});
const webpOptions = jest.fn();
const sharpCalls: string[] = [];
const sharpFn = jest.fn((input: string) => {
  sharpCalls.push(input);
  return {
    webp: (opts: Record<string, unknown>) => { webpOptions(opts); return { toFile }; },
  };
});

jest.mock('sharp', () => ({ __esModule: true, default: (input: string) => sharpFn(input) }), { virtual: true });

// Imza ACIKCA yazilir: @types/jest'te `Mock<T, Y>` icin Y varsayilani
// `any`dir (`any[]` DEGIL), yani bare `jest.fn()` REST parametresi
// tasimaz ve `mock(...args)` TS2556 verir.
const mockCheckMagic = jest.fn<boolean, unknown[]>(() => true);
const mockScanFile = jest.fn().mockResolvedValue(undefined);
const mockSanitizeSvg = jest.fn().mockResolvedValue({ safe: true });
const mockUploadFile = jest.fn(async (_p: string, key: string) => ({ url: `/public/${key}`, key: null, provider: 'local' }));
const mockDeleteFile = jest.fn().mockResolvedValue(undefined);
const mockUploadsInsert = jest.fn().mockResolvedValue({ _id: 'row' });
const mockUploadsRemove = jest.fn().mockResolvedValue(undefined);
const mockTier = jest.fn().mockResolvedValue(3);
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();

jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    const value = String(req.headers.authorization || '');
    if (!value.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    req.user = { id: value.slice(7) || 'u1', username: 'tester' };
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
  // Deliberately returns undefined for an unmapped type so the route's own
  // `?? ''` fallback is what decides the stored extension.
  canonicalExtensionForMime: (mime: string) => ({
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
    'image/svg+xml': '.svg', 'image/webp': '.webp', 'text/plain': '.txt',
  } as Record<string, string>)[mime],
  checkMagicBytes: (...a: any[]) => mockCheckMagic(...a),
}));
jest.mock('../lib/storageAdapter', () => ({
  getStorageAdapter: () => ({ uploadFile: mockUploadFile, deleteFile: mockDeleteFile }),
  getPrivateStorageAdapter: () => ({ uploadFile: mockUploadFile, deleteFile: mockDeleteFile }),
  getProvider: () => 'local',
  getPrivateStorageProvider: () => 'local',
}));
jest.mock('../db/postgres', () => ({ db: { _pool: { query: async () => ({ rows: [{ referenced: false }] }) } } }));
jest.mock('../db/repositories', () => ({
  Boosts: { getHighestActiveTierForUser: (...a: any[]) => mockTier(...a) },
}));
jest.mock('../db/loader', () => ({
  __esModule: true,
  default: {
    uploads: {
      insert: (...a: any[]) => mockUploadsInsert(...a),
      findOne: async () => null,
      remove: (...a: any[]) => mockUploadsRemove(...a),
    },
  },
}));
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(), debug: jest.fn(),
    warn: (...a: any[]) => mockLoggerWarn(...a),
    error: (...a: any[]) => mockLoggerError(...a),
  },
}));

const router = require('../routes/upload').default;

const app = express();
app.use('/api/upload', router);
app.use((err: any, _req: any, res: any, _next: any) => res.status(err.status || 500).json({ error: err.message }));

const PNG = Buffer.from('\x89PNG\r\n\x1a\n fake png payload');

function uploadPng(filename = 'photo.png', contentType = 'image/png') {
  return request(app).post('/api/upload').set('Authorization', 'Bearer u1')
    .attach('file', PNG, { filename, contentType });
}

function chunkOnce(id: string, body: Buffer, name: string, type: string) {
  return request(app).post('/api/upload/chunk')
    .set('Authorization', 'Bearer u1')
    .set('Content-Type', 'application/octet-stream')
    .set('x-upload-id', id).set('x-chunk-index', '0').set('x-total-chunks', '1')
    .set('x-file-name', name).set('x-file-type', type)
    .send(body);
}

function uploadedFiles(): string[] {
  return fs.readdirSync(ROOT).filter(n => n !== '_chunks' && n !== 'server-gifs');
}

beforeEach(() => {
  jest.clearAllMocks();
  sharpCalls.length = 0;
  mockCheckMagic.mockReturnValue(true);
  mockScanFile.mockResolvedValue(undefined);
  mockSanitizeSvg.mockResolvedValue({ safe: true });
  mockUploadFile.mockImplementation(async (_p: string, key: string) => ({ url: `/public/${key}`, key: null, provider: 'local' }));
  mockUploadsInsert.mockResolvedValue({ _id: 'row' });
  mockTier.mockResolvedValue(3);
  toFile.mockImplementation(async (out: string) => {
    fs.writeFileSync(out, Buffer.from('RIFF....WEBPVP8 '));
    return { size: 16 };
  });
  for (const name of uploadedFiles()) fs.rmSync(path.join(ROOT, name), { recursive: true, force: true });
});

afterAll(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

describe('raster uploads are converted to WebP as one consistent identity', () => {
  it('renames, re-types and re-keys the stored object together', async () => {
    const res = await uploadPng().expect(200);

    expect(res.body.webp).toBe(true);
    expect(res.body.fileType).toBe('image/webp');
    expect(res.body.url).toMatch(/^\/uploads\/[0-9a-f-]+\.webp$/);
    expect(res.body.fileName).toBe('photo.webp');

    // The bytes handed to storage are the converted file, under the same
    // basename the URL advertises.
    const [storedPath, storedKey, opts] = mockUploadFile.mock.calls[0] as any[];
    expect(storedPath.endsWith('.webp')).toBe(true);
    expect(path.basename(storedPath)).toBe(path.basename(res.body.url));
    expect(storedKey).toBe(path.basename(res.body.url));
    expect(opts).toEqual({ contentType: 'image/webp' });

    // Ownership is recorded against the converted key, not the original one.
    expect(mockUploadsInsert).toHaveBeenCalledWith(expect.objectContaining({
      key: `uploads/${path.basename(res.body.url)}`, mimeType: 'image/webp',
    }));
  });

  it('uses the configured quality and removes the original file', async () => {
    const res = await uploadPng().expect(200);
    expect(webpOptions).toHaveBeenCalledWith({ quality: 61, effort: 4 });

    const original = sharpCalls[0]!;
    expect(original.endsWith('.png')).toBe(true);
    // fs.unlink of the source is fire-and-forget; give the loop one turn.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fs.existsSync(original)).toBe(false);
    expect(uploadedFiles().some(n => n.endsWith('.webp'))).toBe(true);
  });

  it('converts a JPEG the same way and keeps working across repeated uploads', async () => {
    const first = await request(app).post('/api/upload').set('Authorization', 'Bearer u1')
      .attach('file', PNG, { filename: 'a.jpg', contentType: 'image/jpeg' }).expect(200);
    const second = await request(app).post('/api/upload').set('Authorization', 'Bearer u1')
      .attach('file', PNG, { filename: 'b.jpg', contentType: 'image/jpeg' }).expect(200);

    expect(first.body.webp).toBe(true);
    expect(second.body.webp).toBe(true);
    // The optional dependency is resolved once and reused for later requests.
    expect(sharpFn).toHaveBeenCalledTimes(2);
    expect(first.body.url).not.toBe(second.body.url);
  });
});

describe('non-raster images are left alone', () => {
  it('a GIF keeps its animation, name and type', async () => {
    const res = await request(app).post('/api/upload').set('Authorization', 'Bearer u1')
      .attach('file', Buffer.from('GIF89a fake'), { filename: 'loop.gif', contentType: 'image/gif' })
      .expect(200);
    expect(res.body.webp).toBeUndefined();
    expect(res.body.fileType).toBe('image/gif');
    expect(res.body.fileName).toBe('loop.gif');
    expect(res.body.url).toMatch(/\.gif$/);
    expect(sharpFn).not.toHaveBeenCalled();
  });

  it('an SVG stays a vector after sanitization', async () => {
    const res = await request(app).post('/api/upload').set('Authorization', 'Bearer u1')
      .attach('file', Buffer.from('<svg/>'), { filename: 'icon.svg', contentType: 'image/svg+xml' })
      .expect(200);
    expect(res.body.fileType).toBe('image/svg+xml');
    expect(res.body.url).toMatch(/\.svg$/);
    expect(mockSanitizeSvg).toHaveBeenCalled();
    expect(sharpFn).not.toHaveBeenCalled();
  });

  it('a type with no canonical extension is still stored under a bare id', async () => {
    const res = await request(app).post('/api/upload').set('Authorization', 'Bearer u1')
      .attach('file', Buffer.from('{"a":1}'), { filename: 'data.json', contentType: 'application/json' })
      .expect(200);
    expect(res.body.url).toMatch(/^\/uploads\/[0-9a-f-]+$/);
    expect(res.body.fileType).toBe('application/json');
    expect(sharpFn).not.toHaveBeenCalled();
  });
});

describe('a failed conversion leaves nothing half-written', () => {
  it('removes the partially written .webp and reports the failure', async () => {
    toFile.mockImplementationOnce(async (out: string) => {
      fs.writeFileSync(out, Buffer.from('partial'));
      throw new Error('encoder aborted mid-frame');
    });
    const res = await uploadPng();
    expect(res.status).toBe(500);
    expect(uploadedFiles().filter(n => n.endsWith('.webp'))).toEqual([]);
    // Nothing was stored or attributed to the user.
    expect(mockUploadFile).not.toHaveBeenCalled();
    expect(mockUploadsInsert).not.toHaveBeenCalled();
  });

  it('a conversion that never produced a file is reported the same way', async () => {
    toFile.mockImplementationOnce(async () => { throw new Error('unsupported colour profile'); });
    const res = await uploadPng();
    expect(res.status).toBe(500);
    expect(uploadedFiles().filter(n => n.endsWith('.webp'))).toEqual([]);
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('a storage failure after conversion deletes the converted bytes', async () => {
    mockUploadFile.mockRejectedValueOnce(new Error('object store offline'));
    const res = await uploadPng();
    expect(res.status).toBe(500);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(uploadedFiles().filter(n => n.endsWith('.webp'))).toEqual([]);
    expect(mockUploadsInsert).not.toHaveBeenCalled();
  });
});

describe('chunked uploads convert on finalization', () => {
  it('the finalized chunk set is stored, named and typed as WebP', async () => {
    const res = await chunkOnce('webp-chunk', PNG, 'scan.png', 'image/png').expect(200);
    expect(res.body.done).toBe(true);
    expect(res.body.fileType).toBe('image/webp');
    expect(res.body.fileName).toBe('scan.webp');
    expect(res.body.url).toMatch(/^\/uploads\/[0-9a-f-]+\.webp$/);
    // `size` stays the size of the merged ORIGINAL: it is the bytes the client
    // actually sent, and the client uses it to confirm the transfer.
    expect(res.body.size).toBe(PNG.length);
    expect(path.basename((mockUploadFile.mock.calls[0] as any[])[0])).toBe(path.basename(res.body.url));
  });

  it('a non-raster chunk set keeps its own extension', async () => {
    const res = await chunkOnce('plain-chunk', Buffer.from('hello'), 'notes.txt', 'text/plain').expect(200);
    expect(res.body.fileName).toBe('notes.txt');
    expect(res.body.fileType).toBe('text/plain');
    expect(res.body.url).toMatch(/\.txt$/);
    expect(sharpFn).not.toHaveBeenCalled();
  });

  it('a storage failure after chunk conversion removes both the converted and merged files', async () => {
    mockUploadFile.mockRejectedValueOnce(new Error('object store offline'));
    const res = await chunkOnce('webp-chunk-fail', PNG, 'scan.png', 'image/png');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/^Finalization failed: object store offline$/);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(uploadedFiles().filter(n => n.endsWith('.webp') || n.endsWith('.png'))).toEqual([]);
    expect(mockUploadsInsert).not.toHaveBeenCalled();
  });

  it('a chunk set whose conversion fails is reported as a finalization failure', async () => {
    toFile.mockImplementationOnce(async () => { throw new Error('encoder aborted'); });
    const res = await chunkOnce('webp-chunk-convert-fail', PNG, 'scan.png', 'image/png');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Finalization failed: encoder aborted/);
    expect(mockUploadFile).not.toHaveBeenCalled();
  });
});

describe('boost tier limits', () => {
  it('an unrecognised tier falls back to the 25 MB floor rather than to no limit', async () => {
    mockTier.mockResolvedValue(99);
    const res = await uploadPng().expect(200);
    // 25 MB floor: this small file is accepted, and the tier lookup did run.
    expect(mockTier).toHaveBeenCalledWith('u1');
    expect(res.body.webp).toBe(true);
  });

  it('a failing entitlement lookup does not open the gate', async () => {
    mockTier.mockRejectedValue(new Error('boost table offline'));
    const res = await uploadPng().expect(200);
    expect(res.body.webp).toBe(true);
  });
});
