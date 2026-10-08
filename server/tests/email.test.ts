// server/tests/email.test.ts
process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../lib/mailer', () => ({
  sendVerificationEmail: jest.fn().mockResolvedValue(true),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(true),
}));
jest.mock('../lib/sessionRevocation', () => ({ disconnectLiveUserSessions: jest.fn().mockResolvedValue(0) }));

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
const db      = require('../db/loader');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
import { authMiddleware } from '../middleware/auth';
import emailRouter from '../routes/email';
import { stepUpHeader } from './helpers/stepUp';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/email', authMiddleware, emailRouter);
  return app;
}
function tok(uid: string, v = 0) { return jwt.sign({ id: uid, v }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

describe('Email Routes', () => {
  let app: express.Express;
  let userId: string;
  let otherUserId: string;
  let userToken: string;

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
        .set(stepUpHeader(userId, 'account-security'))
        .send({ email: 'alice@example.com' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      const user = await db.users.findOne({ _id: userId });
      expect(user.email).toBe('alice@example.com');
      expect(user.emailToken).toMatch(/^v\.[0-9a-f]{64}$/);
      // Sema BOOLEAN; `pg` gercek boolean dondurur (1/0 OKUNAMAZ).
      expect(user.emailVerified).toBe(false);
    });

    it('returns 400 for invalid email format', async () => {
      const res = await request(app)
        .post('/api/email/add')
        .set('Authorization', `Bearer ${userToken}`)
        .set(stepUpHeader(userId, 'account-security'))
        .send({ email: 'not-an-email' });
      expect(res.status).toBe(400);
    });

    it('returns 400 if email belongs to another account', async () => {
      const res = await request(app)
        .post('/api/email/add')
        .set('Authorization', `Bearer ${userToken}`)
        .set(stepUpHeader(userId, 'account-security'))
        .send({ email: 'bob@example.com' });
      expect(res.status).toBe(400);
    });

    it('rejects unauthenticated', async () => {
      const res = await request(app)
        .post('/api/email/add')
        .send({ email: 'x@x.com' });
      expect(res.status).toBe(401);
    });

    it('P7 B2: a session alone cannot change the recovery address (account-security step-up)', async () => {
      const res = await request(app)
        .post('/api/email/add')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ email: 'attacker@example.com' });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'STEP_UP_REQUIRED', action: 'email.change', scope: 'account-security', reasons: ['step_up_missing'] });
      expect((await db.users.findOne({ _id: userId })).email).toBeNull();
    });
  });

  describe('GET /api/email/verify', () => {
    it('verifies a valid token', async () => {
      const token = 'v.validtoken123';
      await db.users.update({ _id: userId }, {
        $set: { emailToken: token, emailTokenExp: Date.now() + 3600000, email: 'alice@example.com' }
      });
      const res = await request(app)
        .get(`/api/email/verify?token=${token}`)
        .set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/?email=verified');
      expect((await db.users.findOne({ _id: userId })).emailToken).toBeNull();
    });

    it('accepts PostgreSQL BIGINT string expiries', async () => {
      const token = 'v.validtoken-string-expiry';
      await db.users.update({ _id: userId }, {
        $set: { emailToken: token, emailTokenExp: String(Date.now() + 3600000), email: 'alice@example.com' }
      });
      const res = await request(app)
        .get(`/api/email/verify?token=${token}`)
        .set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(302);
    });

    it('rejects exact-expiry and malformed persisted expiry fail-closed', async () => {
      const now = Date.now();
      const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
      try {
        await db.users.update({ _id: userId }, { $set: { emailToken: 'v.exact-expiry', emailTokenExp: String(now) } });
        const exact = await request(app)
          .get('/api/email/verify?token=v.exact-expiry')
          .set('Authorization', `Bearer ${userToken}`);
        expect(exact.status).toBe(400);

        await db.users.update({ _id: userId }, { $set: { emailToken: 'v.bad-expiry', emailTokenExp: '123oops' } });
        const malformed = await request(app)
          .get('/api/email/verify?token=v.bad-expiry')
          .set('Authorization', `Bearer ${userToken}`);
        expect(malformed.status).toBe(400);
      } finally {
        spy.mockRestore();
      }
    });

    it('rejects array/object query tokens instead of coercing them', async () => {
      const res = await request(app)
        .get('/api/email/verify?token=a&token=b')
        .set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(400);
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

  describe('POST /api/email/forgot', () => {
    it('sends reset email for existing user', async () => {
      await db.users.update({ _id: userId }, { $set: { email: 'alice@example.com', emailVerified: 1 } });
      const res = await request(app)
        .post('/api/email/forgot')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ email: '  ALICE@example.com  ' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      const user = await db.users.findOne({ _id: userId });
      expect(user.emailToken).toMatch(/^r\.[0-9a-f]{64}$/);
    });

    // Final21 UX: a reset link must never reach an address the owner has not proven.
    it('does not issue a reset for an UNVERIFIED address, with the same outward response', async () => {
      const mailer = require('../lib/mailer');
      mailer.sendPasswordResetEmail.mockClear();
      await db.users.update({ _id: userId }, { $set: { email: 'alice@example.com', emailVerified: 0, emailToken: null } });
      const res = await request(app).post('/api/email/forgot').set('Authorization', `Bearer ${userToken}`).send({ email: 'alice@example.com' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, message: 'If the address exists, a reset email has been sent' });
      expect((await db.users.findOne({ _id: userId })).emailToken).toBeNull();
      expect(mailer.sendPasswordResetEmail).not.toHaveBeenCalled();
    });

    it.each([undefined, null, 123, {}, [], 'not-an-email'])('keeps the anti-enumeration contract for malformed email %p', async (email) => {
      const res = await request(app)
        .post('/api/email/forgot')
        .set('Authorization', `Bearer ${userToken}`)
        .send(email === undefined ? {} : { email });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });


  describe('POST /api/email/reset-password', () => {
    // Final21 UX: the single emailToken column used to serve verification AND reset.
    it('rejects a VERIFICATION token (the link sent to a newly added address) as a reset key', async () => {
      await db.users.update({ _id: userId }, { $set: { email: 'alice@example.com', emailVerified: 1, emailToken: 'v.verify-token', emailTokenExp: String(Date.now() + 60_000) } });
      const res = await request(app).post('/api/email/reset-password').set('Authorization', `Bearer ${userToken}`).send({ token: 'v.verify-token', newPassword: 'taken-over-123' });
      expect(res.status).toBe(400);
      expect(await bcrypt.compare('password123', (await db.users.findOne({ _id: userId })).password)).toBe(true);
    });

    it('rejects a legacy unprefixed token', async () => {
      await db.users.update({ _id: userId }, { $set: { email: 'alice@example.com', emailVerified: 1, emailToken: 'legacy-token', emailTokenExp: String(Date.now() + 60_000) } });
      const res = await request(app).post('/api/email/reset-password').set('Authorization', `Bearer ${userToken}`).send({ token: 'legacy-token', newPassword: 'new-password-123' });
      expect(res.status).toBe(400);
    });

    it('rejects a reset-purpose token on an account whose address is not verified', async () => {
      await db.users.update({ _id: userId }, { $set: { email: 'alice@example.com', emailVerified: 0, emailToken: 'r.unverified', emailTokenExp: String(Date.now() + 60_000) } });
      const res = await request(app).post('/api/email/reset-password').set('Authorization', `Bearer ${userToken}`).send({ token: 'r.unverified', newPassword: 'new-password-123' });
      expect(res.status).toBe(400);
    });

    it('a RESET token cannot be spent on the verification endpoint', async () => {
      await db.users.update({ _id: userId }, { $set: { email: 'alice@example.com', emailVerified: 0, emailToken: 'r.reset-as-verify', emailTokenExp: String(Date.now() + 60_000) } });
      const res = await request(app).get('/api/email/verify?token=r.reset-as-verify').set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(400);
      expect((await db.users.findOne({ _id: userId })).emailVerified).toBeFalsy();
    });

    it('revokes every existing refresh session after a successful password reset', async () => {
      const resetToken = 'r.reset-token-1';
      await db.users.update({ _id: userId }, { $set: { email: 'alice@example.com', emailVerified: 1, emailToken: resetToken, emailTokenExp: String(Date.now() + 60_000) } });
      await db.refreshTokens.insert({ token: 'old-refresh-1', userId, expiresAt: Date.now() + 60_000, createdAt: Date.now(), used: false, tokenVersion: 0 });
      await db.refreshTokens.insert({ token: 'old-refresh-2', userId, expiresAt: Date.now() + 60_000, createdAt: Date.now(), used: false, tokenVersion: 0 });

      const res = await request(app)
        .post('/api/email/reset-password')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ token: resetToken, newPassword: 'new-password-123' });

      expect(res.status).toBe(200);
      expect(await db.refreshTokens.find({ userId })).toHaveLength(0);
      const updated = await db.users.findOne({ _id: userId });
      expect(updated.tokenVersion).toBe(1);
      expect(updated.emailToken).toBeNull();
    });


    it.each([123, {}, [], null])('rejects non-string newPassword %p with 400', async (newPassword) => {
      const resetToken = `r.reset-token-${String(newPassword)}`;
      await db.users.update({ _id: userId }, { $set: { email: 'alice@example.com', emailVerified: 1, emailToken: resetToken, emailTokenExp: String(Date.now() + 60_000) } });
      const res = await request(app)
        .post('/api/email/reset-password')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ token: resetToken, newPassword });
      expect(res.status).toBe(400);
    });

    it('rejects overlong passwords before bcrypt', async () => {
      const resetToken = 'r.reset-token-overlong';
      await db.users.update({ _id: userId }, { $set: { email: 'alice@example.com', emailVerified: 1, emailToken: resetToken, emailTokenExp: String(Date.now() + 60_000) } });
      const res = await request(app)
        .post('/api/email/reset-password')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ token: resetToken, newPassword: 'x'.repeat(129) });
      expect(res.status).toBe(400);
    });

    it('rejects exact-expiry and malformed persisted reset expiry', async () => {
      const now = Date.now();
      const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
      try {
        await db.users.update({ _id: userId }, { $set: { email: 'alice@example.com', emailVerified: 1, emailToken: 'r.reset-exact', emailTokenExp: String(now) } });
        const exact = await request(app)
          .post('/api/email/reset-password')
          .set('Authorization', `Bearer ${userToken}`)
          .send({ token: 'r.reset-exact', newPassword: 'new-password-123' });
        expect(exact.status).toBe(400);

        await db.users.update({ _id: userId }, { $set: { email: 'alice@example.com', emailVerified: 1, emailToken: 'r.reset-bad', emailTokenExp: '-1' } });
        const malformed = await request(app)
          .post('/api/email/reset-password')
          .set('Authorization', `Bearer ${userToken}`)
          .send({ token: 'r.reset-bad', newPassword: 'new-password-123' });
        expect(malformed.status).toBe(400);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
