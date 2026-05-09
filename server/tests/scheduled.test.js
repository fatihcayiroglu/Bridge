// server/tests/scheduled.test.js
'use strict';

process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';

const { createMockDb, makeUser, makeServer, makeChannel } = require('./helpers/mockDb');
let db = createMockDb();
jest.mock('../db/index', () => { const { createMockDb } = require('./helpers/mockDb'); return createMockDb(); });
jest.mock('../db/loader', () => require('../db/index'));

// SEND_MESSAGES = 0x800 — owner gets all, member gets SEND_MESSAGES, outsider gets 0
jest.mock('../routes/roles', () => ({
  getMemberPerms: async (userId, serverId) => {
    const dbMod = require('../db/index');
    const srv = await dbMod.servers.findOne({ _id: serverId });
    if (srv?.ownerId === userId) return 0xFFFFFFFF;
    const member = await dbMod.members.findOne({ userId, serverId });
    return member ? 0x800 : 0; // SEND_MESSAGES for members
  },
  hasPermission: (perms, flag) => (perms & flag) !== 0,
  PERMS: { SEND_MESSAGES: 0x800 },
}));

const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const router  = require('../routes/scheduled');

function token(userId, extra = {}) {
  return jwt.sign({ id: userId, username: 'user', displayName: 'User', v: 0, ...extra }, 'test-jwt-secret', { expiresIn: '1h' });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/scheduled', router);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

const FUTURE = Date.now() + 60 * 60 * 1000; // 1 hour from now

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

// ═══════════════════════════════════════════════════════
// POST /api/scheduled
// ═══════════════════════════════════════════════════════
describe('POST /api/scheduled', () => {
  it('üye mesaj zamanlayabilir', async () => {
    const res = await request(app)
      .post('/api/scheduled')
      .set('Authorization', `Bearer ${token(member._id)}`)
      .send({ channelId: channel._id, serverId: server._id, content: 'Merhaba!', sendAt: new Date(FUTURE).toISOString() });
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('Merhaba!');
    expect(res.body.sent).toBe(false);
    expect(res.body.sendAt).toBeGreaterThan(Date.now());
  });

  it('2000 karakterden uzun içerik kısaltılır', async () => {
    const long = 'x'.repeat(3000);
    const res = await request(app)
      .post('/api/scheduled')
      .set('Authorization', `Bearer ${token(member._id)}`)
      .send({ channelId: channel._id, serverId: server._id, content: long, sendAt: new Date(FUTURE).toISOString() });
    expect(res.status).toBe(200);
    expect(res.body.content.length).toBe(2000);
  });

  it('geçmişte sendAt 400 döner', async () => {
    const past = Date.now() - 60000;
    const res = await request(app)
      .post('/api/scheduled')
      .set('Authorization', `Bearer ${token(member._id)}`)
      .send({ channelId: channel._id, serverId: server._id, content: 'test', sendAt: new Date(past).toISOString() });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/future/i);
  });

  it('30 günden fazla ilerisi 400 döner', async () => {
    const tooFar = Date.now() + 31 * 24 * 60 * 60 * 1000;
    const res = await request(app)
      .post('/api/scheduled')
      .set('Authorization', `Bearer ${token(member._id)}`)
      .send({ channelId: channel._id, serverId: server._id, content: 'test', sendAt: new Date(tooFar).toISOString() });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/30 days/i);
  });

  it('üye olmayan 403 alır', async () => {
    const res = await request(app)
      .post('/api/scheduled')
      .set('Authorization', `Bearer ${token(outsider._id)}`)
      .send({ channelId: channel._id, serverId: server._id, content: 'test', sendAt: new Date(FUTURE).toISOString() });
    expect(res.status).toBe(403);
  });

  it('channelId eksikse 400 döner', async () => {
    const res = await request(app)
      .post('/api/scheduled')
      .set('Authorization', `Bearer ${token(member._id)}`)
      .send({ serverId: server._id, content: 'test', sendAt: new Date(FUTURE).toISOString() });
    expect(res.status).toBe(400);
  });

  it('boş içerik 400 döner', async () => {
    const res = await request(app)
      .post('/api/scheduled')
      .set('Authorization', `Bearer ${token(member._id)}`)
      .send({ channelId: channel._id, serverId: server._id, content: '   ', sendAt: new Date(FUTURE).toISOString() });
    expect(res.status).toBe(400);
  });

  it('token olmadan 401 döner', async () => {
    const res = await request(app)
      .post('/api/scheduled')
      .send({ channelId: channel._id, serverId: server._id, content: 'test', sendAt: new Date(FUTURE).toISOString() });
    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════
// GET /api/scheduled
// ═══════════════════════════════════════════════════════
describe('GET /api/scheduled', () => {
  it('kullanıcının bekleyen mesajlarını listeler', async () => {
    await db.scheduledMsgs.insert({ _id: 'sm1', userId: member._id, serverId: server._id, channelId: channel._id, content: 'test', sendAt: FUTURE, sent: false, createdAt: Date.now() });
    await db.scheduledMsgs.insert({ _id: 'sm2', userId: member._id, serverId: server._id, channelId: channel._id, content: 'sent', sendAt: FUTURE - 1000, sent: true,  createdAt: Date.now() });

    const res = await request(app)
      .get('/api/scheduled')
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Should not include already-sent messages
    expect(res.body.every(m => m.sent === false)).toBe(true);
  });

  it('başka kullanıcının mesajlarını göstermez', async () => {
    await db.scheduledMsgs.insert({ _id: 'sm3', userId: owner._id, serverId: server._id, channelId: channel._id, content: 'owner msg', sendAt: FUTURE, sent: false, createdAt: Date.now() });

    const res = await request(app)
      .get('/api/scheduled')
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(200);
    expect(res.body.every(m => m.userId === member._id)).toBe(true);
  });

  it('token olmadan 401 döner', async () => {
    const res = await request(app).get('/api/scheduled');
    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════
// DELETE /api/scheduled/:id
// ═══════════════════════════════════════════════════════
describe('DELETE /api/scheduled/:id', () => {
  it('bekleyen mesajı iptal eder', async () => {
    await db.scheduledMsgs.insert({ _id: 'smDel', userId: member._id, serverId: server._id, channelId: channel._id, content: 'cancel me', sendAt: FUTURE, sent: false, createdAt: Date.now() });

    const res = await request(app)
      .delete('/api/scheduled/smDel')
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(200);
    expect(res.body.cancelled).toBe(true);
  });

  it('gönderilmiş mesajı iptal edemez', async () => {
    await db.scheduledMsgs.insert({ _id: 'smSent', userId: member._id, serverId: server._id, channelId: channel._id, content: 'already sent', sendAt: FUTURE - 1000, sent: true, createdAt: Date.now() });

    const res = await request(app)
      .delete('/api/scheduled/smSent')
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already sent/i);
  });

  it('başka kullanıcının mesajını iptal edemez', async () => {
    await db.scheduledMsgs.insert({ _id: 'smOther', userId: owner._id, serverId: server._id, channelId: channel._id, content: 'owner msg', sendAt: FUTURE, sent: false, createdAt: Date.now() });

    const res = await request(app)
      .delete('/api/scheduled/smOther')
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(404);
  });

  it('mevcut olmayan mesaj 404 döner', async () => {
    const res = await request(app)
      .delete('/api/scheduled/nonexistent')
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(404);
  });
});
