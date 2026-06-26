// server/tests/soundboard.test.ts
'use strict';

process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';

import path from 'path';
const os   = require('os');
const fs   = require('fs');

const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-sb-test-'));

jest.mock('multer', () => {
  const multer = jest.requireActual('multer');
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename:    (_req, _file, cb) => cb(null, `sound_test_${Date.now()}.mp3`),
  });
  const m = (opts) => multer({ ...opts, storage });
  m.diskStorage = multer.diskStorage;
  return m;
});

import { createMockDb, makeUser, makeServer } from './helpers/mockDb';
let db = createMockDb();
jest.mock('../db/index', () => { const { createMockDb } = require('./helpers/mockDb'); return createMockDb(); });
jest.mock('../db/loader', () => require('../db/index'));

import request from 'supertest';
import express from 'express';
const jwt     = require('jsonwebtoken');
const router  = require('../routes/soundboard');

function token(userId) {
  return jwt.sign({ id: userId, username: 'user', v: 0 }, 'test-jwt-secret', { expiresIn: '1h' });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers/:sid/soundboard', router);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

// Fake audio file (just bytes, multer doesn't validate content)
const FAKE_AUDIO = path.join(UPLOAD_DIR, 'fake.mp3');
fs.writeFileSync(FAKE_AUDIO, Buffer.alloc(512, 0));

let app, owner, member, outsider, server;

beforeEach(async () => {
  db = createMockDb();
  Object.assign(require('../db/loader'), db);
  Object.assign(require('../db/index'), db);

  owner    = makeUser({ username: 'owner' });
  member   = makeUser({ username: 'member' });
  outsider = makeUser({ username: 'outsider' });
  server   = makeServer(owner._id);

  await db.users.insert(owner);
  await db.users.insert(member);
  await db.users.insert(outsider);
  await db.servers.insert(server);
  await db.members.insert({ userId: owner._id,  serverId: server._id, roles: '[]', joinedAt: Date.now() });
  await db.members.insert({ userId: member._id, serverId: server._id, roles: '[]', joinedAt: Date.now() });

  app = buildApp();
});

afterAll(() => {
  try { fs.rmSync(UPLOAD_DIR, { recursive: true }); } catch {}
});

// ═══════════════════════════════════════════════════════
// GET /api/servers/:sid/soundboard
// ═══════════════════════════════════════════════════════
describe('GET /api/servers/:sid/soundboard', () => {
  it('üye ses listesini alır', async () => {
    await db.soundboard.insert({ _id: 's1', serverId: server._id, name: 'boom', emoji: '💥', url: '/uploads/soundboard/boom.mp3', createdAt: Date.now() });
    const res = await request(app)
      .get(`/api/servers/${server._id}/soundboard`)
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
    expect(res.body[0].name).toBe('boom');
  });

  it('boş liste döner (ses yok)', async () => {
    const res = await request(app)
      .get(`/api/servers/${server._id}/soundboard`)
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('üye olmayan 403 alır', async () => {
    const res = await request(app)
      .get(`/api/servers/${server._id}/soundboard`)
      .set('Authorization', `Bearer ${token(outsider._id)}`);
    expect(res.status).toBe(403);
  });

  it('token olmadan 401 döner', async () => {
    const res = await request(app).get(`/api/servers/${server._id}/soundboard`);
    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/servers/:sid/soundboard
// ═══════════════════════════════════════════════════════
describe('POST /api/servers/:sid/soundboard', () => {
  it('sunucu sahibi ses yükleyebilir', async () => {
    const res = await request(app)
      .post(`/api/servers/${server._id}/soundboard`)
      .set('Authorization', `Bearer ${token(owner._id)}`)
      .attach('sound', FAKE_AUDIO, { contentType: 'audio/mpeg' })
      .field('name', 'explosion')
      .field('emoji', '💥');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('explosion');
    expect(res.body.emoji).toBe('💥');
    expect(res.body.url).toMatch(/\/uploads\/soundboard\//);
    expect(res.body.serverId).toBe(server._id);
  });

  it('name olmasa filename\'den türetir', async () => {
    const res = await request(app)
      .post(`/api/servers/${server._id}/soundboard`)
      .set('Authorization', `Bearer ${token(owner._id)}`)
      .attach('sound', FAKE_AUDIO, 'mysound.mp3');
    expect(res.status).toBe(200);
    expect(typeof res.body.name).toBe('string');
    expect(res.body.name.length).toBeGreaterThan(0);
  });

  it('normal üye ses yükleyemez', async () => {
    const res = await request(app)
      .post(`/api/servers/${server._id}/soundboard`)
      .set('Authorization', `Bearer ${token(member._id)}`)
      .attach('sound', FAKE_AUDIO, { contentType: 'audio/mpeg' })
      .field('name', 'test');
    expect(res.status).toBe(403);
  });

  it('dosya olmadan 400 döner', async () => {
    const res = await request(app)
      .post(`/api/servers/${server._id}/soundboard`)
      .set('Authorization', `Bearer ${token(owner._id)}`)
      .field('name', 'nofile');
    expect(res.status).toBe(400);
  });

  it('64 ses limitini aşınca 400 döner', async () => {
    // 64 ses ekle
    for (let i = 0; i < 64; i++) {
      await db.soundboard.insert({ _id: `s${i}`, serverId: server._id, name: `sound${i}`, url: `/uploads/soundboard/s${i}.mp3`, createdAt: Date.now() });
    }
    const res = await request(app)
      .post(`/api/servers/${server._id}/soundboard`)
      .set('Authorization', `Bearer ${token(owner._id)}`)
      .attach('sound', FAKE_AUDIO, { contentType: 'audio/mpeg' })
      .field('name', 'overflow');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/maximum 64/i);
  });

  it('token olmadan 401 döner', async () => {
    const res = await request(app).post(`/api/servers/${server._id}/soundboard`);
    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════
// DELETE /api/servers/:sid/soundboard/:soundId
// ═══════════════════════════════════════════════════════
describe('DELETE /api/servers/:sid/soundboard/:soundId', () => {
  it('sunucu sahibi ses silebilir', async () => {
    // Create a real temp file to simulate uploaded sound
    const tmpFile = path.join(UPLOAD_DIR, 'sound_del.mp3');
    fs.writeFileSync(tmpFile, Buffer.alloc(64));
    await db.soundboard.insert({ _id: 'del1', serverId: server._id, name: 'to-delete', url: '/uploads/soundboard/sound_del.mp3', createdAt: Date.now() });

    const res = await request(app)
      .delete(`/api/servers/${server._id}/soundboard/del1`)
      .set('Authorization', `Bearer ${token(owner._id)}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('mevcut olmayan ses 404 döner', async () => {
    const res = await request(app)
      .delete(`/api/servers/${server._id}/soundboard/nonexistent`)
      .set('Authorization', `Bearer ${token(owner._id)}`);
    expect(res.status).toBe(404);
  });

  it('normal üye silemez', async () => {
    await db.soundboard.insert({ _id: 'del2', serverId: server._id, name: 'protected', url: '/uploads/soundboard/p.mp3', createdAt: Date.now() });
    const res = await request(app)
      .delete(`/api/servers/${server._id}/soundboard/del2`)
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(403);
  });
});
