// server/tests/upload-webp-sharp-unavailable.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// YÜKLEME — WEBP_CONVERT=true AMA `sharp` YÜKLÜ DEĞİL
// ════════════════════════════════════════════════════════════════════════════
//
// `sharp` yerel derlenmiş bir bağımlılıktır ve bir konteyner imajında pekâlâ
// eksik olabilir. O durumda YÜKLEME ÇALIŞMAYA DEVAM ETMELİDİR: dönüşüm
// sessizce atlanır, dosya kendi türüyle saklanır ve eksiklik BİR KEZ
// loglanır. Alternatif — her görüntü yüklemesinin 500 vermesi — yapılandırma
// hatasını üretim kesintisine çevirirdi.
//
// Bu dosya `tests/upload-webp-conversion.test.ts` ile ayrıdır çünkü hem
// `WEBP_CONVERT` hem de `sharp`'ın yüklenme sonucu modül ömrü boyunca bir
// kez saptanır.

import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-upload-nosharp-'));
process.env.NODE_ENV = 'test';
process.env.BRIDGE_UPLOAD_ROOT = ROOT;
process.env.MAX_FILE_SIZE_MB = '8';
process.env.WEBP_CONVERT = 'true';

// Simulates an image that was built without the optional native dependency.
jest.mock('sharp', () => { throw new Error("Cannot find module 'sharp'"); }, { virtual: true });

const mockUploadFile = jest.fn(async (_p: string, key: string) => ({ url: `/public/${key}`, key: null, provider: 'local' }));
const mockUploadsInsert = jest.fn().mockResolvedValue({ _id: 'row' });
const mockLoggerWarn = jest.fn();

jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    const value = String(req.headers.authorization || '');
    if (!value.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    req.user = { id: value.slice(7) || 'u1', username: 'tester' };
    next();
  },
}));
jest.mock('../middleware/rateLimit', () => ({ limits: { upload: () => (_r: any, _s: any, n: any) => n(), uploadChunk: () => (_r: any, _s: any, n: any) => n() } }));
jest.mock('../lib/adminAuthority', () => ({
  isDatabaseAdmin: jest.fn(async () => false),
  databaseAdminOnly: (_r: any, _s: any, n: any) => n(),
}));
jest.mock('../lib/contentScanner', () => ({ scanFile: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../lib/svgSanitizer', () => ({ sanitizeSvgFile: jest.fn().mockResolvedValue({ safe: true }) }));
jest.mock('../lib/uploadFileSafety', () => ({
  canonicalExtensionForMime: (mime: string) => ({ 'image/png': '.png' } as Record<string, string>)[mime],
  checkMagicBytes: () => true,
}));
jest.mock('../lib/storageAdapter', () => ({
  getStorageAdapter: () => ({ uploadFile: mockUploadFile, deleteFile: jest.fn() }),
  getPrivateStorageAdapter: () => ({ uploadFile: mockUploadFile, deleteFile: jest.fn() }),
  getProvider: () => 'local',
  getPrivateStorageProvider: () => 'local',
}));
jest.mock('../db/postgres', () => ({ db: { _pool: { query: async () => ({ rows: [{ referenced: false }] }) } } }));
jest.mock('../db/repositories', () => ({ Boosts: { getHighestActiveTierForUser: async () => 3 } }));
jest.mock('../db/loader', () => ({
  __esModule: true,
  default: { uploads: { insert: (...a: any[]) => mockUploadsInsert(...a), findOne: async () => null, remove: jest.fn() } },
}));
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: (...a: any[]) => mockLoggerWarn(...a) },
}));

const router = require('../routes/upload').default;

const app = express();
app.use('/api/upload', router);
app.use((err: any, _req: any, res: any, _next: any) => res.status(err.status || 500).json({ error: err.message }));

const PNG = Buffer.from('\x89PNG\r\n\x1a\n fake png payload');

function uploadPng(filename = 'photo.png') {
  return request(app).post('/api/upload').set('Authorization', 'Bearer u1')
    .attach('file', PNG, { filename, contentType: 'image/png' });
}

afterAll(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

describe('WEBP_CONVERT with a missing sharp runtime', () => {
  it('stores the original image instead of failing the upload', async () => {
    const res = await uploadPng().expect(200);

    expect(res.body.webp).toBeUndefined();
    expect(res.body.fileType).toBe('image/png');
    expect(res.body.fileName).toBe('photo.png');
    expect(res.body.url).toMatch(/^\/uploads\/[0-9a-f-]+\.png$/);
    expect(path.basename((mockUploadFile.mock.calls[0] as any[])[0])).toBe(path.basename(res.body.url));
    expect(mockUploadsInsert).toHaveBeenCalledWith(expect.objectContaining({ mimeType: 'image/png' }));
  });

  it('warns once about the missing dependency and does not re-probe it per request', async () => {
    const warnsBefore = mockLoggerWarn.mock.calls.filter(
      ([obj]: any[]) => obj?.event === 'upload.webp.sharp_missing').length;
    // The first upload above already resolved the optional dependency, so the
    // warning must not repeat for every subsequent image.
    expect(warnsBefore).toBe(1);

    await uploadPng('second.png').expect(200);
    await uploadPng('third.png').expect(200);

    const warnsAfter = mockLoggerWarn.mock.calls.filter(
      ([obj]: any[]) => obj?.event === 'upload.webp.sharp_missing').length;
    expect(warnsAfter).toBe(1);
  });
});
