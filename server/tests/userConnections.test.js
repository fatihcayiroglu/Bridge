// server/tests/userConnections.test.js
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
const connRouter = require('../routes/userConnections');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', authMiddleware, connRouter);
  return app;
}
function tok(uid, v = 0) { return jwt.sign({ id: uid, v }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

describe('UserConnections Routes', () => {
  let app, userId, otherId;
  let userToken, otherToken;

  beforeEach(async () => {
    db._reset?.();
    app       = buildApp();
    userId    = uuidv4();
    otherId   = uuidv4();
    userToken  = tok(userId);
    otherToken = tok(otherId);
    await db.users.insert({ _id: userId,  username: 'alice', displayName: 'Alice', tokenVersion: 0 });
    await db.users.insert({ _id: otherId, username: 'bob',   displayName: 'Bob',   tokenVersion: 0 });
  });

  describe('GET /api/users/:userId/connections — public view', () => {
    it('returns public connections for a user', async () => {
      await db.userConnections.insert({ _id: uuidv4(), userId: otherId, platform: 'github', username: 'bobdev', url: 'https://github.com/bobdev', visibility: 'public' });
      const res = await request(app)
        .get(`/api/users/${otherId}/connections`)
        .set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0].platform).toBe('github');
      expect(res.body[0].label).toBe('GitHub');
    });

    it('returns empty array when no connections', async () => {
      const res = await request(app)
        .get(`/api/users/${otherId}/connections`)
        .set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('GET /api/me/connections', () => {
    it('returns own connections', async () => {
      await db.userConnections.insert({ _id: uuidv4(), userId, platform: 'twitter', username: 'alice_x', url: 'https://x.com/alice_x' });
      const res = await request(app)
        .get('/api/me/connections')
        .set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(200);
      expect(res.body.length).toBe(1);
      expect(res.body[0].platform).toBe('twitter');
    });
  });

  describe('PUT /api/me/connections/:platform', () => {
    it('adds a new github connection', async () => {
      const res = await request(app)
        .put('/api/me/connections/github')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ username: 'alice-dev' });
      expect([200, 201]).toContain(res.status);
      const conn = await db.userConnections.findOne({ userId, platform: 'github' });
      expect(conn).not.toBeNull();
      expect(conn.username).toBe('alice-dev');
    });

    it('returns 400 for unsupported platform', async () => {
      const res = await request(app)
        .put('/api/me/connections/unknownplatform')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ username: 'someone' });
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid username format', async () => {
      const res = await request(app)
        .put('/api/me/connections/github')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ username: 'this username has spaces!' });
      expect(res.status).toBe(400);
    });

    it('updates existing connection', async () => {
      await db.userConnections.insert({ _id: uuidv4(), userId, platform: 'github', username: 'old-name', url: 'https://github.com/old-name' });
      const res = await request(app)
        .put('/api/me/connections/github')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ username: 'new-name' });
      expect([200, 201]).toContain(res.status);
    });
  });

  describe('DELETE /api/me/connections/:platform', () => {
    it('removes a connection', async () => {
      await db.userConnections.insert({ _id: uuidv4(), userId, platform: 'twitch', username: 'alice_tv', url: 'https://twitch.tv/alice_tv' });
      const res = await request(app)
        .delete('/api/me/connections/twitch')
        .set('Authorization', `Bearer ${userToken}`);
      expect([200, 204]).toContain(res.status);
      const conn = await db.userConnections.findOne({ userId, platform: 'twitch' });
      expect(conn).toBeNull();
    });

    it('returns 404 when connection does not exist', async () => {
      const res = await request(app)
        .delete('/api/me/connections/steam')
        .set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(404);
    });
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/me/connections');
    expect(res.status).toBe(401);
  });
});
