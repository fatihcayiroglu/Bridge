// server/tests/serverAssets.test.ts
// Tests for /api/servers/:sid/banner and /api/servers/:sid/icon-image
// Sprint 73: storageAdapter mock eklendi — CDN entegrasyonu testi
'use strict';

process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';

import path from 'path';
const os   = require('os');
const fs   = require('fs');

const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-sa-test-'));

// Multer'ı temp dizine yönlendir
jest.mock('multer', () => {
  const multer = jest.requireActual('multer');
  const storage = multer.diskStorage({
    destination: (_req: unknown, _file: unknown, cb: (err: Error | null, dest: string) => void) => cb(null, UPLOAD_DIR),
    filename:    (_req: unknown, _file: unknown, cb: (err: Error | null, name: string) => void) => cb(null, `sa_test_${Date.now()}.png`),
  });
  const m = (opts: Record<string, unknown>) => multer({ ...opts, storage });
  m.diskStorage = multer.diskStorage;
  return m;
});

// storageAdapter mock
const mockUploadFile = jest.fn(async (localPath: string, key: string) => ({
  url:      `/${key}`,
  key,
  provider: 'local' as const,
}));
const mockDeleteFile  = jest.fn(async () => {});
const mockKeyFromUrl  = jest.fn((url: string) => url.replace(/^\//, ''));

jest.mock('../lib/storageAdapter', () => ({
  getStorageAdapter: jest.fn(() => ({
    uploadFile:  mockUploadFile,
    deleteFile:  mockDeleteFile,
    keyFromUrl:  mockKeyFromUrl,
    listFiles:   jest.fn(async () => []),
    healthCheck: jest.fn(async () => true),
  })),
}));

const mockLiveRef = jest.fn(async (..._args: unknown[]) => false);
jest.mock('../lib/uploadReferenceSafety', () => {
  const actual = jest.requireActual('../lib/uploadReferenceSafety');
  return { ...actual, hasLiveUploadReference: (...args: unknown[]) => mockLiveRef(...args) };
});

import { createMockDb, makeUser, makeServer } from './helpers/mockDb';
import type { ServerFixture, UserFixture } from './helpers/mockDb';
/* Bu süit REFERANS-GÜVENLİ TEMİZLİK sırasını ölçer: fiziksel dosya, DB
   referansı kalmadığı KANITLANMADAN silinmemelidir. Kontrol
   `hasLiveUploadReference(db._pool, ...)` üzerinden gider, bu yüzden havuz
   stub'u AÇIKÇA istenir (varsayılan mock'ta yoktur — bkz. helpers/mockDb.ts). */
let db = createMockDb({ withPgPool: true });
jest.mock('../db/index', () => { const { createMockDb } = require('./helpers/mockDb'); return createMockDb({ withPgPool: true }); });
jest.mock('../db/loader', () => require('../db/index'));

import request from 'supertest';
import express from 'express';
const jwt    = require('jsonwebtoken');
const router = require('../routes/serverAssets');
import { requireDoc } from './helpers/mockDb';

function token(userId: string) {
  return jwt.sign({ id: userId, username: 'owner', v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers/:sid', router);
  app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

const FAKE_PNG = path.join(UPLOAD_DIR, 'test.png');
fs.writeFileSync(FAKE_PNG, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic bytes
const BAD_PNG = path.join(UPLOAD_DIR, 'bad.png');
fs.writeFileSync(BAD_PNG, Buffer.from('not-a-png'));
const HTML_FILE = path.join(UPLOAD_DIR, 'bad.html');
fs.writeFileSync(HTML_FILE, '<script>alert(1)</script>');

let app: express.Express;
let owner: UserFixture;
let member: UserFixture;
let server: ServerFixture;
let ownerTok: string;
let memberTok: string;

beforeEach(async () => {
  db = createMockDb({ withPgPool: true });
  Object.assign(require('../db/loader'), db);
  Object.assign(require('../db/index'), db);

  owner  = makeUser({ username: 'owner' });
  member = makeUser({ username: 'member' });
  server = makeServer(owner._id);

  await db.users.insert(owner);
  await db.users.insert(member);
  await db.servers.insert(server);
  await db.members.insert({ userId: owner._id,  serverId: server._id, roles: '[]', joinedAt: Date.now() });
  await db.members.insert({ userId: member._id, serverId: server._id, roles: '[]', joinedAt: Date.now() });

  ownerTok  = token(owner._id);
  memberTok = token(member._id);
  app = buildApp();

  jest.clearAllMocks();
  mockLiveRef.mockResolvedValue(false);
  mockUploadFile.mockImplementation(async (_localPath: string, key: string) => ({ url: `/${key}`, key, provider: 'local' as const }));
  mockDeleteFile.mockResolvedValue(undefined);
  mockKeyFromUrl.mockImplementation((url: string) => url.replace(/^\//, ''));
});

afterAll(() => {
  try { fs.rmSync(UPLOAD_DIR, { recursive: true }); } catch {}
});

// ═══════════════════════════════════════════════════════
// POST /api/servers/:sid/banner
// ═══════════════════════════════════════════════════════
describe('POST /api/servers/:sid/banner', () => {
  it('sunucu sahibi banner yükleyebilir', async () => {
    const res = await request(app)
      .post(`/api/servers/${server._id}/banner`)
      .set('Authorization', `Bearer ${ownerTok}`)
      .attach('banner', FAKE_PNG, { contentType: 'image/png' });
    expect(res.status).toBe(200);
    expect(res.body.bannerUrl).toMatch(/uploads\/server-assets\//);
  });

  it('başarılı yüklemede storageAdapter.uploadFile çağrılır', async () => {
    await request(app)
      .post(`/api/servers/${server._id}/banner`)
      .set('Authorization', `Bearer ${ownerTok}`)
      .attach('banner', FAKE_PNG, { contentType: 'image/png' });
    expect(mockUploadFile).toHaveBeenCalledTimes(1);
    const [, cdnKey] = mockUploadFile.mock.calls[0];
    expect(cdnKey).toMatch(/^uploads\/server-assets\/sa_/);
  });

  it('eski banner silinirken storageAdapter.deleteFile çağrılır', async () => {
    await db.servers.update({ _id: server._id }, { $set: { bannerUrl: '/uploads/server-assets/old.png' } });
    await request(app)
      .post(`/api/servers/${server._id}/banner`)
      .set('Authorization', `Bearer ${ownerTok}`)
      .attach('banner', FAKE_PNG, { contentType: 'image/png' });
    expect(mockDeleteFile).toHaveBeenCalledTimes(1);
  });

  it('normal üye banner yükleyemez', async () => {
    const res = await request(app)
      .post(`/api/servers/${server._id}/banner`)
      .set('Authorization', `Bearer ${memberTok}`)
      .attach('banner', FAKE_PNG, { contentType: 'image/png' });
    expect(res.status).toBe(403);
  });

  it('dosya olmadan 400 döner', async () => {
    const res = await request(app)
      .post(`/api/servers/${server._id}/banner`)
      .set('Authorization', `Bearer ${ownerTok}`);
    expect(res.status).toBe(400);
  });

  it('token olmadan 401 döner', async () => {
    const res = await request(app)
      .post(`/api/servers/${server._id}/banner`);
    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════
// DELETE /api/servers/:sid/banner
// ═══════════════════════════════════════════════════════
describe('DELETE /api/servers/:sid/banner', () => {
  it('sunucu sahibi banner kaldırabilir', async () => {
    await db.servers.update({ _id: server._id }, { $set: { bannerUrl: '/uploads/server-assets/old.png' } });
    const res = await request(app)
      .delete(`/api/servers/${server._id}/banner`)
      .set('Authorization', `Bearer ${ownerTok}`);
    expect(res.status).toBe(200);
    expect(res.body.bannerUrl).toBeNull();
  });

  it('silme sırasında storageAdapter.deleteFile çağrılır', async () => {
    await db.servers.update({ _id: server._id }, { $set: { bannerUrl: '/uploads/server-assets/old.png' } });
    await request(app)
      .delete(`/api/servers/${server._id}/banner`)
      .set('Authorization', `Bearer ${ownerTok}`);
    expect(mockDeleteFile).toHaveBeenCalledTimes(1);
  });

  it('normal üye kaldıramaz', async () => {
    const res = await request(app)
      .delete(`/api/servers/${server._id}/banner`)
      .set('Authorization', `Bearer ${memberTok}`);
    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/servers/:sid/icon-image
// ═══════════════════════════════════════════════════════
describe('POST /api/servers/:sid/icon-image', () => {
  it('sunucu sahibi ikon yükleyebilir', async () => {
    const res = await request(app)
      .post(`/api/servers/${server._id}/icon-image`)
      .set('Authorization', `Bearer ${ownerTok}`)
      .attach('icon', FAKE_PNG, { contentType: 'image/png' });
    expect(res.status).toBe(200);
    expect(res.body.iconUrl).toMatch(/uploads\/server-assets\//);
  });

  it('başarılı yüklemede storageAdapter.uploadFile çağrılır', async () => {
    await request(app)
      .post(`/api/servers/${server._id}/icon-image`)
      .set('Authorization', `Bearer ${ownerTok}`)
      .attach('icon', FAKE_PNG, { contentType: 'image/png' });
    expect(mockUploadFile).toHaveBeenCalledTimes(1);
    const [, cdnKey] = mockUploadFile.mock.calls[0];
    expect(cdnKey).toMatch(/^uploads\/server-assets\/sa_/);
  });

  it('normal üye yükleyemez', async () => {
    const res = await request(app)
      .post(`/api/servers/${server._id}/icon-image`)
      .set('Authorization', `Bearer ${memberTok}`)
      .attach('icon', FAKE_PNG, { contentType: 'image/png' });
    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════
// DELETE /api/servers/:sid/icon-image
// ═══════════════════════════════════════════════════════
describe('DELETE /api/servers/:sid/icon-image', () => {
  it('sunucu sahibi ikonu kaldırabilir', async () => {
    await db.servers.update({ _id: server._id }, { $set: { iconUrl: '/uploads/server-assets/icon.png' } });
    const res = await request(app)
      .delete(`/api/servers/${server._id}/icon-image`)
      .set('Authorization', `Bearer ${ownerTok}`);
    expect(res.status).toBe(200);
    expect(res.body.iconUrl).toBeNull();
  });

  it('silme sırasında storageAdapter.deleteFile çağrılır', async () => {
    await db.servers.update({ _id: server._id }, { $set: { iconUrl: '/uploads/server-assets/icon.png' } });
    await request(app)
      .delete(`/api/servers/${server._id}/icon-image`)
      .set('Authorization', `Bearer ${ownerTok}`);
    expect(mockDeleteFile).toHaveBeenCalledTimes(1);
  });
});


describe('server asset safety/deep failure branches', () => {
  it('rejects unsupported MIME and spoofed PNG content before storage ownership', async () => {
    const badMime = await request(app)
      .post(`/api/servers/${server._id}/banner`)
      .set('Authorization', `Bearer ${ownerTok}`)
      .attach('banner', HTML_FILE, { contentType: 'text/html' });
    expect(badMime.status).toBe(400);
    expect(mockUploadFile).not.toHaveBeenCalled();

    const spoof = await request(app)
      .post(`/api/servers/${server._id}/banner`)
      .set('Authorization', `Bearer ${ownerTok}`)
      .attach('banner', BAD_PNG, { contentType: 'image/png' });
    expect(spoof.status).toBe(400);
    expect(spoof.body.error).toMatch(/does not match/i);
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('authorization happens before multipart disk ownership', async () => {
    const before = new Set(fs.readdirSync(UPLOAD_DIR));
    const res = await request(app)
      .post(`/api/servers/${server._id}/icon-image`)
      .set('Authorization', `Bearer ${memberTok}`)
      .attach('icon', FAKE_PNG, { contentType: 'image/png' });
    expect(res.status).toBe(403);
    expect(new Set(fs.readdirSync(UPLOAD_DIR))).toEqual(before);
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('missing canonical server after staging cleans temp and never uploads', async () => {
    const { Servers } = require('../db/repositories');
    const spy = jest.spyOn(Servers, 'findById')
      .mockResolvedValueOnce(server) // permission gate
      .mockResolvedValueOnce(null); // deleted before handler ownership commit
    const before = new Set(fs.readdirSync(UPLOAD_DIR));
    const res = await request(app)
      .post(`/api/servers/${server._id}/banner`)
      .set('Authorization', `Bearer ${ownerTok}`)
      .attach('banner', FAKE_PNG, { contentType: 'image/png' });
    expect(res.status).toBe(404);
    expect(mockUploadFile).not.toHaveBeenCalled();
    expect(new Set(fs.readdirSync(UPLOAD_DIR))).toEqual(before);
    spy.mockRestore();
  });

  it('repository lookup failure cleans staged file and propagates as 500', async () => {
    const { Servers } = require('../db/repositories');
    const spy = jest.spyOn(Servers, 'findById').mockRejectedValueOnce(new Error('server db down'));
    const before = new Set(fs.readdirSync(UPLOAD_DIR));
    const res = await request(app)
      .post(`/api/servers/${server._id}/icon-image`)
      .set('Authorization', `Bearer ${ownerTok}`)
      .attach('icon', FAKE_PNG, { contentType: 'image/png' });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('server db down');
    expect(mockUploadFile).not.toHaveBeenCalled();
    expect(new Set(fs.readdirSync(UPLOAD_DIR))).toEqual(before);
    spy.mockRestore();
  });

  it('storage failure does not create a DB reference', async () => {
    mockUploadFile.mockRejectedValueOnce(new Error('object store down'));
    const { Servers } = require('../db/repositories');
    const updateSpy = jest.spyOn(Servers, 'update');
    const res = await request(app)
      .post(`/api/servers/${server._id}/banner`)
      .set('Authorization', `Bearer ${ownerTok}`)
      .attach('banner', FAKE_PNG, { contentType: 'image/png' });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('object store down');
    expect(updateSpy).not.toHaveBeenCalled();
    updateSpy.mockRestore();
  });

  it('DB commit failure rolls back only the newly uploaded unreferenced object', async () => {
    const { Servers } = require('../db/repositories');
    const updateSpy = jest.spyOn(Servers, 'update').mockRejectedValueOnce(new Error('commit down'));
    const res = await request(app)
      .post(`/api/servers/${server._id}/banner`)
      .set('Authorization', `Bearer ${ownerTok}`)
      .attach('banner', FAKE_PNG, { contentType: 'image/png' });
    expect(res.status).toBe(500);
    expect(mockLiveRef).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/^uploads\/server-assets\//));
    expect(mockDeleteFile).toHaveBeenCalledTimes(1);
    updateSpy.mockRestore();
  });

  it('DB uncertainty during rollback fails closed and preserves the remote object', async () => {
    const { Servers } = require('../db/repositories');
    const updateSpy = jest.spyOn(Servers, 'update').mockRejectedValueOnce(new Error('commit down'));
    mockLiveRef.mockRejectedValueOnce(new Error('reference db down'));
    const res = await request(app)
      .post(`/api/servers/${server._id}/icon-image`)
      .set('Authorization', `Bearer ${ownerTok}`)
      .attach('icon', FAKE_PNG, { contentType: 'image/png' });
    expect(res.status).toBe(500);
    expect(mockDeleteFile).not.toHaveBeenCalled();
    updateSpy.mockRestore();
  });

  it('shared old banner/icon references are retained after DB ownership changes', async () => {
    mockLiveRef.mockResolvedValue(true);
    await db.servers.update({ _id: server._id }, { $set: {
      bannerUrl: '/uploads/server-assets/shared-banner.png',
      iconUrl: '/uploads/server-assets/shared-icon.png',
    } });

    const banner = await request(app)
      .delete(`/api/servers/${server._id}/banner`)
      .set('Authorization', `Bearer ${ownerTok}`);
    const icon = await request(app)
      .delete(`/api/servers/${server._id}/icon-image`)
      .set('Authorization', `Bearer ${ownerTok}`);
    expect(banner.status).toBe(200);
    expect(icon.status).toBe(200);
    expect(mockDeleteFile).not.toHaveBeenCalled();
    expect(mockLiveRef).toHaveBeenCalledWith(expect.anything(), 'uploads/server-assets/shared-banner.png');
    expect(mockLiveRef).toHaveBeenCalledWith(expect.anything(), 'uploads/server-assets/shared-icon.png');
  });

  it('cleanup DB failure after DELETE is non-destructive while DB null remains authoritative', async () => {
    await db.servers.update({ _id: server._id }, { $set: { bannerUrl: '/uploads/server-assets/uncertain.png' } });
    mockLiveRef.mockRejectedValueOnce(new Error('reference DB down'));
    const res = await request(app)
      .delete(`/api/servers/${server._id}/banner`)
      .set('Authorization', `Bearer ${ownerTok}`);
    expect(res.status).toBe(200);
    expect(res.body.bannerUrl).toBeNull();
    expect(mockDeleteFile).not.toHaveBeenCalled();
    const current = await requireDoc(db.servers, { _id: server._id });
    expect(current.bannerUrl).toBeNull();
  });

  it('missing server is denied before the handler, while deletion after the permission gate returns 404', async () => {
    const { Servers } = require('../db/repositories');
    const missingSpy = jest.spyOn(Servers, 'findById').mockResolvedValue(null);
    expect((await request(app).delete(`/api/servers/${server._id}/banner`).set('Authorization', `Bearer ${ownerTok}`)).status).toBe(403);
    missingSpy.mockRestore();

    const raceSpy = jest.spyOn(Servers, 'findById')
      .mockResolvedValueOnce(server) // permission gate sees the canonical server
      .mockResolvedValueOnce(null); // server disappears before mutation
    expect((await request(app).delete(`/api/servers/${server._id}/icon-image`).set('Authorization', `Bearer ${ownerTok}`)).status).toBe(404);
    raceSpy.mockRestore();
  });
});


describe('icon-image mirrors banner failure safety', () => {
  it('rejects missing and spoofed icon input before storage', async () => {
    const missing = await request(app)
      .post(`/api/servers/${server._id}/icon-image`)
      .set('Authorization', `Bearer ${ownerTok}`);
    expect(missing.status).toBe(400);

    const spoof = await request(app)
      .post(`/api/servers/${server._id}/icon-image`)
      .set('Authorization', `Bearer ${ownerTok}`)
      .attach('icon', BAD_PNG, { contentType: 'image/png' });
    expect(spoof.status).toBe(400);
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('icon storage failure cannot commit ownership', async () => {
    mockUploadFile.mockRejectedValueOnce(new Error('icon store down'));
    const { Servers } = require('../db/repositories');
    const updateSpy = jest.spyOn(Servers, 'update');
    const r = await request(app)
      .post(`/api/servers/${server._id}/icon-image`)
      .set('Authorization', `Bearer ${ownerTok}`)
      .attach('icon', FAKE_PNG, { contentType: 'image/png' });
    expect(r.status).toBe(500);
    expect(updateSpy).not.toHaveBeenCalled();
    updateSpy.mockRestore();
  });

  it('icon DB commit failure removes only an unreferenced newly uploaded object', async () => {
    const { Servers } = require('../db/repositories');
    const updateSpy = jest.spyOn(Servers, 'update').mockRejectedValueOnce(new Error('icon commit down'));
    const r = await request(app)
      .post(`/api/servers/${server._id}/icon-image`)
      .set('Authorization', `Bearer ${ownerTok}`)
      .attach('icon', FAKE_PNG, { contentType: 'image/png' });
    expect(r.status).toBe(500);
    expect(mockLiveRef).toHaveBeenCalled();
    expect(mockDeleteFile).toHaveBeenCalledTimes(1);
    updateSpy.mockRestore();
  });

  it('invalid cleanup key is rejected rather than deleting outside the upload namespace', async () => {
    await db.servers.update({ _id: server._id }, { $set: { iconUrl: '/uploads/server-assets/old.png' } });
    mockKeyFromUrl.mockReturnValueOnce('../outside');
    const r = await request(app)
      .delete(`/api/servers/${server._id}/icon-image`)
      .set('Authorization', `Bearer ${ownerTok}`);
    expect(r.status).toBe(200);
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });
});

describe('server asset cleanup/symmetric edge branches', () => {
  it('deleting an already-empty banner/icon is idempotent and performs no physical delete', async () => {
    await db.servers.update({ _id: server._id }, { $set: { bannerUrl: null, iconUrl: null } });
    const banner = await request(app).delete(`/api/servers/${server._id}/banner`).set('Authorization', `Bearer ${ownerTok}`);
    const icon = await request(app).delete(`/api/servers/${server._id}/icon-image`).set('Authorization', `Bearer ${ownerTok}`);
    expect(banner.status).toBe(200);
    expect(icon.status).toBe(200);
    expect(mockDeleteFile).not.toHaveBeenCalled();
    expect(mockLiveRef).not.toHaveBeenCalled();
  });

  it('normalizes provider keys without uploads/ prefix before reference checking', async () => {
    await db.servers.update({ _id: server._id }, { $set: { bannerUrl: 'https://cdn.test/server-assets/old.png' } });
    mockKeyFromUrl.mockReturnValueOnce('server-assets/old.png');
    const res = await request(app).delete(`/api/servers/${server._id}/banner`).set('Authorization', `Bearer ${ownerTok}`);
    expect(res.status).toBe(200);
    expect(mockLiveRef).toHaveBeenCalledWith(expect.anything(), 'uploads/server-assets/old.png');
    expect(mockDeleteFile).toHaveBeenCalledWith('server-assets/old.png');
  });

  it('banner repository lookup failure after staging cleans the local file and never uploads', async () => {
    const { Servers } = require('../db/repositories');
    const spy = jest.spyOn(Servers, 'findById')
      .mockResolvedValueOnce(server)
      .mockRejectedValueOnce(new Error('banner db down'));
    const before = new Set(fs.readdirSync(UPLOAD_DIR));
    const res = await request(app).post(`/api/servers/${server._id}/banner`)
      .set('Authorization', `Bearer ${ownerTok}`)
      .attach('banner', FAKE_PNG, { contentType:'image/png' });
    expect(res.status).toBe(500);
    expect(mockUploadFile).not.toHaveBeenCalled();
    expect(new Set(fs.readdirSync(UPLOAD_DIR))).toEqual(before);
    spy.mockRestore();
  });

  it('icon upload rejects an unsupported MIME in the multer filter', async () => {
    const res = await request(app).post(`/api/servers/${server._id}/icon-image`)
      .set('Authorization', `Bearer ${ownerTok}`)
      .attach('icon', HTML_FILE, { contentType:'text/html' });
    expect(res.status).toBe(400);
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('icon upload returns 404 and cleans staging if the server disappears after authorization', async () => {
    const { Servers } = require('../db/repositories');
    const spy = jest.spyOn(Servers, 'findById')
      .mockResolvedValueOnce(server)
      .mockResolvedValueOnce(null);
    const before = new Set(fs.readdirSync(UPLOAD_DIR));
    const res = await request(app).post(`/api/servers/${server._id}/icon-image`)
      .set('Authorization', `Bearer ${ownerTok}`)
      .attach('icon', FAKE_PNG, { contentType:'image/png' });
    expect(res.status).toBe(404);
    expect(mockUploadFile).not.toHaveBeenCalled();
    expect(new Set(fs.readdirSync(UPLOAD_DIR))).toEqual(before);
    spy.mockRestore();
  });
});
