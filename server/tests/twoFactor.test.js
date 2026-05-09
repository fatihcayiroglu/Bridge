// server/tests/twoFactor.test.js
process.env.JWT_SECRET     = 'test-jwt-secret';
process.env.REFRESH_SECRET = 'test-refresh-secret';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

const request  = require('supertest');
const express  = require('express');
const { v4: uuidv4 } = require('uuid');
const db       = require('../db/loader');
const jwt      = require('jsonwebtoken');
const { authMiddleware } = require('../middleware/auth');
const twoFactorRouter = require('../routes/twoFactor');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/2fa', authMiddleware, twoFactorRouter);
  return app;
}
function tok(uid) { return jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

describe('Two Factor Auth Routes', () => {
  let app, userId, token;

  beforeEach(async () => {
    db._reset?.();
    app    = buildApp();
    userId = uuidv4();
    token  = tok(userId);
    await db.users.insert({ _id: userId, username: 'u', displayName: 'U', tokenVersion: 0, twoFactorEnabled: false });
  });

  describe('POST /api/2fa/setup', () => {
    it('returns secret and QR code for authenticated user', async () => {
      const res = await request(app)
        .post('/api/2fa/setup')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('secret');
      expect(res.body).toHaveProperty('qrCode');
    });
  });

  describe('POST /api/2fa/verify', () => {
    it('returns 400 without token', async () => {
      const res = await request(app)
        .post('/api/2fa/verify')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it('returns 400 with invalid TOTP token', async () => {
      // Setup first
      await request(app).post('/api/2fa/setup').set('Authorization', `Bearer ${token}`);
      const res = await request(app)
        .post('/api/2fa/verify')
        .set('Authorization', `Bearer ${token}`)
        .send({ token: '000000' }); // wrong code
      expect([400, 401]).toContain(res.status);
    });
  });

  describe('POST /api/2fa/disable', () => {
    it('returns 400 without password', async () => {
      const res = await request(app)
        .post('/api/2fa/disable')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it('returns 400 when 2FA not enabled', async () => {
      const bcrypt = require('bcryptjs');
      const hashed = await bcrypt.hash('correctpass', 10);
      await db.users.update({ _id: userId }, { $set: { password: hashed, twoFactorEnabled: false } });

      const res = await request(app)
        .post('/api/2fa/disable')
        .set('Authorization', `Bearer ${token}`)
        .send({ password: 'correctpass' });
      expect([400, 409]).toContain(res.status);
    });
  });

  describe('GET /api/2fa/backup-codes', () => {
    it('returns 404 or empty when no backup codes set', async () => {
      const res = await request(app)
        .get('/api/2fa/backup-codes')
        .set('Authorization', `Bearer ${token}`);
      expect([200, 404]).toContain(res.status);
    });
  });

  it('rejects unauthenticated', async () => {
    const res = await request(app).post('/api/2fa/setup').send({});
    expect(res.status).toBe(401);
  });
});
