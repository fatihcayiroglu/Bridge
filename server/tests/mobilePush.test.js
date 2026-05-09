// server/tests/mobilePush.test.js
'use strict';

process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';

const { createMockDb, makeUser } = require('./helpers/mockDb');
let db = createMockDb();
jest.mock('../db/index', () => { const { createMockDb } = require('./helpers/mockDb'); return createMockDb(); });
jest.mock('../db/loader', () => require('../db/index'));

const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const router  = require('../routes/mobilePush');

function token(userId) {
  return jwt.sign({ id: userId, username: 'user', v: 0 }, 'test-jwt-secret', { expiresIn: '1h' });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/mobile', router);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

let app, user;

beforeEach(async () => {
  db = createMockDb();
  Object.assign(require('../db/loader'), db);
  Object.assign(require('../db/index'), db);
  user = makeUser({ username: 'mobileuser' });
  await db.users.insert(user);
  app = buildApp();
});

// ═══════════════════════════════════════════════════════
// GET /api/mobile/info
// ═══════════════════════════════════════════════════════
describe('GET /api/mobile/info', () => {
  it('sunucu bilgilerini döner (auth gerektirmez)', async () => {
    const res = await request(app).get('/api/mobile/info');
    expect(res.status).toBe(200);
    expect(res.body.serverVersion).toBeDefined();
    expect(res.body.minAppVersion).toBeDefined();
    expect(res.body.features).toBeDefined();
    expect(typeof res.body.features.e2ee).toBe('boolean');
    expect(typeof res.body.features.federation).toBe('boolean');
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/mobile/push/register
// ═══════════════════════════════════════════════════════
describe('POST /api/mobile/push/register', () => {
  it('iOS token kaydeder', async () => {
    const res = await request(app)
      .post('/api/mobile/push/register')
      .set('Authorization', `Bearer ${token(user._id)}`)
      .send({ token: 'ios-device-token-abc123', platform: 'ios' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('Android token kaydeder', async () => {
    const res = await request(app)
      .post('/api/mobile/push/register')
      .set('Authorization', `Bearer ${token(user._id)}`)
      .send({ token: 'fcm-token-xyz789', platform: 'android' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('mevcut token\'ı günceller (upsert)', async () => {
    const userId = user._id;
    await db.nativePushTokens?.insert({
      _id: `npt_${userId}_ios`, userId, platform: 'ios',
      token: 'old-token', createdAt: Date.now(), updatedAt: Date.now(),
    });

    const res = await request(app)
      .post('/api/mobile/push/register')
      .set('Authorization', `Bearer ${token(userId)}`)
      .send({ token: 'new-ios-token', platform: 'ios' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('token eksikse 400 döner', async () => {
    const res = await request(app)
      .post('/api/mobile/push/register')
      .set('Authorization', `Bearer ${token(user._id)}`)
      .send({ platform: 'ios' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/token/i);
  });

  it('geçersiz platform 400 döner', async () => {
    const res = await request(app)
      .post('/api/mobile/push/register')
      .set('Authorization', `Bearer ${token(user._id)}`)
      .send({ token: 'abc', platform: 'windows' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/platform/i);
  });

  it('token olmadan 401 döner', async () => {
    const res = await request(app)
      .post('/api/mobile/push/register')
      .send({ token: 'abc', platform: 'ios' });
    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════
// DELETE /api/mobile/push/unregister
// ═══════════════════════════════════════════════════════
describe('DELETE /api/mobile/push/unregister', () => {
  it('kaydı siler', async () => {
    await db.nativePushTokens?.insert({
      _id: `npt_${user._id}_android`, userId: user._id, platform: 'android',
      token: 'fcm-token', createdAt: Date.now(), updatedAt: Date.now(),
    });

    const res = await request(app)
      .delete('/api/mobile/push/unregister')
      .set('Authorization', `Bearer ${token(user._id)}`)
      .send({ platform: 'android' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('token olmadan 401 döner', async () => {
    const res = await request(app)
      .delete('/api/mobile/push/unregister')
      .send({ platform: 'android' });
    expect(res.status).toBe(401);
  });
});
