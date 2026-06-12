// server/tests/reactionRoles.test.ts
'use strict';

process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';

import { createMockDb, makeUser, makeServer, makeChannel } from './helpers/mockDb';
let db = createMockDb();
jest.mock('../db/index', () => { const { createMockDb } = require('./helpers/mockDb'); return createMockDb(); });
jest.mock('../db/loader', () => require('../db/index'));

// MANAGE_ROLES = 0x10000000 (owner gets all perms, others get 0)
jest.mock('../routes/roles', () => ({
  getMemberPerms: async (userId, serverId) => {
    const dbMod = require('../db/index');
    const srv = await dbMod.servers.findOne({ _id: serverId });
    return srv?.ownerId === userId ? 0xFFFFFFFF : 0;
  },
  hasPermission: (perms, flag) => (perms & flag) !== 0,
  PERMS: { MANAGE_ROLES: 0x10000000 },
}));

import request from 'supertest';
import express from 'express';
const jwt     = require('jsonwebtoken');
const router  = require('../routes/reactionRoles');

function token(userId) {
  return jwt.sign({ id: userId, username: 'user', v: 0 }, 'test-jwt-secret', { expiresIn: '1h' });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers/:sid/reaction-roles', router);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

let app, owner, member, outsider, server, channel;

beforeEach(async () => {
  db = createMockDb();
  Object.assign(require('../db/loader'), db);
  Object.assign(require('../db/index'), db);

  owner    = makeUser({ username: 'owner' });
  member   = makeUser({ username: 'member' });
  outsider = makeUser({ username: 'outsider' });
  server   = makeServer(owner._id);
  channel  = makeChannel(server._id);

  await db.users.insert(owner);
  await db.users.insert(member);
  await db.users.insert(outsider);
  await db.servers.insert(server);
  await db.channels.insert(channel);
  await db.members.insert({ userId: owner._id,  serverId: server._id, roles: '[]', joinedAt: Date.now() });
  await db.members.insert({ userId: member._id, serverId: server._id, roles: '[]', joinedAt: Date.now() });

  app = buildApp();
});

const validRule = () => ({
  channelId: 'ch1',
  messageId: 'msg1',
  emoji:     '🎉',
  roleId:    'role1',
});

// ═══════════════════════════════════════════════════════
// GET /api/servers/:sid/reaction-roles
// ═══════════════════════════════════════════════════════
describe('GET /api/servers/:sid/reaction-roles', () => {
  it('üye kuralları listeler', async () => {
    await db.reactionRoles.insert({ _id: 'rr1', serverId: server._id, ...validRule(), createdAt: Date.now() });
    const res = await request(app)
      .get(`/api/servers/${server._id}/reaction-roles`)
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
    expect(res.body[0].emoji).toBe('🎉');
  });

  it('kural yokken boş liste döner', async () => {
    const res = await request(app)
      .get(`/api/servers/${server._id}/reaction-roles`)
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('üye olmayan 403 alır', async () => {
    const res = await request(app)
      .get(`/api/servers/${server._id}/reaction-roles`)
      .set('Authorization', `Bearer ${token(outsider._id)}`);
    expect(res.status).toBe(403);
  });

  it('token olmadan 401 döner', async () => {
    const res = await request(app).get(`/api/servers/${server._id}/reaction-roles`);
    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/servers/:sid/reaction-roles
// ═══════════════════════════════════════════════════════
describe('POST /api/servers/:sid/reaction-roles', () => {
  it('admin yeni kural ekleyebilir', async () => {
    const res = await request(app)
      .post(`/api/servers/${server._id}/reaction-roles`)
      .set('Authorization', `Bearer ${token(owner._id)}`)
      .send(validRule());
    expect(res.status).toBe(200);
    expect(res.body.emoji).toBe('🎉');
    expect(res.body.serverId).toBe(server._id);
    expect(res.body._id).toBeDefined();
  });

  it('normal üye kural ekleyemez', async () => {
    const res = await request(app)
      .post(`/api/servers/${server._id}/reaction-roles`)
      .set('Authorization', `Bearer ${token(member._id)}`)
      .send(validRule());
    expect(res.status).toBe(403);
  });

  it('aynı kombinasyon tekrar 409 döner', async () => {
    await request(app)
      .post(`/api/servers/${server._id}/reaction-roles`)
      .set('Authorization', `Bearer ${token(owner._id)}`)
      .send(validRule());

    const res = await request(app)
      .post(`/api/servers/${server._id}/reaction-roles`)
      .set('Authorization', `Bearer ${token(owner._id)}`)
      .send(validRule());
    expect(res.status).toBe(409);
  });

  it('emoji eksikse 400 döner', async () => {
    const { emoji, ...noEmoji } = validRule();
    const res = await request(app)
      .post(`/api/servers/${server._id}/reaction-roles`)
      .set('Authorization', `Bearer ${token(owner._id)}`)
      .send(noEmoji);
    expect(res.status).toBe(400);
  });

  it('channelId eksikse 400 döner', async () => {
    const { channelId, ...noChannel } = validRule();
    const res = await request(app)
      .post(`/api/servers/${server._id}/reaction-roles`)
      .set('Authorization', `Bearer ${token(owner._id)}`)
      .send(noChannel);
    expect(res.status).toBe(400);
  });

  it('çok uzun emoji 400 döner', async () => {
    const res = await request(app)
      .post(`/api/servers/${server._id}/reaction-roles`)
      .set('Authorization', `Bearer ${token(owner._id)}`)
      .send({ ...validRule(), emoji: 'x'.repeat(65) });
    expect(res.status).toBe(400);
  });

  it('token olmadan 401 döner', async () => {
    const res = await request(app)
      .post(`/api/servers/${server._id}/reaction-roles`)
      .send(validRule());
    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════
// DELETE /api/servers/:sid/reaction-roles/:rrId
// ═══════════════════════════════════════════════════════
describe('DELETE /api/servers/:sid/reaction-roles/:rrId', () => {
  it('admin kuralı silebilir', async () => {
    await db.reactionRoles.insert({ _id: 'rrDel', serverId: server._id, ...validRule(), createdAt: Date.now() });
    const res = await request(app)
      .delete(`/api/servers/${server._id}/reaction-roles/rrDel`)
      .set('Authorization', `Bearer ${token(owner._id)}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('normal üye silemez', async () => {
    await db.reactionRoles.insert({ _id: 'rrProt', serverId: server._id, ...validRule(), createdAt: Date.now() });
    const res = await request(app)
      .delete(`/api/servers/${server._id}/reaction-roles/rrProt`)
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(403);
  });

  it('mevcut olmayan kural 404 döner', async () => {
    const res = await request(app)
      .delete(`/api/servers/${server._id}/reaction-roles/nonexistent`)
      .set('Authorization', `Bearer ${token(owner._id)}`);
    expect(res.status).toBe(404);
  });
});
