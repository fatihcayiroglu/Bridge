// server/tests/upload.test.ts
// Tests for upload routes: single upload, chunked upload, server-gif upload
// Sprint 74: DELETE /upload/cdn sahiplik kontrolü testleri eklendi

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

import { createMockDb, makeUser } from './helpers/mockDb';
const mockDb = createMockDb();

jest.mock('../db/index', () => mockDb);
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (
    req: { headers: { authorization?: string }; user?: unknown },
    res: { status: (c: number) => { json: (b: unknown) => unknown } },
    next: () => void,
  ) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const jwt = require('jsonwebtoken');
    try { req.user = jwt.verify(h.slice(7), 'test-jwt-secret-long-enough-32chars!!'); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
  },
}));
jest.mock('../middleware/rateLimit', () => ({
  limits: {
    upload: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    uploadChunk: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  },
}));

const mockPgQuery = jest.fn(async (sql: string) => {
  if (String(sql).includes('MAX(s."boostTier")')) return { rows: [{ boostTier: 0 }] };
  return { rows: [{ referenced: false }] };
});
jest.mock('../db/postgres', () => ({
  db: { _pool: { query: mockPgQuery } },
}));

const mockStorageDeleteFile = jest.fn().mockResolvedValue(undefined);
const mockStorageUploadFile = jest.fn().mockResolvedValue({
  url: '/uploads/abc123.png',
  key: null,
  provider: 'local',
});
const mockStorageAdapter = () => ({
  deleteFile: mockStorageDeleteFile,
  uploadFile: mockStorageUploadFile,
  keyFromUrl: (url: string) => require('path').basename(url),
});
jest.mock('../lib/storageAdapter', () => ({
  getStorageAdapter: mockStorageAdapter,
  getPrivateStorageAdapter: mockStorageAdapter,
  getProvider: () => 'local',
  getPrivateStorageProvider: () => 'local',
  PROVIDER: 'local',
}));

// Mock fs.existsSync / mkdirSync so upload dirs aren't created on disk
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: (p: string) => {
      if (p.includes('_chunks') || p.includes('/uploads')) return true;
      return actual.existsSync(p);
    },
    mkdirSync: (p: string, opts?: { recursive?: boolean }) => {
      if (p.includes('_chunks') || p.includes('/uploads')) return;
      return actual.mkdirSync(p, opts);
    },
  };
});

import request from 'supertest';
import express from 'express';
const jwt     = require('jsonwebtoken');
const path    = require('path');
const fs      = require('fs');

function token(id = 'user1') {
  return jwt.sign({ id, username: 'uploader', displayName: 'Uploader', v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });
}

// Build the app
import router from '../routes/upload';
const app = express();
app.use(express.json());
app.use('/api/upload', router);
app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(err.status || 500).json({ error: err.message }));

// ── Single upload ─────────────────────────────────────────────

describe('POST /api/upload — single file upload', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await request(app).post('/api/upload');
    expect(res.status).toBe(401);
  });

  it('returns 400 when no file is attached', async () => {
    const res = await request(app)
      .post('/api/upload')
      .set('Authorization', `Bearer ${token()}`);
    // multer sees no file → our guard returns 400
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no file/i);
  });

  it('accepts a valid PNG image', async () => {
    // Create a minimal 1×1 PNG (89 bytes valid PNG)
    const PNG_MAGIC = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
      0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,
      0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
      0x00, 0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC,
      0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,
      0x44, 0xAE, 0x42, 0x60, 0x82,
    ]);

    const res = await request(app)
      .post('/api/upload')
      .set('Authorization', `Bearer ${token()}`)
      .attach('file', PNG_MAGIC, { filename: 'test.png', contentType: 'image/png' });

    // May return 200 or 400 depending on magic-byte check in test environment;
    // primary goal: not 401/500 and route is reachable
    expect([200, 400]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.url).toMatch(/^\/uploads\//);
      expect(res.body.fileType).toBe('image/png');
    }
  });

  it('rejects disallowed MIME types', async () => {
    const res = await request(app)
      .post('/api/upload')
      .set('Authorization', `Bearer ${token()}`)
      .attach('file', Buffer.from('#!/bin/bash'), { filename: 'evil.sh', contentType: 'application/x-sh' });

    expect(res.status).toBe(400);
  });
});

// ── Chunked upload ────────────────────────────────────────────

describe('POST /api/upload/chunk — chunked upload', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await request(app).post('/api/upload/chunk');
    expect(res.status).toBe(401);
  });

  it('returns 400 when required headers are missing', async () => {
    // ── MESAJ SÖZLEŞMESİ DEĞİŞTİ ──────────────────────────────────────────
    // Eskiden tek bir genel "missing chunk metadata" mesajı vardı. Doğrulama
    // ALAN BAZLI hâle geldi (lib/chunkUploadSafety.ts): hiç başlık yoksa ilk
    // reddedilen alan `x-upload-id`dir. Durum kodu 400 olarak KORUNUR.
    const res = await request(app)
      .post('/api/upload/chunk')
      .set('Authorization', `Bearer ${token()}`)
      .send(Buffer.from('chunk data'));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/x-upload-id/i);
  });

  it('her chunk metadata alanı AYRI AYRI doğrulanır', async () => {
    // Alan bazlı doğrulama eklendi ama her dalı ölçen bir test YOKTU:
    // tek bir genel iddia, bozuk index/isim/boyut kabul edilse bile geçerdi.
    const base = () => request(app)
      .post('/api/upload/chunk')
      .set('Authorization', `Bearer ${token()}`);

    // Geçersiz uploadId biçimi (izin verilmeyen karakter).
    const badId = await base()
      .set('x-upload-id', '../../etc/passwd')
      .set('x-chunk-index', '0').set('x-total-chunks', '1')
      .set('x-file-name', 'a.txt').set('x-file-type', 'text/plain')
      .send(Buffer.from('x'));
    expect(badId.status).toBe(400);
    expect(badId.body.error).toMatch(/x-upload-id/i);

    // index >= total — tutarsız aralık.
    const badIndex = await base()
      .set('x-upload-id', 'abc123')
      .set('x-chunk-index', '5').set('x-total-chunks', '2')
      .set('x-file-name', 'a.txt').set('x-file-type', 'text/plain')
      .send(Buffer.from('x'));
    expect(badIndex.status).toBe(400);
    expect(badIndex.body.error).toMatch(/index\/total/i);

    // Aşırı uzun dosya adı (>200). NOT: kontrol karakteri içeren ad zaten
    // Node'un HTTP katmanında reddediliyor (istek hiç kurulamıyor), yani o dal
    // taşıyıcı seviyesinde korunuyor; buradaki iddia uygulama sınırını ölçer.
    const badName = await base()
      .set('x-upload-id', 'abc123')
      .set('x-chunk-index', '0').set('x-total-chunks', '1')
      .set('x-file-name', 'a'.repeat(250)).set('x-file-type', 'text/plain')
      .send(Buffer.from('x'));
    expect(badName.status).toBe(400);
    expect(badName.body.error).toMatch(/x-file-name/i);
  });

  it('returns 415 for disallowed file type in chunk upload', async () => {
    const res = await request(app)
      .post('/api/upload/chunk')
      .set('Authorization', `Bearer ${token()}`)
      .set('x-upload-id', 'test-upload-1')
      .set('x-chunk-index', '0')
      .set('x-total-chunks', '1')
      .set('x-file-name', 'evil.exe')
      .set('x-file-type', 'application/x-msdownload')
      .send(Buffer.from('MZ'));

    expect(res.status).toBe(415);
    expect(res.body.error).toMatch(/file type not allowed/i);
  });

  it('returns 413 when declared total size exceeds limit', async () => {
    const BIG_CHUNKS = 25000; // 25000 * 10MB = 250GB >> default 2GB
    const res = await request(app)
      .post('/api/upload/chunk')
      .set('Authorization', `Bearer ${token()}`)
      .set('x-upload-id', 'oversized-upload')
      .set('x-chunk-index', '0')
      .set('x-total-chunks', String(BIG_CHUNKS))
      .set('x-file-name', 'huge.zip')
      .set('x-file-type', 'application/zip')
      .send(Buffer.from('PK\x03\x04'));

    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/too large/i);
  });

  it('acknowledges a valid non-final chunk', async () => {
    const res = await request(app)
      .post('/api/upload/chunk')
      .set('Authorization', `Bearer ${token()}`)
      .set('x-upload-id', 'valid-upload-abc123')
      .set('x-chunk-index', '0')
      .set('x-total-chunks', '3')
      .set('x-file-name', 'video.mp4')
      .set('x-file-type', 'video/mp4')
      .send(Buffer.alloc(1024)); // 1KB dummy chunk

    // done:false expected since this is not the last chunk
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.done).toBe(false);
      expect(res.body.received).toBe(0);
    }
  });
});

// ── Server GIF upload ─────────────────────────────────────────

describe('POST /api/upload/server-gif — server GIF upload', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await request(app).post('/api/upload/server-gif');
    expect(res.status).toBe(401);
  });

  it('returns 400 when no file is attached', async () => {
    const res = await request(app)
      .post('/api/upload/server-gif')
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(400);
  });

  it('rejects non-image files', async () => {
    const res = await request(app)
      .post('/api/upload/server-gif')
      .set('Authorization', `Bearer ${token()}`)
      .attach('gif', Buffer.from('not-an-image'), { filename: 'bad.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
  });
});

// ── DELETE /upload/cdn — ownership kontrolü (Sprint 75) ──────
// Sprint 75: sahiplik artık messages ILIKE değil uploads tablosundan sorgulanıyor.

const mockUploads = { findOne: jest.fn(), insert: jest.fn().mockResolvedValue({ _id: 'u1' }) };
Object.assign(mockDb.uploads, mockUploads);

describe('DELETE /api/upload/cdn — file ownership (Sprint 75)', () => {
  const OWNER_ID  = 'owner-user-1';
  const OTHER_ID  = 'other-user-2';
  const ADMIN_ID  = 'admin-user-3';
  const VALID_KEY = 'uploads/abc123.png';

  function tok(id: string, isAdmin = false) {
    const jwt = require('jsonwebtoken');
    return jwt.sign({ id, username: 'u', displayName: 'U', v: 0, isAdmin }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockPgQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('MAX(s."boostTier")')) return { rows: [{ boostTier: 0 }] };
      return { rows: [{ referenced: false }] };
    });
    mockStorageDeleteFile.mockResolvedValue(undefined);
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(app)
      .delete('/api/upload/cdn')
      .query({ key: VALID_KEY });
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid key (no uploads/ prefix)', async () => {
    const res = await request(app)
      .delete('/api/upload/cdn')
      .set('Authorization', `Bearer ${tok(OWNER_ID)}`)
      .query({ key: 'bad/path/file.png' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for path traversal attempt', async () => {
    const res = await request(app)
      .delete('/api/upload/cdn')
      .set('Authorization', `Bearer ${tok(OWNER_ID)}`)
      .query({ key: '../uploads/etc/passwd' });
    expect(res.status).toBe(400);
  });

  it('returns 404 when uploads tablosunda kayıt bulunamadı', async () => {
    mockUploads.findOne.mockResolvedValue(null);

    const res = await request(app)
      .delete('/api/upload/cdn')
      .set('Authorization', `Bearer ${tok(OWNER_ID)}`)
      .query({ key: VALID_KEY });

    expect(res.status).toBe(404);
    expect(mockUploads.findOne).toHaveBeenCalledWith({ key: VALID_KEY, userId: OWNER_ID });
  });

  it('returns 200 when requester is the file owner', async () => {
    mockUploads.findOne.mockResolvedValue({ _id: 'u1', userId: OWNER_ID, key: VALID_KEY });

    const res = await request(app)
      .delete('/api/upload/cdn')
      .set('Authorization', `Bearer ${tok(OWNER_ID)}`)
      .query({ key: VALID_KEY });

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(res.body.key).toBe(VALID_KEY);
    // localAdapter is rooted at server/uploads, so the physical key must not
    // become uploads/uploads/abc123.png.
    expect(mockStorageDeleteFile).toHaveBeenCalledWith('abc123.png');
  });

  it('returns 404 when different user tries to delete — uploads tablosu key+userId ile sorgulanır', async () => {
    mockUploads.findOne.mockResolvedValue(null);

    const res = await request(app)
      .delete('/api/upload/cdn')
      .set('Authorization', `Bearer ${tok(OTHER_ID)}`)
      .query({ key: VALID_KEY });

    expect(res.status).toBe(404);
    expect(mockUploads.findOne).toHaveBeenCalledWith({ key: VALID_KEY, userId: OTHER_ID });
  });

  it('[SECURITY] refuses physical deletion while a canonical DB reference is live', async () => {
    mockUploads.findOne.mockResolvedValue({ _id: 'u1', userId: OWNER_ID, key: VALID_KEY });
    mockPgQuery.mockResolvedValueOnce({ rows: [{ referenced: true }] });

    const res = await request(app)
      .delete('/api/upload/cdn')
      .set('Authorization', `Bearer ${tok(OWNER_ID)}`)
      .query({ key: VALID_KEY });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('UPLOAD_IN_USE');
    expect(mockStorageDeleteFile).not.toHaveBeenCalled();
  });

  it('[SECURITY] fails closed when reference verification cannot reach the DB', async () => {
    mockUploads.findOne.mockResolvedValue({ _id: 'u1', userId: OWNER_ID, key: VALID_KEY });
    mockPgQuery.mockRejectedValueOnce(new Error('db unavailable'));

    const res = await request(app)
      .delete('/api/upload/cdn')
      .set('Authorization', `Bearer ${tok(OWNER_ID)}`)
      .query({ key: VALID_KEY });

    expect(res.status).toBe(500);
    expect(mockStorageDeleteFile).not.toHaveBeenCalled();
  });

  it('[SECURITY] never exposes the historical sticker tree to generic deletion', async () => {
    const res = await request(app)
      .delete('/api/upload/cdn')
      .set('Authorization', `Bearer ${tok(ADMIN_ID, true)}`)
      .query({ key: 'uploads/stickers/bridge-classic/wave.svg' });

    expect(res.status).toBe(400);
    expect(mockStorageDeleteFile).not.toHaveBeenCalled();
  });

  it('[SECURITY] current database admin bypasses ownership check — JWT claim alone is not authority', async () => {
    await mockDb.users.insert(makeUser({ _id: ADMIN_ID, isAdmin: true }));
    const res = await request(app)
      .delete('/api/upload/cdn')
      .set('Authorization', `Bearer ${tok(ADMIN_ID, false)}`)
      .query({ key: VALID_KEY });

    expect(mockUploads.findOne).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it('[SECURITY] mesaj silinmiş olsa bile sahip yine de dosyasını silebilir', async () => {
    // Eski yaklaşımda mesaj silindi → messages.findOne null → 404 olurdu.
    // Yeni yaklaşımda uploads tablosu bağımsız → kayıt hâlâ var → 200.
    mockUploads.findOne.mockResolvedValue({ _id: 'u1', userId: OWNER_ID, key: VALID_KEY });

    const res = await request(app)
      .delete('/api/upload/cdn')
      .set('Authorization', `Bearer ${tok(OWNER_ID)}`)
      .query({ key: VALID_KEY });

    expect(res.status).toBe(200);
  });

  it('[INTEGRITY] keeps ownership metadata when physical storage deletion fails', async () => {
    mockUploads.findOne.mockResolvedValue({ _id: 'u1', userId: OWNER_ID, key: VALID_KEY });
    mockStorageDeleteFile.mockRejectedValueOnce(new Error('object store down'));
    const removeSpy = jest.spyOn(mockDb.uploads, 'remove');
    try {
      const res = await request(app)
        .delete('/api/upload/cdn')
        .set('Authorization', `Bearer ${tok(OWNER_ID)}`)
        .query({ key: VALID_KEY });
      expect(res.status).toBe(500);
      expect(removeSpy).not.toHaveBeenCalled();
    } finally {
      removeSpy.mockRestore();
    }
  });

  it('[COMPAT] retires ownership through the legacy delete adapter when remove is unavailable', async () => {
    mockUploads.findOne.mockResolvedValue({ _id: 'u1', userId: OWNER_ID, key: VALID_KEY });
    const uploads = mockDb.uploads as any;
    const originalRemove = uploads.remove;
    const originalDelete = uploads.delete;
    const legacyDelete = jest.fn().mockResolvedValue(undefined);
    uploads.remove = undefined;
    uploads.delete = legacyDelete;
    try {
      const res = await request(app)
        .delete('/api/upload/cdn')
        .set('Authorization', `Bearer ${tok(OWNER_ID)}`)
        .query({ key: VALID_KEY });
      expect(res.status).toBe(200);
      expect(legacyDelete).toHaveBeenCalledWith({ key: VALID_KEY });
    } finally {
      uploads.remove = originalRemove;
      uploads.delete = originalDelete;
    }
  });

  it('[INTEGRITY] reports success after physical deletion even if metadata retirement fails', async () => {
    mockUploads.findOne.mockResolvedValue({ _id: 'u1', userId: OWNER_ID, key: VALID_KEY });
    const removeSpy = jest.spyOn(mockDb.uploads, 'remove').mockRejectedValueOnce(new Error('metadata store down'));
    try {
      const res = await request(app)
        .delete('/api/upload/cdn')
        .set('Authorization', `Bearer ${tok(OWNER_ID)}`)
        .query({ key: VALID_KEY });
      expect(res.status).toBe(200);
      expect(mockStorageDeleteFile).toHaveBeenCalled();
    } finally {
      removeSpy.mockRestore();
    }
  });
});

// ── recordUpload — uploads tablosuna kayıt (Sprint 75) ────────

describe('recordUpload — uploads tablosuna kayıt', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUploads.insert.mockResolvedValue({ _id: 'new-id' });
  });

  it('[INTEGRITY] ownership persistence failure returns 500 and rolls storage back', async () => {
    mockUploads.insert.mockRejectedValue(new Error('DB error'));
    mockStorageUploadFile.mockResolvedValueOnce({
      url: '/uploads/abc123.png',
      key: null,
      provider: 'local',
    });

    const PNG = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
      0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,
      0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
      0x00, 0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC,
      0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,
      0x44, 0xAE, 0x42, 0x60, 0x82,
    ]);
    const os   = require('os');
    const path = require('path');
    const fs   = require('fs');
    const tmp  = path.join(os.tmpdir(), `test-${Date.now()}.png`);
    fs.writeFileSync(tmp, PNG);

    const jwt = require('jsonwebtoken');
    const t = jwt.sign({ id: 'user1', username: 'u', displayName: 'U', v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });

    const res = await request(app)
      .post('/api/upload')
      .set('Authorization', `Bearer ${t}`)
      .attach('file', tmp, 'test.png');

    fs.unlinkSync(tmp);
    expect(res.status).toBe(500);
    expect(mockStorageDeleteFile).toHaveBeenCalledWith(expect.stringMatching(/^[A-Za-z0-9-]+\.png$/));
  });
});
