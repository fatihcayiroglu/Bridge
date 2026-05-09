// server/tests/messages.test.js
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.NODE_ENV   = 'test';

const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { createMockDb, makeUser, makeServer, makeChannel, makeMessage } = require('./helpers/mockDb');

let db;

jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/index', () => {
  const { createMockDb } = require('./helpers/mockDb');
  db = createMockDb();
  return db;
});

jest.mock('../routes/roles', () => ({
  getMemberPerms: async () => 0xFFFFFFFF,
  hasPermission:  () => true,
  PERMS: { MANAGE_MESSAGES: 32, SEND_MESSAGES: 16 },
}));

jest.mock('../middleware/rateLimit', () => ({
  limits: { messages: () => (req, res, next) => next(), react: () => (req, res, next) => next() },
  rateLimit: () => (req, res, next) => next(),
}));

const messagesRouter = require('../routes/messages');

function makeToken(userId, username = 'tester') {
  return jwt.sign({ id: userId, username, v: 0 }, 'test-jwt-secret', { expiresIn: '1h' });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/channels', messagesRouter);
  app.use('/api/messages', messagesRouter);
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return app;
}

let app, user, otherUser, server, channel, token, otherToken;

beforeEach(async () => {
  db = createMockDb();
  Object.assign(require('../db/loader'), db);
  Object.assign(require('../db/index'), db);

  user      = makeUser({ username: 'user1' });
  otherUser = makeUser({ username: 'user2' });
  server    = makeServer(user._id);
  channel   = makeChannel(server._id);

  await db.users.insert(user);
  await db.users.insert(otherUser);
  await db.servers.insert(server);
  await db.channels.insert(channel);
  await db.members.insert({ userId: user._id, serverId: server._id, joinedAt: Date.now() });

  token      = makeToken(user._id, user.username);
  otherToken = makeToken(otherUser._id, otherUser.username);

  app = buildApp();
});

// ══════════════════════════════════════════════════════════════
// MESAJ REAKSİYONLARI
// ══════════════════════════════════════════════════════════════
describe('POST /api/messages/:id/react — reaksiyon', () => {
  let msg;

  beforeEach(async () => {
    msg = makeMessage(channel._id, server._id, user._id, { content: 'hello' });
    await db.messages.insert(msg);
  });

  it('reaksiyon ekler', async () => {
    const res = await request(app)
      .post(`/api/messages/${msg._id}/react`)
      .set('Authorization', `Bearer ${token}`)
      .send({ emoji: '👍' });

    expect(res.status).toBe(200);
    const updated = await db.messages.findOne({ _id: msg._id });
    expect(updated.reactions['👍']).toContain(user._id);
  });

  it('aynı reaksiyona tekrar basmak kaldırır (toggle)', async () => {
    await request(app)
      .post(`/api/messages/${msg._id}/react`)
      .set('Authorization', `Bearer ${token}`)
      .send({ emoji: '👍' });

    const res = await request(app)
      .post(`/api/messages/${msg._id}/react`)
      .set('Authorization', `Bearer ${token}`)
      .send({ emoji: '👍' });

    expect(res.status).toBe(200);
    const updated = await db.messages.findOne({ _id: msg._id });
    expect(updated.reactions['👍']).toBeFalsy();
  });

  it('boş emoji 400 döner', async () => {
    const res = await request(app)
      .post(`/api/messages/${msg._id}/react`)
      .set('Authorization', `Bearer ${token}`)
      .send({ emoji: '' });

    expect(res.status).toBe(400);
  });

  it('üye olmayan kullanıcı reaksiyon ekleyemez', async () => {
    const res = await request(app)
      .post(`/api/messages/${msg._id}/react`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ emoji: '❤️' });

    expect(res.status).toBe(403);
  });

  it('mevcut olmayan mesaj 404 döner', async () => {
    const res = await request(app)
      .post('/api/messages/nonexistent/react')
      .set('Authorization', `Bearer ${token}`)
      .send({ emoji: '👍' });

    expect(res.status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════
// MESAJ DÜZENLEME
// ══════════════════════════════════════════════════════════════
describe('PATCH /api/messages/:id — mesaj düzenle', () => {
  let msg;

  beforeEach(async () => {
    msg = makeMessage(channel._id, server._id, user._id, { content: 'orijinal içerik' });
    await db.messages.insert(msg);
  });

  it('kendi mesajını düzenler', async () => {
    const res = await request(app)
      .patch(`/api/messages/${msg._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'düzenlenmiş içerik' });

    expect(res.status).toBe(200);
    const updated = await db.messages.findOne({ _id: msg._id });
    expect(updated.content).toBe('düzenlenmiş içerik');
    expect(updated.editedAt).toBeDefined();
  });

  it('başkasının mesajını düzenleyemez', async () => {
    await db.members.insert({ userId: otherUser._id, serverId: server._id, joinedAt: Date.now() });

    const res = await request(app)
      .patch(`/api/messages/${msg._id}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ content: 'hack denemesi' });

    expect(res.status).toBe(403);
  });

  it('boş içerik 400 döner', async () => {
    const res = await request(app)
      .patch(`/api/messages/${msg._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content: '' });

    expect(res.status).toBe(400);
  });

  it('mevcut olmayan mesaj 404 döner', async () => {
    const res = await request(app)
      .patch('/api/messages/nonexistent')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'test' });

    expect(res.status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════
// MESAJ SİLME
// ══════════════════════════════════════════════════════════════
describe('DELETE /api/messages/:id — mesaj sil', () => {
  let msg;

  beforeEach(async () => {
    msg = makeMessage(channel._id, server._id, user._id);
    await db.messages.insert(msg);
  });

  it('kendi mesajını siler', async () => {
    const res = await request(app)
      .delete(`/api/messages/${msg._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const deleted = await db.messages.findOne({ _id: msg._id });
    expect(deleted).toBeNull();
  });

  it('başkasının mesajını silemez', async () => {
    await db.members.insert({ userId: otherUser._id, serverId: server._id, joinedAt: Date.now() });

    const res = await request(app)
      .delete(`/api/messages/${msg._id}`)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(403);
  });

  it('mevcut olmayan mesaj 404 döner', async () => {
    const res = await request(app)
      .delete('/api/messages/nonexistent')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});
