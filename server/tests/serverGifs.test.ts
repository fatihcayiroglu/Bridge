// server/tests/serverGifs.test.ts
// Tests for /api/servers/:id/gifs routes
'use strict';

process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';

import { createMockDb, makeUser, makeServer } from './helpers/mockDb';
import type { ServerFixture, UserFixture } from './helpers/mockDb';
let db = createMockDb();
jest.mock('../db/index', () => { const { createMockDb } = require('./helpers/mockDb'); return createMockDb(); });
jest.mock('../db/loader', () => require('../db/index'));

// Mock roles helper (MANAGE_CHANNELS = 16)
jest.mock('../routes/roles', () => ({
  getMemberPerms: async (userId: string, serverId: string) => {
    const dbMod = require('../db/index');
    const server = await dbMod.servers.findOne({ _id: serverId });
    if (server?.ownerId === userId) return 0xFFFFFFFF; // all perms
    return 0;
  },
  hasPermission: (perms: number, flag: number) => (perms & flag) !== 0,
  PERMS: { MANAGE_CHANNELS: 16, ADMINISTRATOR: 8 },
}));

import request from 'supertest';
import express from 'express';
const jwt     = require('jsonwebtoken');
const router  = require('../routes/serverGifs');

function token(userId: string) {
  return jwt.sign({ id: userId, username: 'user', v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers/:id/gifs', router);
  app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

let app: express.Express;
let owner: UserFixture;
let member: UserFixture;
let outsider: UserFixture;
let server: ServerFixture;

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

// ═══════════════════════════════════════════════════════
// GET /api/servers/:id/gifs
// ═══════════════════════════════════════════════════════
describe('GET /api/servers/:id/gifs', () => {
  beforeEach(async () => {
    await db.serverGifs.insert({ _id: 'gif1', serverId: server._id, name: 'funnycat', tags: ['cat', 'funny'], url: '/uploads/cat.gif', createdAt: Date.now() });
    await db.serverGifs.insert({ _id: 'gif2', serverId: server._id, name: 'doggo',    tags: ['dog'],          url: '/uploads/dog.gif', createdAt: Date.now() });
  });

  it('üye tüm GIF\'leri alır', async () => {
    const res = await request(app)
      .get(`/api/servers/${server._id}/gifs`)
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
  });

  it('q parametresiyle filtreler', async () => {
    const res = await request(app)
      .get(`/api/servers/${server._id}/gifs?q=cat`)
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].name).toBe('funnycat');
  });

  it('üye olmayan 403 alır', async () => {
    const res = await request(app)
      .get(`/api/servers/${server._id}/gifs`)
      .set('Authorization', `Bearer ${token(outsider._id)}`);
    expect(res.status).toBe(403);
  });

  it('token olmadan 401 döner', async () => {
    const res = await request(app).get(`/api/servers/${server._id}/gifs`);
    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/servers/:id/gifs
// ═══════════════════════════════════════════════════════
describe('POST /api/servers/:id/gifs', () => {
  const gifKey = 'uploads/server-gifs/gif_11111111-1111-4111-8111-111111111111.gif';
  const validGif = { name: 'explosion', url: `/${gifKey}`, tags: ['action'] };

  async function seedOwnedUpload(userId = owner._id) {
    await db.uploads.insert({ _id: `upload-${userId}`, userId, key: gifKey, originalName: 'boom.gif', mimeType: 'image/gif', createdAt: Date.now() });
  }

  it('admin yeni GIF ekleyebilir', async () => {
    await seedOwnedUpload();
    const res = await request(app)
      .post(`/api/servers/${server._id}/gifs`)
      .set('Authorization', `Bearer ${token(owner._id)}`)
      .send(validGif);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('explosion');
    expect(res.body.url).toBe(`/${gifKey}`);
  });

  it('normal üye GIF ekleyemez', async () => {
    const res = await request(app)
      .post(`/api/servers/${server._id}/gifs`)
      .set('Authorization', `Bearer ${token(member._id)}`)
      .send(validGif);
    expect(res.status).toBe(403);
  });

  it('isim eksikse 400 döner', async () => {
    const res = await request(app)
      .post(`/api/servers/${server._id}/gifs`)
      .set('Authorization', `Bearer ${token(owner._id)}`)
      .send({ url: `/${gifKey}` });
    expect(res.status).toBe(400);
  });

  it('geçersiz url\'de 400 döner', async () => {
    const res = await request(app)
      .post(`/api/servers/${server._id}/gifs`)
      .set('Authorization', `Bearer ${token(owner._id)}`)
      .send({ name: 'test', url: 'https://external.com/img.gif' });
    expect(res.status).toBe(400);
  });

  it('başka kullanıcının pre-upload kaydını server GIF olarak sahiplenemez', async () => {
    await seedOwnedUpload(member._id);
    const res = await request(app)
      .post(`/api/servers/${server._id}/gifs`)
      .set('Authorization', `Bearer ${token(owner._id)}`)
      .send(validGif);
    expect(res.status).toBe(403);
  });

  it('generic protected attachment namespace server GIF olarak kabul edilmez', async () => {
    await db.uploads.insert({ _id: 'private-upload', userId: owner._id, key: 'uploads/11111111-1111-4111-8111-111111111111.gif' });
    const res = await request(app)
      .post(`/api/servers/${server._id}/gifs`)
      .set('Authorization', `Bearer ${token(owner._id)}`)
      .send({ name: 'private', url: '/uploads/11111111-1111-4111-8111-111111111111.gif' });
    expect(res.status).toBe(400);
  });

});

// ═══════════════════════════════════════════════════════
// DELETE /api/servers/:id/gifs/:gifId
// ═══════════════════════════════════════════════════════
describe('DELETE /api/servers/:id/gifs/:gifId', () => {
  it('admin GIF silebilir', async () => {
    const gif = await db.serverGifs.insert({ _id: 'del1', serverId: server._id, name: 'tobedeleted', url: '/uploads/del.gif', createdAt: Date.now() });
    const res = await request(app)
      .delete(`/api/servers/${server._id}/gifs/del1`)
      .set('Authorization', `Bearer ${token(owner._id)}`);
    expect(res.status).toBe(200);
  });

  it('mevcut olmayan GIF 404 döner', async () => {
    const res = await request(app)
      .delete(`/api/servers/${server._id}/gifs/nonexistent`)
      .set('Authorization', `Bearer ${token(owner._id)}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/servers/:id/gifs runtime body validation', () => {
  const key = 'uploads/server-gifs/gif_22222222-2222-4222-8222-222222222222.gif';

  beforeEach(async () => {
    await db.uploads.insert({ _id: 'runtime-gif-upload', userId: owner._id, key, originalName: 'safe.gif', mimeType: 'image/gif', createdAt: Date.now() });
  });

  it.each([
    [{ name: 7, url: `/${key}` }, /name/i],
    [{ name: 'safe', url: 7 }, /name|url/i],
    [{ name: 'safe', url: `/${key}`, tags: 'tag' }, /tags/i],
    [{ name: 'safe', url: `/${key}`, tags: ['ok', 7] }, /tags/i],
    [{ name: 'safe', url: `/${key}`, fileType: { mime: 'image/gif' } }, /fileType/i],
  ])('rejects malformed GIF metadata %# without persistence', async (body, errorPattern) => {
    const before = await db.serverGifs.count({ serverId: server._id });
    const res = await request(app).post(`/api/servers/${server._id}/gifs`)
      .set('Authorization', `Bearer ${token(owner._id)}`).send(body);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(errorPattern);
    expect(await db.serverGifs.count({ serverId: server._id })).toBe(before);
  });
});
