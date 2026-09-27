// server/tests/users.test.ts
process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
const db      = require('../db/loader');
const jwt     = require('jsonwebtoken');
import { authMiddleware } from '../middleware/auth';
import usersRouter from '../routes/users';
import { trackSocket, releaseSocket, setPresenceVisibility } from '../lib/presenceCache';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/users', authMiddleware, usersRouter);
  return app;
}
function tok(uid: string, v = 0) { return jwt.sign({ id: uid, v }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

describe('Users Routes', () => {
  let app: express.Express;
  let userId: string;
  let otherId: string;
  let serverId: string;
  let userToken: string;
  let otherToken: string;

  beforeEach(async () => {
    db._reset?.();
    app      = buildApp();
    userId   = uuidv4();
    otherId  = uuidv4();
    serverId = uuidv4();
    userToken  = tok(userId);
    otherToken = tok(otherId);

    await db.users.insert({ _id: userId, username: 'alice', displayName: 'Alice', tokenVersion: 0, status: 'online', statusText: 'coding', statusEmoji: '💻', presenceVisibility: 'visible', createdAt: Date.now() });
    await db.users.insert({ _id: otherId, username: 'bob',   displayName: 'Bob',   tokenVersion: 0, status: 'offline', presenceVisibility: 'visible', createdAt: Date.now() });
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

    it('redacts every presence field from a hidden public profile but preserves self-view', async () => {
      await db.users.update({ _id: userId }, { $set: { presenceVisibility: 'hidden' } });

      const otherView = await request(app)
        .get(`/api/users/${userId}`)
        .set('Authorization', `Bearer ${otherToken}`);
      expect(otherView.status).toBe(200);
      expect(otherView.body.status).toBe('offline');
      expect(otherView.body.statusText).toBe('');
      expect(otherView.body.statusEmoji).toBe('');

      const ownView = await request(app)
        .get(`/api/users/${userId}`)
        .set('Authorization', `Bearer ${userToken}`);
      expect(ownView.body.status).toBe('online');
      expect(ownView.body.statusText).toBe('coding');
      expect(ownView.body.statusEmoji).toBe('💻');
    });

    it('fails closed for an invalid legacy presenceVisibility value', async () => {
      await db.users.update({ _id: userId }, { $set: { presenceVisibility: 'Visible-ish' } });
      const res = await request(app)
        .get(`/api/users/${userId}`)
        .set('Authorization', `Bearer ${otherToken}`);
      expect(res.body.status).toBe('offline');
      expect(res.body.statusText).toBe('');
      expect(res.body.statusEmoji).toBe('');
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
      const ids = res.body.map((s: Record<string, unknown>) => s._id);
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

  // Final21 Faz 19: bu uç hiç test edilmiyordu (dal kapsamı %42.85).
  describe('GET /api/users/:userId/presence', () => {
    it('reports a connected user as online with the stored status fields', async () => {
      await trackSocket(userId, 'sock-presence-1');
      try {
        const res = await request(app).get(`/api/users/${userId}/presence`).set('Authorization', `Bearer ${otherToken}`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ userId, online: true, status: 'online', statusText: 'coding', statusEmoji: '💻' });
      } finally {
        await releaseSocket(userId, 'sock-presence-1');
      }
    });

    it('a user who hid their presence leaks neither online state nor stored status fields to others', async () => {
      await db.users.update({ _id: userId }, { $set: { presenceVisibility: 'hidden' } });
      await setPresenceVisibility(userId, false);
      await trackSocket(userId, 'sock-presence-2', false);
      try {
        const res = await request(app).get(`/api/users/${userId}/presence`).set('Authorization', `Bearer ${otherToken}`);
        expect(res.body).toEqual({ userId, online: false, status: 'offline', statusText: '', statusEmoji: '' });

        const own = await request(app).get(`/api/users/${userId}/presence`).set('Authorization', `Bearer ${userToken}`);
        expect(own.body.statusText).toBe('coding');
        expect(own.body.statusEmoji).toBe('💻');
      } finally {
        await releaseSocket(userId, 'sock-presence-2');
        await setPresenceVisibility(userId, true);
      }
    });

    it('fails closed for invalid legacy presence visibility values', async () => {
      await db.users.update({ _id: userId }, { $set: { presenceVisibility: 'Hidden-ish' } });
      const res = await request(app).get(`/api/users/${userId}/presence`).set('Authorization', `Bearer ${otherToken}`);
      expect(res.body).toEqual({ userId, online: false, status: 'offline', statusText: '', statusEmoji: '' });
    });

    it('fills empty defaults for a user without status fields', async () => {
      const bareId = uuidv4();
      await db.users.insert({ _id: bareId, username: 'bare', displayName: 'Bare', tokenVersion: 0, presenceVisibility: 'visible' });
      const res = await request(app).get(`/api/users/${bareId}/presence`).set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ userId: bareId, online: false, status: 'offline', statusText: '', statusEmoji: '' });
    });

    it('404 for an unknown user; 401 without a token', async () => {
      expect((await request(app).get(`/api/users/${uuidv4()}/presence`).set('Authorization', `Bearer ${userToken}`)).status).toBe(404);
      expect((await request(app).get(`/api/users/${userId}/presence`)).status).toBe(401);
    });
  });
});
