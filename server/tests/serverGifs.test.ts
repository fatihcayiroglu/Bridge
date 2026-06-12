// server/tests/serverGifs.test.ts
// Tests for /api/servers/:id/gifs routes
'use strict';

process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';

import { createMockDb, makeUser, makeServer } from './helpers/mockDb';
let db = createMockDb();
jest.mock('../db/index', () => { const { createMockDb } = require('./helpers/mockDb'); return createMockDb(); });
jest.mock('../db/loader', () => require('../db/index'));

// Mock roles helper (MANAGE_CHANNELS = 16)
jest.mock('../routes/roles', () => ({
  getMemberPerms: async (userId, serverId) => {
    const dbMod = require('../db/index');
    const server = await dbMod.servers.findOne({ _id: serverId });
    if (server?.ownerId === userId) return 0xFFFFFFFF; // all perms
    return 0;
  },
  hasPermission: (perms, flag) => (perms & flag) !== 0,
  PERMS: { MANAGE_CHANNELS: 16, ADMINISTRATOR: 8 },
}));

import request from 'supertest';
import express from 'express';
const jwt     = require('jsonwebtoken');
const router  = require('../routes/serverGifs');

function token(userId) {
  return jwt.sign({ id: userId, username: 'user', v: 0 }, 'test-jwt-secret', { expiresIn: '1h' });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers/:id/gifs', router);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

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
  const validGif = { name: 'explosion', url: '/uploads/boom.gif', tags: ['action'] };

  it('admin yeni GIF ekleyebilir', async () => {
    const res = await request(app)
      .post(`/api/servers/${server._id}/gifs`)
      .set('Authorization', `Bearer ${token(owner._id)}`)
      .send(validGif);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('explosion');
    expect(res.body.url).toBe('/uploads/boom.gif');
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
      .send({ url: '/uploads/boom.gif' });
    expect(res.status).toBe(400);
  });

  it('geçersiz url\'de 400 döner', async () => {
    const res = await request(app)
      .post(`/api/servers/${server._id}/gifs`)
      .set('Authorization', `Bearer ${token(owner._id)}`)
      .send({ name: 'test', url: 'https://external.com/img.gif' });
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
