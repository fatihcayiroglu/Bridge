// server/tests/users.test.js
process.env.JWT_SECRET     = 'test-jwt-secret';
process.env.REFRESH_SECRET = 'test-refresh-secret';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

const request = require('supertest');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db      = require('../db/loader');
const jwt     = require('jsonwebtoken');
const { authMiddleware } = require('../middleware/auth');
const usersRouter = require('../routes/users');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/users', authMiddleware, usersRouter);
  return app;
}
function tok(uid, v = 0) { return jwt.sign({ id: uid, v }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

describe('Users Routes', () => {
  let app, userId, otherId, serverId;
  let userToken, otherToken;

  beforeEach(async () => {
    db._reset?.();
    app      = buildApp();
    userId   = uuidv4();
    otherId  = uuidv4();
    serverId = uuidv4();
    userToken  = tok(userId);
    otherToken = tok(otherId);

    await db.users.insert({ _id: userId, username: 'alice', displayName: 'Alice', tokenVersion: 0, status: 'online', statusText: 'coding', statusEmoji: '💻', createdAt: Date.now() });
    await db.users.insert({ _id: otherId, username: 'bob',   displayName: 'Bob',   tokenVersion: 0, status: 'offline', createdAt: Date.now() });
    await db.servers.insert({ _id: serverId, name: 'Common Server', ownerId: userId });
    await db.members.insert({ userId, serverId, roles: [] });
    await db.members.insert({ userId: otherId, serverId, roles: [] });
  });

  describe('GET /api/users/:userId — public profile', () => {
    it('returns public profile for existing user', async () => {
      const res = await request(app)
        .get(`/api/users/${otherId}`)
        .set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(200);
      expect(res.body.username).toBe('bob');
      expect(res.body._id).toBe(otherId);
      expect(res.body.password).toBeUndefined();
    });

    it('returns statusText and statusEmoji', async () => {
      const res = await request(app)
        .get(`/api/users/${userId}`)
        .set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(200);
      expect(res.body.statusText).toBe('coding');
      expect(res.body.statusEmoji).toBe('💻');
    });

    it('returns 404 for nonexistent user', async () => {
      const res = await request(app)
        .get(`/api/users/${uuidv4()}`)
        .set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(404);
    });

    it('rejects unauthenticated', async () => {
      const res = await request(app).get(`/api/users/${userId}`);
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/users/:userId/mutual-servers', () => {
    it('returns mutual servers for two members', async () => {
      const res = await request(app)
        .get(`/api/users/${otherId}/mutual-servers`)
        .set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const ids = res.body.map(s => s._id);
      expect(ids).toContain(serverId);
    });

    it('returns empty array when no mutual servers', async () => {
      const strangeId = uuidv4();
      await db.users.insert({ _id: strangeId, username: 'stranger', displayName: 'S', tokenVersion: 0 });
      const strangeToken = tok(strangeId);
      const res = await request(app)
        .get(`/api/users/${otherId}/mutual-servers`)
        .set('Authorization', `Bearer ${strangeToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });
});
