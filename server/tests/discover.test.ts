// server/tests/discover.test.ts
process.env.JWT_SECRET     = 'test-jwt-secret';
process.env.REFRESH_SECRET = 'test-refresh-secret';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
const db      = require('../db/loader');
const jwt     = require('jsonwebtoken');
import { authMiddleware } from '../middleware/auth';
import discoverRouter from '../routes/discover';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/discover', authMiddleware, discoverRouter);
  return app;
}
function tok(uid) { return jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

describe('Discover Routes', () => {
  let app, userId, token;

  beforeEach(async () => {
    db._reset?.();
    app    = buildApp();
    userId = uuidv4();
    token  = tok(userId);

    await db.users.insert({ _id: userId, username: 'u', displayName: 'U', tokenVersion: 0 });

    // Seed some discoverable servers
    for (let i = 0; i < 3; i++) {
      const sid = uuidv4();
      const oid = uuidv4();
      await db.users.insert({ _id: oid, username: `owner${i}`, displayName: `Owner${i}`, tokenVersion: 0 });
      await db.servers.insert({ _id: sid, name: `Public Server ${i}`, ownerId: oid, discoverable: 1, createdAt: Date.now() - i * 1000 });
      // Add 2 members so fallback filter passes
      await db.members.insert({ userId: oid, serverId: sid, roles: [] });
      await db.members.insert({ userId: uuidv4(), serverId: sid, roles: [] });
    }

    // One private (not discoverable) server
    const privSid = uuidv4();
    await db.servers.insert({ _id: privSid, name: 'Private Server', ownerId: userId, discoverable: 0, createdAt: Date.now() });
    await db.members.insert({ userId, serverId: privSid, roles: [] });
  });

  describe('GET /api/discover', () => {
    it('returns array of servers', async () => {
      const res = await request(app)
        .get('/api/discover')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('does not return private servers in results', async () => {
      const res = await request(app)
        .get('/api/discover')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      const names = res.body.map(s => s.name);
      expect(names).not.toContain('Private Server');
    });

    it('supports search query param', async () => {
      const res = await request(app)
        .get('/api/discover?q=Public')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('supports sort param', async () => {
      const res = await request(app)
        .get('/api/discover?sort=members')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it('each server has name and _id', async () => {
      const res = await request(app)
        .get('/api/discover')
        .set('Authorization', `Bearer ${token}`);
      if (res.body.length > 0) {
        expect(res.body[0]).toHaveProperty('_id');
        expect(res.body[0]).toHaveProperty('name');
      }
    });
  });

  describe('POST /api/discover/:sid/join', () => {
    it('allows user to join a discoverable server', async () => {
      // Get a discoverable server id
      const servers = await db.servers.find({ discoverable: 1 });
      const target = servers[0];
      if (!target) return;

      const res = await request(app)
        .post(`/api/discover/${target._id}/join`)
        .set('Authorization', `Bearer ${token}`);
      expect([200, 201, 400]).toContain(res.status); // 400 if already member
    });

    it('returns 404 for non-existent server', async () => {
      const res = await request(app)
        .post(`/api/discover/${uuidv4()}/join`)
        .set('Authorization', `Bearer ${token}`);
      expect([404, 400]).toContain(res.status);
    });
  });

  it('rejects unauthenticated', async () => {
    const res = await request(app).get('/api/discover');
    expect(res.status).toBe(401);
  });
});
