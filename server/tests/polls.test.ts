// server/tests/polls.test.ts
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.NODE_ENV   = 'test';

import request from 'supertest';
import express from 'express';
const jwt     = require('jsonwebtoken');
import { createMockDb, makeUser, makeServer, makeChannel } from './helpers/mockDb';

let db;
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/index', () => {
  const { createMockDb } = require('./helpers/mockDb');
  db = createMockDb();
  return db;
});
jest.mock('../middleware/rateLimit', () => ({
  limits: {
    messages: () => (req, res, next) => next(),
    ai:       () => (req, res, next) => next(),
    polls:    () => (req, res, next) => next(),
  },
  rateLimit: () => (req, res, next) => next(),
}));

import pollsRouter from '../routes/polls';

function makeToken(userId) {
  return jwt.sign({ id: userId, username: 'tester', v: 0 }, 'test-jwt-secret', { expiresIn: '1h' });
}

let app;
let user, otherUser, server, channel;
let token, otherToken;

beforeEach(async () => {
  const { createMockDb, makeUser, makeServer, makeChannel } = require('./helpers/mockDb');
  db = createMockDb();
  const dbMod = require('../db/index');
  Object.assign(dbMod, db);

  user      = makeUser();
  otherUser = makeUser();
  server    = makeServer(user._id);
  channel   = makeChannel(server._id);

  await db.users.insert(user);
  await db.users.insert(otherUser);
  await db.servers.insert(server);
  await db.channels.insert(channel);
  await db.members.insert({ userId: user._id, serverId: server._id, joinedAt: Date.now() });
  await db.members.insert({ userId: otherUser._id, serverId: server._id, joinedAt: Date.now() });

  token      = makeToken(user._id);
  otherToken = makeToken(otherUser._id);

  app = express();
  app.use(express.json());
  app.use('/api/channels', pollsRouter);
  app.use('/api/polls', pollsRouter);
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
});

// ══════════════════════════════════════════════════════════════
// ANKET OLUŞTURMA
// ══════════════════════════════════════════════════════════════
describe('POST /api/channels/:cid/polls — anket oluştur', () => {
  it('geçerli anket oluşturur', async () => {
    const res = await request(app)
      .post(`/api/channels/${channel._id}/polls`)
      .set('Authorization', `Bearer ${token}`)
      .send({ question: 'Favori renk?', options: ['Kırmızı', 'Mavi', 'Yeşil'] });

    expect(res.status).toBe(200);
    expect(res.body.question).toBe('Favori renk?');
    expect(res.body.options).toHaveLength(3);
    expect(res.body.closed).toBe(false);
    expect(res.body.options[0].votes).toEqual([]);
  });

  it('soru olmadan 400 döner', async () => {
    const res = await request(app)
      .post(`/api/channels/${channel._id}/polls`)
      .set('Authorization', `Bearer ${token}`)
      .send({ options: ['A', 'B'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/question/i);
  });

  it('1 seçenekle 400 döner (min 2)', async () => {
    const res = await request(app)
      .post(`/api/channels/${channel._id}/polls`)
      .set('Authorization', `Bearer ${token}`)
      .send({ question: 'Test?', options: ['Sadece bir'] });
    expect(res.status).toBe(400);
  });

  it('11 seçenekle 400 döner (max 10)', async () => {
    const res = await request(app)
      .post(`/api/channels/${channel._id}/polls`)
      .set('Authorization', `Bearer ${token}`)
      .send({ question: 'Test?', options: Array.from({ length: 11 }, (_, i) => `Seçenek ${i}`) });
    expect(res.status).toBe(400);
  });

  it('mevcut olmayan kanal 404 döner', async () => {
    const res = await request(app)
      .post('/api/channels/nonexistent/polls')
      .set('Authorization', `Bearer ${token}`)
      .send({ question: 'Test?', options: ['A', 'B'] });
    expect(res.status).toBe(404);
  });

  it('üye olmayan kullanıcı 403 alır', async () => {
    const outsider = makeUser();
    await db.users.insert(outsider);
    const outsiderToken = makeToken(outsider._id);

    const res = await request(app)
      .post(`/api/channels/${channel._id}/polls`)
      .set('Authorization', `Bearer ${outsiderToken}`)
      .send({ question: 'Test?', options: ['A', 'B'] });
    expect(res.status).toBe(403);
  });

  it('multiSelect anket oluşturur', async () => {
    const res = await request(app)
      .post(`/api/channels/${channel._id}/polls`)
      .set('Authorization', `Bearer ${token}`)
      .send({ question: 'Çoklu?', options: ['A', 'B', 'C'], multiSelect: true });

    expect(res.status).toBe(200);
    expect(res.body.multiSelect).toBe(true);
  });

  it('duration varsa expiresAt hesaplanır', async () => {
    const before = Date.now();
    const res = await request(app)
      .post(`/api/channels/${channel._id}/polls`)
      .set('Authorization', `Bearer ${token}`)
      .send({ question: 'Süreli?', options: ['A', 'B'], duration: 60 }); // 60 dakika

    expect(res.status).toBe(200);
    expect(res.body.expiresAt).toBeGreaterThan(before + 59 * 60 * 1000);
  });
});

// ══════════════════════════════════════════════════════════════
// ANKET LİSTELEME
// ══════════════════════════════════════════════════════════════
describe('GET /api/channels/:cid/polls — anket listele', () => {
  beforeEach(async () => {
    await db.polls.insert({
      _id: 'poll1', channelId: channel._id, serverId: server._id,
      createdBy: user._id, question: 'Test?',
      options: [{ id: '0', text: 'A', votes: [] }, { id: '1', text: 'B', votes: [] }],
      multiSelect: false, expiresAt: null, closed: false, createdAt: Date.now(),
    });
  });

  it('anket listesini döner', async () => {
    const res = await request(app)
      .get(`/api/channels/${channel._id}/polls`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('üye olmayan kullanıcı listeleyemez', async () => {
    const outsider = makeUser();
    await db.users.insert(outsider);
    const outsiderToken = makeToken(outsider._id);

    const res = await request(app)
      .get(`/api/channels/${channel._id}/polls`)
      .set('Authorization', `Bearer ${outsiderToken}`);

    expect(res.status).toBe(403);
  });
});

// ══════════════════════════════════════════════════════════════
// OY VERME
// ══════════════════════════════════════════════════════════════
describe('POST /api/polls/:pid/vote — oy ver', () => {
  let poll;

  beforeEach(async () => {
    poll = {
      _id: 'poll-vote-test', channelId: channel._id, serverId: server._id,
      createdBy: user._id, question: 'Oy?',
      options: [
        { id: '0', text: 'Evet', votes: [] },
        { id: '1', text: 'Hayır', votes: [] },
      ],
      multiSelect: false, expiresAt: null, closed: false, createdAt: Date.now(),
    };
    await db.polls.insert(poll);
  });

  it('geçerli oy verir', async () => {
    const res = await request(app)
      .post(`/api/polls/${poll._id}/vote`)
      .set('Authorization', `Bearer ${token}`)
      .send({ optionIds: ['0'] });

    expect(res.status).toBe(200);
    const yesOption = res.body.options.find(o => o.id === '0');
    expect(yesOption.votes).toContain(user._id);
  });

  it('single-choice ankette birden fazla seçenek reddedilir', async () => {
    const res = await request(app)
      .post(`/api/polls/${poll._id}/vote`)
      .set('Authorization', `Bearer ${token}`)
      .send({ optionIds: ['0', '1'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/single choice/i);
  });

  it('multiSelect ankette birden fazla seçenek kabul edilir', async () => {
    await db.polls.update({ _id: poll._id }, { $set: { multiSelect: true } });

    const res = await request(app)
      .post(`/api/polls/${poll._id}/vote`)
      .set('Authorization', `Bearer ${token}`)
      .send({ optionIds: ['0', '1'] });

    expect(res.status).toBe(200);
  });

  it('kapalı ankete oy verilemez', async () => {
    await db.polls.update({ _id: poll._id }, { $set: { closed: true } });

    const res = await request(app)
      .post(`/api/polls/${poll._id}/vote`)
      .set('Authorization', `Bearer ${token}`)
      .send({ optionIds: ['0'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/closed/i);
  });

  it('süresi dolmuş ankete oy verilemez', async () => {
    await db.polls.update({ _id: poll._id }, { $set: { expiresAt: Date.now() - 1000 } });

    const res = await request(app)
      .post(`/api/polls/${poll._id}/vote`)
      .set('Authorization', `Bearer ${token}`)
      .send({ optionIds: ['0'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expired/i);
  });

  it('mevcut olmayan anket 404 döner', async () => {
    const res = await request(app)
      .post('/api/polls/nonexistent/vote')
      .set('Authorization', `Bearer ${token}`)
      .send({ optionIds: ['0'] });

    expect(res.status).toBe(404);
  });

  it('optionIds olmadan 400 döner', async () => {
    const res = await request(app)
      .post(`/api/polls/${poll._id}/vote`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it('aynı seçeneğe tekrar oy vermek oyu geri alır (toggle)', async () => {
    // İlk oy
    await request(app)
      .post(`/api/polls/${poll._id}/vote`)
      .set('Authorization', `Bearer ${token}`)
      .send({ optionIds: ['0'] });

    // Aynı seçeneğe tekrar oy — toggle bekliyoruz
    const res = await request(app)
      .post(`/api/polls/${poll._id}/vote`)
      .set('Authorization', `Bearer ${token}`)
      .send({ optionIds: ['0'] });

    expect(res.status).toBe(200);
    const yesOption = res.body.options.find(o => o.id === '0');
    // Toggle: oy kaldırılmış olmalı
    expect(yesOption.votes).not.toContain(user._id);
  });

  it('geçersiz optionId 400 döner', async () => {
    const res = await request(app)
      .post(`/api/polls/${poll._id}/vote`)
      .set('Authorization', `Bearer ${token}`)
      .send({ optionIds: ['999'] });

    expect(res.status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════
// ANKET KAPATMA
// ══════════════════════════════════════════════════════════════
describe('POST /api/polls/:pid/close — anketi kapat', () => {
  let poll;

  beforeEach(async () => {
    poll = {
      _id: 'poll-close-test', channelId: channel._id, serverId: server._id,
      createdBy: user._id, question: 'Kapat?',
      options: [{ id: '0', text: 'A', votes: [] }],
      multiSelect: false, expiresAt: null, closed: false, createdAt: Date.now(),
    };
    await db.polls.insert(poll);
  });

  it('oluşturan kullanıcı anketi kapatır', async () => {
    const res = await request(app)
      .post(`/api/polls/${poll._id}/close`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const updated = await db.polls.findOne({ _id: poll._id });
    expect(updated.closed).toBe(true);
  });

  it('başkası anketi kapatamaz', async () => {
    const res = await request(app)
      .post(`/api/polls/${poll._id}/close`)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(403);
  });

  it('mevcut olmayan anket 404 döner', async () => {
    const res = await request(app)
      .post('/api/polls/nonexistent/close')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});
