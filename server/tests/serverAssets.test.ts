// server/tests/serverAssets.test.ts
// Tests for /api/servers/:sid/banner and /api/servers/:sid/icon-image
// Sprint 73: storageAdapter mock eklendi — CDN entegrasyonu testi
'use strict';

process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';

import path from 'path';
const os   = require('os');
const fs   = require('fs');

const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-sa-test-'));

// Multer'ı temp dizine yönlendir
jest.mock('multer', () => {
  const multer = jest.requireActual('multer');
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename:    (_req, _file, cb) => cb(null, `sa_test_${Date.now()}.png`),
  });
  const m = (opts) => multer({ ...opts, storage });
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

import { createMockDb, makeUser, makeServer } from './helpers/mockDb';
let db = createMockDb();
jest.mock('../db/index', () => { const { createMockDb } = require('./helpers/mockDb'); return createMockDb(); });
jest.mock('../db/loader', () => require('../db/index'));

import request from 'supertest';
import express from 'express';
const jwt    = require('jsonwebtoken');
const router = require('../routes/serverAssets');

function token(userId) {
  return jwt.sign({ id: userId, username: 'owner', v: 0 }, 'test-jwt-secret', { expiresIn: '1h' });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers/:sid', router);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

const FAKE_PNG = path.join(UPLOAD_DIR, 'test.png');
fs.writeFileSync(FAKE_PNG, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic bytes

let app, owner, member, server;
let ownerTok, memberTok;

beforeEach(async () => {
  db = createMockDb();
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
      .post(`/api/servers/${server._id}/banner`)
      .attach('banner', FAKE_PNG, { contentType: 'image/png' });
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
