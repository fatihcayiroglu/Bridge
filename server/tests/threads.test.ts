// server/tests/threads.test.ts
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.NODE_ENV   = 'test';

import request from 'supertest';
import express from 'express';
const jwt     = require('jsonwebtoken');
import { createMockDb, makeUser, makeServer, makeChannel, makeMessage } from './helpers/mockDb';

let db;
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/index', () => {
  const { createMockDb } = require('./helpers/mockDb');
  db = createMockDb();
  return db;
});
jest.mock('../middleware/rateLimit', () => ({
  limits: { messages: () => (req, res, next) => next() },
  rateLimit: () => (req, res, next) => next(),
}));
jest.mock('../routes/roles', () => ({
  getMemberPerms: async () => 0xFFFFFFFF,
  hasPermission:  () => true,
  PERMS: { SEND_MESSAGES: 2, MANAGE_MESSAGES: 4, ADMINISTRATOR: 64 },
}));

import threadsRouter from '../routes/threads';

function makeToken(userId) {
  return jwt.sign({ id: userId, username: 'tester', v: 0 }, 'test-jwt-secret', { expiresIn: '1h' });
}

let app, user, otherUser, server, channel, parentMsg, token, otherToken;

beforeEach(async () => {
  const { createMockDb, makeUser, makeServer, makeChannel, makeMessage } = require('./helpers/mockDb');
  db = createMockDb();
  Object.assign(require('../db/loader'), db);
  Object.assign(require('../db/index'), db);

  user      = makeUser();
  otherUser = makeUser();
  server    = makeServer(user._id);
  channel   = makeChannel(server._id);
  parentMsg = makeMessage(channel._id, server._id, user._id, { content: 'Thread başlangıcı' });

  await db.users.insert(user);
  await db.users.insert(otherUser);
  await db.servers.insert(server);
  await db.channels.insert(channel);
  await db.messages.insert(parentMsg);
  await db.members.insert({ userId: user._id, serverId: server._id, joinedAt: Date.now() });
  await db.members.insert({ userId: otherUser._id, serverId: server._id, joinedAt: Date.now() });

  token      = makeToken(user._id);
  otherToken = makeToken(otherUser._id);

  app = express();
  app.set('io', null); // explicit null — no global leak, routes guard with if (io)
  app.use(express.json());
  app.use('/api/threads', threadsRouter);
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
});

// ══════════════════════════════════════════════════════════════
// THREAD OLUŞTURMA
// ══════════════════════════════════════════════════════════════
describe('POST /api/threads — thread oluştur', () => {
  it('mesajdan thread oluşturur', async () => {
    const res = await request(app)
      .post('/api/threads')
      .set('Authorization', `Bearer ${token}`)
      .send({ parentMessageId: parentMsg._id, name: 'Tartışma' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Tartışma');
    expect(res.body.parentMessageId).toBe(parentMsg._id);
    expect(res.body.channelId).toBe(channel._id);
    expect(res.body.serverId).toBe(server._id);
    expect(res.body.messageCount).toBe(0);
  });

  it('isim verilmezse mesaj içeriğinden isim alır', async () => {
    const res = await request(app)
      .post('/api/threads')
      .set('Authorization', `Bearer ${token}`)
      .send({ parentMessageId: parentMsg._id });

    expect(res.status).toBe(200);
    expect(res.body.name).toContain('Thread başlangıcı');
  });

  it('parentMessageId olmadan 400 döner', async () => {
    const res = await request(app)
      .post('/api/threads')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Test' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/parentMessageId/i);
  });

  it('mevcut olmayan mesaj 404 döner', async () => {
    const res = await request(app)
      .post('/api/threads')
      .set('Authorization', `Bearer ${token}`)
      .send({ parentMessageId: 'nonexistent' });

    expect(res.status).toBe(404);
  });

  it('aynı mesajdan ikinci thread 409 döner', async () => {
    await request(app)
      .post('/api/threads')
      .set('Authorization', `Bearer ${token}`)
      .send({ parentMessageId: parentMsg._id, name: 'İlk Thread' });

    const res = await request(app)
      .post('/api/threads')
      .set('Authorization', `Bearer ${token}`)
      .send({ parentMessageId: parentMsg._id, name: 'İkinci Thread' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it('üye olmayan kullanıcı thread oluşturamaz', async () => {
    const outsider = makeUser();
    await db.users.insert(outsider);
    const outsiderToken = makeToken(outsider._id);

    const res = await request(app)
      .post('/api/threads')
      .set('Authorization', `Bearer ${outsiderToken}`)
      .send({ parentMessageId: parentMsg._id });

    expect(res.status).toBe(403);
  });

  it('thread oluşturulunca orijinal mesaj threadId ile güncellenir', async () => {
    const res = await request(app)
      .post('/api/threads')
      .set('Authorization', `Bearer ${token}`)
      .send({ parentMessageId: parentMsg._id, name: 'Test' });

    const updatedMsg = await db.messages.findOne({ _id: parentMsg._id });
    expect(updatedMsg.threadId).toBe(res.body._id);
  });
});

// ══════════════════════════════════════════════════════════════
// THREAD BİLGİSİ
// ══════════════════════════════════════════════════════════════
describe('GET /api/threads/:threadId — thread bilgisi', () => {
  let thread;

  beforeEach(async () => {
    thread = {
      _id: 'thread1', channelId: channel._id, serverId: server._id,
      parentMessageId: parentMsg._id, name: 'Test Thread',
      createdBy: user._id, createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
    };
    await db.threads.insert(thread);
  });

  it('thread bilgisini döner', async () => {
    const res = await request(app)
      .get(`/api/threads/${thread._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body._id).toBe(thread._id);
    expect(res.body.name).toBe('Test Thread');
  });

  it('mevcut olmayan thread 404 döner', async () => {
    const res = await request(app)
      .get('/api/threads/nonexistent')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it('üye olmayan kullanıcı 403 alır', async () => {
    const outsider = makeUser();
    await db.users.insert(outsider);
    const outsiderToken = makeToken(outsider._id);

    const res = await request(app)
      .get(`/api/threads/${thread._id}`)
      .set('Authorization', `Bearer ${outsiderToken}`);

    expect(res.status).toBe(403);
  });
});

// ══════════════════════════════════════════════════════════════
// THREAD MESAJLARI
// ══════════════════════════════════════════════════════════════
describe('Thread mesajları', () => {
  let thread;

  beforeEach(async () => {
    thread = {
      _id: 'thread-msg-test', channelId: channel._id, serverId: server._id,
      parentMessageId: parentMsg._id, name: 'Mesaj Testi',
      createdBy: user._id, createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
    };
    await db.threads.insert(thread);
  });

  it('thread\'e mesaj gönderir', async () => {
    const res = await request(app)
      .post(`/api/threads/${thread._id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'Thread mesajı' });

    expect(res.status).toBe(200);
    expect(res.body.content).toBe('Thread mesajı');
    expect(res.body.threadId).toBe(thread._id);
  });

  it('boş mesaj 400 döner', async () => {
    const res = await request(app)
      .post(`/api/threads/${thread._id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content: '' });

    expect(res.status).toBe(400);
  });

  it('2000+ karakter mesaj reddedilir', async () => {
    const res = await request(app)
      .post(`/api/threads/${thread._id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'a'.repeat(2001) });

    expect(res.status).toBe(400);
  });

  it('thread mesajlarını listeler', async () => {
    await db.threadMessages.insert({
      _id: 'tm1', threadId: thread._id, channelId: channel._id, serverId: server._id,
      userId: user._id, username: user.username, displayName: user.displayName,
      avatarColor: '#2d9cdb', content: 'İlk mesaj', type: 'normal',
      reactions: {}, createdAt: Date.now(),
    });

    const res = await request(app)
      .get(`/api/threads/${thread._id}/messages`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('mevcut olmayan thread\'e mesaj gönderilemez', async () => {
    const res = await request(app)
      .post('/api/threads/nonexistent/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'Test' });

    expect(res.status).toBe(404);
  });

  it('timeout olan kullanıcı mesaj gönderemez', async () => {
    await db.members.update(
      { userId: user._id, serverId: server._id },
      { $set: { timeoutUntil: Date.now() + 60_000 } }
    );

    const res = await request(app)
      .post(`/api/threads/${thread._id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'Test' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/timed out/i);
  });
});
