// server/tests/onboarding.test.js
process.env.JWT_SECRET     = 'test-jwt-secret';
process.env.REFRESH_SECRET = 'test-refresh-secret';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../lib/permissions', () => ({
  resolvePermissions: jest.fn(),
  hasPermission:      jest.fn(),
  PERMS: { MANAGE_SERVER: 8, ADMINISTRATOR: 1 << 30 },
}));

const request = require('supertest');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db      = require('../db/loader');
const jwt     = require('jsonwebtoken');
const { authMiddleware } = require('../middleware/auth');
const onboardingRouter = require('../routes/onboarding');
const perms   = require('../lib/permissions');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers', authMiddleware, onboardingRouter);
  return app;
}
function tok(uid, v = 0) { return jwt.sign({ id: uid, v }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

describe('Onboarding Routes', () => {
  let app, ownerId, memberId, serverId;
  let ownerToken, memberToken;

  beforeEach(async () => {
    db._reset?.();
    app      = buildApp();
    ownerId  = uuidv4();
    memberId = uuidv4();
    serverId = uuidv4();
    ownerToken  = tok(ownerId);
    memberToken = tok(memberId);

    await db.users.insert({ _id: ownerId,  username: 'owner',  displayName: 'Owner',  tokenVersion: 0 });
    await db.users.insert({ _id: memberId, username: 'member', displayName: 'Member', tokenVersion: 0 });
    await db.servers.insert({ _id: serverId, name: 'TestServer', ownerId });
    await db.members.insert({ userId: ownerId,  serverId, roles: [] });
    await db.members.insert({ userId: memberId, serverId, roles: [] });
    await db.channels.insert({ _id: uuidv4(), serverId, name: 'rules', type: 'text' });

    perms.resolvePermissions.mockResolvedValue(8);
    perms.hasPermission.mockReturnValue(true);
  });

  describe('GET /api/servers/:sid/onboarding', () => {
    it('returns default onboarding config for member', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/onboarding`)
        .set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('enabled');
      expect(res.body).toHaveProperty('channels');
    });

    it('returns saved onboarding config', async () => {
      await db.serverOnboarding.insert({ _id: uuidv4(), serverId, enabled: true, welcomeMessage: 'Hey {user}!', defaultRoles: '[]', questions: '[]' });
      const res = await request(app)
        .get(`/api/servers/${serverId}/onboarding`)
        .set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(true);
      expect(res.body.welcomeMessage).toBe('Hey {user}!');
    });

    it('returns 403 for non-member', async () => {
      const strangeId = uuidv4();
      await db.users.insert({ _id: strangeId, username: 'x', displayName: 'X', tokenVersion: 0 });
      const res = await request(app)
        .get(`/api/servers/${serverId}/onboarding`)
        .set('Authorization', `Bearer ${tok(strangeId)}`);
      expect(res.status).toBe(403);
    });

    it('rejects unauthenticated', async () => {
      const res = await request(app).get(`/api/servers/${serverId}/onboarding`);
      expect(res.status).toBe(401);
    });
  });

  describe('PUT /api/servers/:sid/onboarding', () => {
    it('saves onboarding config for admin', async () => {
      const res = await request(app)
        .put(`/api/servers/${serverId}/onboarding`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ enabled: true, welcomeMessage: 'Welcome {user}!', defaultRoles: [], questions: [] });
      expect([200, 201]).toContain(res.status);
      expect(res.body.ok || res.body.enabled !== undefined).toBeTruthy();
    });

    it('returns 403 without MANAGE_SERVER', async () => {
      perms.hasPermission.mockReturnValue(false);
      const res = await request(app)
        .put(`/api/servers/${serverId}/onboarding`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ enabled: false });
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/servers/:sid/onboarding/status', () => {
    it('returns completion status for member', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/onboarding/status`)
        .set('Authorization', `Bearer ${memberToken}`);
      expect([200, 404]).toContain(res.status);
    });
  });

  describe('POST /api/servers/:sid/onboarding/complete', () => {
    it('marks onboarding as complete for member', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/onboarding/complete`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ answers: [] });
      expect([200, 201]).toContain(res.status);
    });

    it('returns 403 for non-member', async () => {
      const strangeId = uuidv4();
      await db.users.insert({ _id: strangeId, username: 'x2', displayName: 'X2', tokenVersion: 0 });
      const res = await request(app)
        .post(`/api/servers/${serverId}/onboarding/complete`)
        .set('Authorization', `Bearer ${tok(strangeId)}`)
        .send({ answers: [] });
      expect(res.status).toBe(403);
    });
  });
});
