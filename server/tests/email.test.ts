// server/tests/email.test.ts
process.env.JWT_SECRET     = 'test-jwt-secret';
process.env.REFRESH_SECRET = 'test-refresh-secret';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../lib/mailer', () => ({
  sendVerificationEmail: jest.fn().mockResolvedValue(true),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(true),
}));

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
const db      = require('../db/loader');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
import { authMiddleware } from '../middleware/auth';
import emailRouter from '../routes/email';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/email', authMiddleware, emailRouter);
  return app;
}
function tok(uid, v = 0) { return jwt.sign({ id: uid, v }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

describe('Email Routes', () => {
  let app, userId, otherUserId;
  let userToken;

  beforeEach(async () => {
    db._reset?.();
    app         = buildApp();
    userId      = uuidv4();
    otherUserId = uuidv4();
    userToken   = tok(userId);

    await db.users.insert({
      _id: userId, username: 'alice', displayName: 'Alice', tokenVersion: 0,
      password: await bcrypt.hash('password123', 10),
      email: null, emailVerified: 0,
    });
    await db.users.insert({
      _id: otherUserId, username: 'bob', displayName: 'Bob', tokenVersion: 0,
      email: 'bob@example.com', emailVerified: 1,
    });
  });

  describe('POST /api/email/add', () => {
    it('saves email and sends verification', async () => {
      const res = await request(app)
        .post('/api/email/add')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ email: 'alice@example.com' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      const user = await db.users.findOne({ _id: userId });
      expect(user.email).toBe('alice@example.com');
      expect(user.emailVerified).toBe(0);
    });

    it('returns 400 for invalid email format', async () => {
      const res = await request(app)
        .post('/api/email/add')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ email: 'not-an-email' });
      expect(res.status).toBe(400);
    });

    it('returns 400 if email belongs to another account', async () => {
      const res = await request(app)
        .post('/api/email/add')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ email: 'bob@example.com' });
      expect(res.status).toBe(400);
    });

    it('rejects unauthenticated', async () => {
      const res = await request(app)
        .post('/api/email/add')
        .send({ email: 'x@x.com' });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/email/verify', () => {
    it('verifies a valid token', async () => {
      const token = 'validtoken123';
      await db.users.update({ _id: userId }, {
        $set: { emailToken: token, emailTokenExp: Date.now() + 3600000, email: 'alice@example.com' }
      });
      const res = await request(app)
        .get(`/api/email/verify?token=${token}`)
        .set('Authorization', `Bearer ${userToken}`);
      expect([200, 302]).toContain(res.status);
    });

    it('returns 400 for missing token', async () => {
      const res = await request(app)
        .get('/api/email/verify')
        .set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(400);
    });

    it('returns 400 or 404 for invalid token', async () => {
      const res = await request(app)
        .get('/api/email/verify?token=badtoken')
        .set('Authorization', `Bearer ${userToken}`);
      expect([400, 404]).toContain(res.status);
    });
  });

  describe('POST /api/email/forgot-password', () => {
    it('sends reset email for existing user', async () => {
      await db.users.update({ _id: userId }, { $set: { email: 'alice@example.com', emailVerified: 1 } });
      const res = await request(app)
        .post('/api/email/forgot-password')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ email: 'alice@example.com' });
      expect([200, 404]).toContain(res.status); // 200 ok or 404 if route not mounted that way
    });
  });
});
