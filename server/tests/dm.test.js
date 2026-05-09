// server/tests/dm.test.js
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.NODE_ENV   = 'test';

const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { createMockDb, makeUser } = require('./helpers/mockDb');

let db;
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/index', () => {
  const { createMockDb } = require('./helpers/mockDb');
  db = createMockDb();
  return db;
});

const { router: dmRouter } = require('../routes/dm');

function makeToken(userId) {
  return jwt.sign({ id: userId, username: 'tester', v: 0 }, 'test-jwt-secret', { expiresIn: '1h' });
}

let app, userA, userB, tokenA, tokenB;

beforeEach(async () => {
  const { createMockDb, makeUser } = require('./helpers/mockDb');
  db = createMockDb();
  Object.assign(require('../db/loader'), db);
  Object.assign(require('../db/index'), db);

  userA = makeUser({ username: 'alice' });
  userB = makeUser({ username: 'bob' });
  await db.users.insert(userA);
  await db.users.insert(userB);

  tokenA = makeToken(userA._id);
  tokenB = makeToken(userB._id);

  app = express();
  app.use(express.json());
  app.use('/api/dm', dmRouter);
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
});

describe('POST /api/dm/:userId — konuşma başlat', () => {
  it('yeni DM konuşması oluşturur', async () => {
    const res = await request(app)
      .post(`/api/dm/${userB._id}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.participants).toContain(userA._id);
    expect(res.body.participants).toContain(userB._id);
    expect(res.body.other._id).toBe(userB._id);
    expect(res.body.other.password).toBeUndefined();
  });

  it('aynı çift için mevcut konuşmayı döner', async () => {
    const res1 = await request(app)
      .post(`/api/dm/${userB._id}`)
      .set('Authorization', `Bearer ${tokenA}`);

    const res2 = await request(app)
      .post(`/api/dm/${userB._id}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res1.body._id).toBe(res2.body._id);
  });

  it('kendine DM 400 döner', async () => {
    const res = await request(app)
      .post(`/api/dm/${userA._id}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/yourself/i);
  });

  it('mevcut olmayan kullanıcıya DM 404 döner', async () => {
    const res = await request(app)
      .post('/api/dm/nonexistent')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(404);
  });

  it('DM ID simetrik oluşturulur (A→B === B→A)', async () => {
    const resAB = await request(app)
      .post(`/api/dm/${userB._id}`)
      .set('Authorization', `Bearer ${tokenA}`);

    const resBA = await request(app)
      .post(`/api/dm/${userA._id}`)
      .set('Authorization', `Bearer ${tokenB}`);

    expect(resAB.body._id).toBe(resBA.body._id);
  });
});

describe('GET /api/dm — konuşma listesi', () => {
  it('boş liste döner', async () => {
    const res = await request(app)
      .get('/api/dm')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(0);
  });

  it('konuşma oluşturduktan sonra listede görünür', async () => {
    await request(app)
      .post(`/api/dm/${userB._id}`)
      .set('Authorization', `Bearer ${tokenA}`);

    const res = await request(app)
      .get('/api/dm')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].other._id).toBe(userB._id);
  });
});

describe('GET /api/dm/:dmId/messages — mesajlar', () => {
  let dmId;

  beforeEach(async () => {
    const createRes = await request(app)
      .post(`/api/dm/${userB._id}`)
      .set('Authorization', `Bearer ${tokenA}`);
    dmId = createRes.body._id;

    // Birkaç mesaj ekle
    for (let i = 0; i < 3; i++) {
      await db.dmMessages.insert({
        _id: `dm-msg-${i}`, dmId,
        userId: userA._id, displayName: userA.displayName,
        avatarColor: '#5865f2', content: `Mesaj ${i}`,
        createdAt: Date.now() + i,
      });
    }
  });

  it('mesajları döner', async () => {
    const res = await request(app)
      .get(`/api/dm/${dmId}/messages`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(3);
  });

  it('konuşmada olmayan kullanıcı 403 alır', async () => {
    const userC = makeUser();
    await db.users.insert(userC);
    const tokenC = makeToken(userC._id);

    const res = await request(app)
      .get(`/api/dm/${dmId}/messages`)
      .set('Authorization', `Bearer ${tokenC}`);

    expect(res.status).toBe(403);
  });

  it('mevcut olmayan konuşma 404 döner', async () => {
    const res = await request(app)
      .get('/api/dm/nonexistent/messages')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(404);
  });

  it('limit parametresi çalışır', async () => {
    const res = await request(app)
      .get(`/api/dm/${dmId}/messages?limit=2`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(2);
  });
});
