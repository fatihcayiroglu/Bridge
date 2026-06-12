// server/tests/stats.test.ts
process.env.JWT_SECRET     = 'test-jwt-secret';
process.env.REFRESH_SECRET = 'test-refresh-secret';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => {
  const mock = require('./helpers/mockDb').createMockDb();
  mock._sqlite = {
    prepare: () => ({
      get:  () => ({ n: 5 }),
      all:  () => [],
      run:  () => {},
    }),
  };
  return mock;
});

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
const db      = require('../db/loader');
const jwt     = require('jsonwebtoken');
import { authMiddleware } from '../middleware/auth';
import statsRouter from '../routes/stats';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers', authMiddleware, statsRouter);
  return app;
}
function tok(uid, v = 0) { return jwt.sign({ id: uid, v }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

describe('Stats Routes', () => {
  let app, ownerId, strangerId, memberId, serverId, channelId;
  let ownerToken, strangerToken, memberToken;

  beforeEach(async () => {
    db._reset?.();
    app        = buildApp();
    ownerId    = uuidv4();
    strangerId = uuidv4();
    memberId   = uuidv4();
    serverId   = uuidv4();
    channelId  = uuidv4();
    ownerToken    = tok(ownerId);
    strangerToken = tok(strangerId);
    memberToken   = tok(memberId);

    await db.users.insert({ _id: ownerId,    username: 'owner',   displayName: 'Owner',   tokenVersion: 0 });
    await db.users.insert({ _id: strangerId, username: 'stranger', displayName: 'Stranger', tokenVersion: 0 });
    await db.users.insert({ _id: memberId,   username: 'member',  displayName: 'Member',  tokenVersion: 0 });
    await db.servers.insert({ _id: serverId, name: 'TestServer', ownerId });
    await db.members.insert({ userId: ownerId,  serverId, roles: [] });
    await db.members.insert({ userId: memberId, serverId, roles: [] });
    await db.channels.insert({ _id: channelId, serverId, name: 'general', type: 'text' });
  });

  describe('GET /:serverId/stats — access control', () => {
    it('returns 200 + stats for server owner', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/stats`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('memberCount');
      expect(res.body).toHaveProperty('channelCount');
      expect(res.body).toHaveProperty('totalMessages');
      expect(res.body).toHaveProperty('topUsers');
    });

    it('returns 200 for any server member (not just owner)', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/stats`)
        .set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(200);
    });

    it('returns 403 for non-member', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/stats`)
        .set('Authorization', `Bearer ${strangerToken}`);
      expect(res.status).toBe(403);
    });

    it('returns 403 for nonexistent server', async () => {
      const res = await request(app)
        .get(`/api/servers/${uuidv4()}/stats`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(403);
    });

    it('returns 401 for unauthenticated request', async () => {
      const res = await request(app).get(`/api/servers/${serverId}/stats`);
      expect(res.status).toBe(401);
    });

    it('returns 401 for invalid token', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/stats`)
        .set('Authorization', 'Bearer not.a.real.token');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /:serverId/stats — response shape', () => {
    it('memberCount reflects actual member records', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/stats`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.body.memberCount).toBe(2); // owner + member
    });

    it('channelCount reflects actual channel records', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/stats`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.body.channelCount).toBe(1);
    });

    it('topUsers is an array', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/stats`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(Array.isArray(res.body.topUsers)).toBe(true);
    });

    it('topUsers includes users who sent recent messages', async () => {
      await db.messages.insert({
        _id: uuidv4(), channelId, serverId,
        userId: ownerId, username: 'owner', displayName: 'Owner',
        content: 'hi', type: 'normal', reactions: {}, createdAt: Date.now(),
      });

      const res = await request(app)
        .get(`/api/servers/${serverId}/stats`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.body.topUsers.length).toBeGreaterThan(0);
      expect(res.body.topUsers[0]).toHaveProperty('msgCount');
      expect(res.body.topUsers[0]).toHaveProperty('userId');
    });

    it('totalMessages is a number', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/stats`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(typeof res.body.totalMessages).toBe('number');
    });

    it('topUsers capped at 10 even with many active users', async () => {
      for (let i = 0; i < 15; i++) {
        const uid = uuidv4();
        await db.messages.insert({
          _id: uuidv4(), channelId, serverId,
          userId: uid, username: `user${i}`, displayName: `User ${i}`,
          content: 'msg', type: 'normal', reactions: {}, createdAt: Date.now(),
        });
      }
      const res = await request(app)
        .get(`/api/servers/${serverId}/stats`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.body.topUsers.length).toBeLessThanOrEqual(10);
    });
  });
});

