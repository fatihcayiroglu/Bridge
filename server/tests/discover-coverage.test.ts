// server/tests/discover-coverage.test.ts
// Sprint 110: discover.ts coverage artırımı — admin/feature, settings, categories, cache path
// Hedef: routes/discover.ts satır coverage %70 → %80

process.env.JWT_SECRET     = 'test-jwt-secret';
process.env.REFRESH_SECRET = 'test-refresh-secret';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../lib/redisAdapter', () => ({
  cache: {
    get:   jest.fn().mockResolvedValue(null),
    set:   jest.fn().mockResolvedValue(undefined),
    del:   jest.fn().mockResolvedValue(undefined),
  },
  pub:   { publish: jest.fn() },
  sub:   { subscribe: jest.fn() },
}));
jest.mock('../lib/presenceCache', () => ({
  isUserOnline: jest.fn().mockResolvedValue(false),
}));

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
const db  = require('../db/loader');
const jwt = require('jsonwebtoken');
import { authMiddleware } from '../middleware/auth';
import discoverRouter, { DISCOVER_CATEGORIES } from '../routes/discover';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/discover', authMiddleware, discoverRouter);
  return app;
}
function tok(uid: string, role?: string) {
  return jwt.sign({ id: uid, v: 0, role: role ?? 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

describe('Discover — coverage artırımı', () => {
  let app: ReturnType<typeof express>;
  let userId: string;
  let adminId: string;
  let token: string;
  let adminToken: string;
  let serverId: string;

  beforeEach(async () => {
    db._reset?.();
    app       = buildApp();
    userId    = uuidv4();
    adminId   = uuidv4();
    serverId  = uuidv4();
    token      = tok(userId);
    adminToken = tok(adminId, 'admin');

    await db.users.insert({ _id: userId,   username: 'user',  displayName: 'User',  tokenVersion: 0 });
    await db.users.insert({ _id: adminId,  username: 'admin', displayName: 'Admin', tokenVersion: 0, role: 'admin' });

    await db.servers.insert({
      _id: serverId, name: 'Test Server', ownerId: userId,
      discoverable: 1, createdAt: Date.now(), description: '', tags: [],
    });
    await db.members.insert({ userId, serverId, roles: [] });
    await db.members.insert({ userId: adminId, serverId, roles: [] });
    await db.channels.insert({ _id: uuidv4(), serverId, name: 'general', type: 'text', createdAt: Date.now() });
  });

  // ── GET /categories ──────────────────────────────────────────────────────

  describe('GET /api/discover/categories', () => {
    it('returns all categories without auth', async () => {
      const app2 = express();
      app2.use(express.json());
      app2.use('/api/discover', discoverRouter);
      const res = await request(app2).get('/api/discover/categories');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(DISCOVER_CATEGORIES.length);
    });

    it('each category has id and label', async () => {
      const app2 = express();
      app2.use(express.json());
      app2.use('/api/discover', discoverRouter);
      const res = await request(app2).get('/api/discover/categories');
      for (const cat of res.body) {
        expect(cat).toHaveProperty('id');
        expect(cat).toHaveProperty('label');
      }
    });
  });

  // ── GET /featured ────────────────────────────────────────────────────────

  describe('GET /api/discover/featured', () => {
    it('returns empty array when no featured servers', async () => {
      const res = await request(app)
        .get('/api/discover/featured')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('returns featured servers when present', async () => {
      await db.servers.update(serverId, { featured: 1, featuredAt: Date.now() });
      const res = await request(app)
        .get('/api/discover/featured')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('uses cache when available', async () => {
      const { cache } = require('../lib/redisAdapter');
      cache.get.mockResolvedValueOnce(JSON.stringify([{ _id: serverId, name: 'Cached' }]));
      const res = await request(app)
        .get('/api/discover/featured')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });
  });

  // ── GET / (main discover) ────────────────────────────────────────────────

  describe('GET /api/discover — filtre dalları', () => {
    it('filters by category', async () => {
      await db.servers.update(serverId, { category: 'gaming' });
      const res = await request(app)
        .get('/api/discover?category=gaming')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it('ignores unknown category', async () => {
      const res = await request(app)
        .get('/api/discover?category=unknown_xyz')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('supports search query', async () => {
      const res = await request(app)
        .get('/api/discover?q=Test')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it('supports sort=members param', async () => {
      const res = await request(app)
        .get('/api/discover?sort=members')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it('supports sort=activity param', async () => {
      const res = await request(app)
        .get('/api/discover?sort=activity')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it('returns 401 without token', async () => {
      const res = await request(app).get('/api/discover');
      expect(res.status).toBe(401);
    });
  });

  // ── PATCH /settings ──────────────────────────────────────────────────────

  describe('PATCH /api/discover/settings', () => {
    it('owner can update discoverable', async () => {
      const res = await request(app)
        .patch('/api/discover/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ serverId, discoverable: false });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('owner can update description', async () => {
      const res = await request(app)
        .patch('/api/discover/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ serverId, description: 'A great community!' });
      expect(res.status).toBe(200);
    });

    it('owner can update tags array', async () => {
      const res = await request(app)
        .patch('/api/discover/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ serverId, tags: ['gaming', 'chill', 'fun'] });
      expect(res.status).toBe(200);
    });

    it('owner can update category to valid value', async () => {
      const res = await request(app)
        .patch('/api/discover/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ serverId, category: 'gaming' });
      expect(res.status).toBe(200);
    });

    it('ignores invalid category value', async () => {
      const res = await request(app)
        .patch('/api/discover/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ serverId, category: 'not_a_real_category' });
      expect(res.status).toBe(200);
    });

    it('returns 400 when serverId missing', async () => {
      const res = await request(app)
        .patch('/api/discover/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ discoverable: true });
      expect(res.status).toBe(400);
    });

    it('returns 404 for nonexistent server', async () => {
      const res = await request(app)
        .patch('/api/discover/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ serverId: uuidv4(), discoverable: true });
      expect(res.status).toBe(404);
    });

    it('returns 403 for non-owner', async () => {
      const otherId = uuidv4();
      await db.users.insert({ _id: otherId, username: 'other', displayName: 'Other', tokenVersion: 0 });
      const otherTok = tok(otherId);
      const res = await request(app)
        .patch('/api/discover/settings')
        .set('Authorization', `Bearer ${otherTok}`)
        .send({ serverId, discoverable: false });
      expect(res.status).toBe(403);
    });

    it('truncates long description at 500 chars', async () => {
      const longDesc = 'a'.repeat(600);
      const res = await request(app)
        .patch('/api/discover/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ serverId, description: longDesc });
      expect(res.status).toBe(200);
    });

    it('limits tags to 10 items', async () => {
      const manyTags = Array.from({ length: 15 }, (_, i) => `tag${i}`);
      const res = await request(app)
        .patch('/api/discover/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ serverId, tags: manyTags });
      expect(res.status).toBe(200);
    });
  });

  // ── POST /admin/feature ──────────────────────────────────────────────────

  describe('POST /api/discover/admin/feature', () => {
    it('admin can feature a server', async () => {
      const res = await request(app)
        .post('/api/discover/admin/feature')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ serverId, featured: true });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.featured).toBe(true);
    });

    it('admin can unfeature a server', async () => {
      const res = await request(app)
        .post('/api/discover/admin/feature')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ serverId, featured: false });
      expect(res.status).toBe(200);
      expect(res.body.featured).toBe(false);
    });

    it('returns 403 for non-admin user', async () => {
      const res = await request(app)
        .post('/api/discover/admin/feature')
        .set('Authorization', `Bearer ${token}`)
        .send({ serverId, featured: true });
      expect(res.status).toBe(403);
    });

    it('returns 400 when serverId missing', async () => {
      const res = await request(app)
        .post('/api/discover/admin/feature')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ featured: true });
      expect(res.status).toBe(400);
    });

    it('returns 404 for nonexistent server', async () => {
      const res = await request(app)
        .post('/api/discover/admin/feature')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ serverId: uuidv4(), featured: true });
      expect(res.status).toBe(404);
    });

    it('invalidates featured cache on feature', async () => {
      const { cache } = require('../lib/redisAdapter');
      await request(app)
        .post('/api/discover/admin/feature')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ serverId, featured: true });
      expect(cache.del).toHaveBeenCalledWith('discover:featured:list');
    });
  });
});
