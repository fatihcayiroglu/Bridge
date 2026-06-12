// server/tests/webpush.test.ts
// Tests for /api/webpush routes (VAPID public key, subscribe, unsubscribe, test)
'use strict';

process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';

import { createMockDb, makeUser } from './helpers/mockDb';
let db = createMockDb();
jest.mock('../db/index',  () => { const { createMockDb } = require('./helpers/mockDb'); return createMockDb(); });
jest.mock('../db/loader', () => require('../db/index'));

// pushSender mock — gerçek VAPID isteği atmasın
const mockSendPushToUser = jest.fn().mockResolvedValue(undefined);
jest.mock('../lib/pushSender', () => ({
  sendPushToUser: (...a) => mockSendPushToUser(...a),
  sendWebPush:    jest.fn().mockResolvedValue(undefined),
}));

import request from 'supertest';
import express from 'express';
const jwt     = require('jsonwebtoken');
const router  = require('../routes/webpush');

function makeToken(userId) {
  return jwt.sign({ id: userId, username: 'tester', v: 0 }, 'test-jwt-secret', { expiresIn: '1h' });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/webpush', router);
  app.use((err, req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

let app, user, token;

beforeEach(async () => {
  db = createMockDb();
  Object.assign(require('../db/loader'), db);
  Object.assign(require('../db/index'), db);
  user  = makeUser({ username: 'webpushuser' });
  await db.users.insert(user);
  token = makeToken(user._id);
  app = buildApp();
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  mockSendPushToUser.mockClear();
});

// ═══════════════════════════════════════════════════════
// GET /api/webpush/vapid-public-key
// ═══════════════════════════════════════════════════════
describe('GET /api/webpush/vapid-public-key', () => {
  it('VAPID key ayarlıyken döner', async () => {
    process.env.VAPID_PUBLIC_KEY = 'BTestPublicKeyABC123';
    const res = await request(app).get('/api/webpush/vapid-public-key');
    expect(res.status).toBe(200);
    expect(res.body.publicKey).toBe('BTestPublicKeyABC123');
  });

  it('VAPID key yokken 503 döner', async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    const res = await request(app).get('/api/webpush/vapid-public-key');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not configured/i);
  });

  it('auth token olmadan da çalışır (public endpoint)', async () => {
    process.env.VAPID_PUBLIC_KEY = 'BPublicKey';
    const res = await request(app).get('/api/webpush/vapid-public-key');
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/webpush/subscribe
// ═══════════════════════════════════════════════════════
describe('POST /api/webpush/subscribe', () => {
  const validSub = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/test123',
    keys: { p256dh: 'BNcRdreALRFXTkOOUHK', auth: 'tBHItJI5svbpez7KI' },
  };

  it('geçerli abonelik kaydeder', async () => {
    const res = await request(app)
      .post('/api/webpush/subscribe')
      .set('Authorization', `Bearer ${token}`)
      .send(validSub);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('aynı endpoint tekrar gönderilince günceller', async () => {
    await request(app)
      .post('/api/webpush/subscribe')
      .set('Authorization', `Bearer ${token}`)
      .send(validSub);

    const res = await request(app)
      .post('/api/webpush/subscribe')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validSub, keys: { p256dh: 'NEW_KEY', auth: 'NEW_AUTH' } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('endpoint eksikse 400 döner', async () => {
    const res = await request(app)
      .post('/api/webpush/subscribe')
      .set('Authorization', `Bearer ${token}`)
      .send({ keys: validSub.keys });
    expect(res.status).toBe(400);
  });

  it('keys.p256dh eksikse 400 döner', async () => {
    const res = await request(app)
      .post('/api/webpush/subscribe')
      .set('Authorization', `Bearer ${token}`)
      .send({ endpoint: validSub.endpoint, keys: { auth: 'only' } });
    expect(res.status).toBe(400);
  });

  it('keys.auth eksikse 400 döner', async () => {
    const res = await request(app)
      .post('/api/webpush/subscribe')
      .set('Authorization', `Bearer ${token}`)
      .send({ endpoint: validSub.endpoint, keys: { p256dh: 'only' } });
    expect(res.status).toBe(400);
  });

  it('token olmadan 401 döner', async () => {
    const res = await request(app)
      .post('/api/webpush/subscribe')
      .send(validSub);
    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════
// DELETE /api/webpush/unsubscribe
// ═══════════════════════════════════════════════════════
describe('DELETE /api/webpush/unsubscribe', () => {
  it('mevcut aboneliği siler', async () => {
    const endpoint = 'https://fcm.googleapis.com/delete-me';
    await db.pushSubscriptions?.insert({
      _id: 'sub1', userId: user._id, endpoint,
      keys: { p256dh: 'x', auth: 'y' }, createdAt: Date.now(),
    }).catch(() => {});

    const res = await request(app)
      .delete('/api/webpush/unsubscribe')
      .set('Authorization', `Bearer ${token}`)
      .send({ endpoint });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('endpoint yokken bile 200 döner (idempotent)', async () => {
    const res = await request(app)
      .delete('/api/webpush/unsubscribe')
      .set('Authorization', `Bearer ${token}`)
      .send({ endpoint: 'https://nonexistent.example.com/push' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('token olmadan 401 döner', async () => {
    const res = await request(app)
      .delete('/api/webpush/unsubscribe')
      .send({ endpoint: 'https://example.com' });
    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/webpush/test
// ═══════════════════════════════════════════════════════
describe('POST /api/webpush/test', () => {
  const sub = {
    _id: 'testsub1', endpoint: 'https://push.example.com/test',
    keys: { p256dh: 'BKey', auth: 'AAuth' }, createdAt: Date.now(),
  };

  beforeEach(async () => {
    process.env.VAPID_PUBLIC_KEY  = 'BPublicKey';
    process.env.VAPID_PRIVATE_KEY = 'private-key-value';
  });

  it('abonelik varsa test bildirimi gönderir', async () => {
    await db.pushSubscriptions?.insert({ ...sub, userId: user._id }).catch(() => {});

    const res = await request(app)
      .post('/api/webpush/test')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sent).toBeGreaterThan(0);
    expect(mockSendPushToUser).toHaveBeenCalledWith(
      user._id,
      expect.objectContaining({ title: expect.any(String), body: expect.any(String) })
    );
  });

  it('özel mesaj gövdesiyle bildirim gönderir', async () => {
    await db.pushSubscriptions?.insert({ ...sub, _id: 'sub2', userId: user._id }).catch(() => {});

    const res = await request(app)
      .post('/api/webpush/test')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Özel test mesajı' });
    expect(res.status).toBe(200);
    expect(mockSendPushToUser).toHaveBeenCalledWith(
      user._id,
      expect.objectContaining({ body: 'Özel test mesajı' })
    );
  });

  it('abonelik yoksa 404 döner', async () => {
    // pushSubscriptions boş — insert yok
    const res = await request(app)
      .post('/api/webpush/test')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no push subscription/i);
  });

  it('VAPID yapılandırılmamışsa 503 döner', async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;

    const res = await request(app)
      .post('/api/webpush/test')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(503);
    expect(mockSendPushToUser).not.toHaveBeenCalled();
  });

  it('token olmadan 401 döner', async () => {
    const res = await request(app)
      .post('/api/webpush/test')
      .send({});
    expect(res.status).toBe(401);
  });
});
