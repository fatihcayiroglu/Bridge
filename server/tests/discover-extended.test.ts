// server/tests/discover-extended.test.ts
// Sprint 69 — Discover route coverage genişletmesi
// Hedef: featured, categories, PATCH /settings, POST /admin/feature endpoint'leri

process.env.JWT_SECRET     = 'test-jwt-secret';
process.env.REFRESH_SECRET = 'test-refresh-secret';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

// cache modülünü in-memory stub ile değiştir
jest.mock('../lib/redisAdapter', () => ({
  cache: {
    _store: new Map<string, string>(),
    async get(key: string) { return (this._store as Map<string,string>).get(key) ?? null; },
    async set(key: string, val: unknown) { (this._store as Map<string,string>).set(key, String(val)); },
    async del(key: string) { (this._store as Map<string,string>).delete(key); },
  },
  subscribeToChannel: async () => () => {},
  publishToChannel: async () => {},
  _pubClient: null,
}));

jest.mock('../middleware/rateLimit', () => ({
  limits: { write: () => (_req: unknown, _res: unknown, next: () => void) => next() },
}));

import request    from 'supertest';
import express    from 'express';
import { v4 as uuidv4 } from 'uuid';
const db      = require('../db/loader');
const jwt     = require('jsonwebtoken');
import discoverRouter from '../routes/discover';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/discover', discoverRouter);
  return app;
}

function tok(uid: string, extra: Record<string, unknown> = {}) {
  return jwt.sign({ id: uid, v: 0, ...extra }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

let app: ReturnType<typeof buildApp>;
let ownerId: string;
let ownerToken: string;
let adminId: string;
let adminToken: string;
let otherId: string;
let otherToken: string;
let serverId: string;
let featuredServerId: string;

beforeEach(async () => {
  db._reset?.();
  app = buildApp();

  ownerId  = uuidv4();
  adminId  = uuidv4();
  otherId  = uuidv4();
  serverId = uuidv4();
  featuredServerId = uuidv4();

  ownerToken = tok(ownerId);
  adminToken = tok(adminId, { role: 'admin' });
  otherToken = tok(otherId);

  await db.users.insert({ _id: ownerId, username: 'owner', displayName: 'Owner', tokenVersion: 0 });
  await db.users.insert({ _id: adminId, username: 'admin', displayName: 'Admin', tokenVersion: 0, role: 'admin' });
  await db.users.insert({ _id: otherId, username: 'other', displayName: 'Other', tokenVersion: 0 });

  // Discoverable server owned by ownerId
  await db.servers.insert({
    _id: serverId, name: 'My Public Server', ownerId,
    discoverable: 1, description: 'original desc', tags: [], createdAt: Date.now(),
  });
  await db.members.insert({ userId: ownerId, serverId, roles: [] });
  await db.members.insert({ userId: otherId,  serverId, roles: [] });

  // Featured server
  await db.servers.insert({
    _id: featuredServerId, name: 'Featured Server',
    ownerId: uuidv4(), discoverable: 1, featured: 1, featuredAt: Date.now(),
    createdAt: Date.now() - 1000,
  });
  await db.members.insert({ userId: uuidv4(), serverId: featuredServerId, roles: [] });
  await db.members.insert({ userId: uuidv4(), serverId: featuredServerId, roles: [] });
});

// ── GET /api/discover/featured ────────────────────────────────────────────────

describe('GET /api/discover/featured', () => {
  it('returns only featured servers', async () => {
    const res = await request(app)
      .get('/api/discover/featured')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const ids = res.body.map((s: { _id: string }) => s._id);
    expect(ids).toContain(featuredServerId);
    expect(ids).not.toContain(serverId);
  });

  it('returns at most 12 featured servers', async () => {
    // Insert 15 featured servers
    for (let i = 0; i < 15; i++) {
      const sid = uuidv4();
      await db.servers.insert({
        _id: sid, name: `Featured ${i}`, ownerId: uuidv4(),
        discoverable: 1, featured: 1, featuredAt: Date.now() - i * 100,
        createdAt: Date.now(),
      });
    }
    const res = await request(app)
      .get('/api/discover/featured')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(12);
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(app).get('/api/discover/featured');
    expect(res.status).toBe(401);
  });
});

// ── GET /api/discover/categories ─────────────────────────────────────────────

describe('GET /api/discover/categories', () => {
  it('returns an array of category objects', async () => {
    const res = await request(app).get('/api/discover/categories');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('each category has id and label fields', async () => {
    const res = await request(app).get('/api/discover/categories');
    expect(res.status).toBe(200);
    for (const cat of res.body) {
      expect(cat).toHaveProperty('id');
      expect(cat).toHaveProperty('label');
      expect(typeof cat.id).toBe('string');
      expect(typeof cat.label).toBe('string');
    }
  });

  it('includes expected categories', async () => {
    const res = await request(app).get('/api/discover/categories');
    const ids = res.body.map((c: { id: string }) => c.id);
    expect(ids).toContain('gaming');
    expect(ids).toContain('tech');
    expect(ids).toContain('music');
  });
});

// ── PATCH /api/discover/settings ─────────────────────────────────────────────

describe('PATCH /api/discover/settings', () => {
  it('allows server owner to update discoverable flag', async () => {
    const res = await request(app)
      .patch('/api/discover/settings')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ serverId, discoverable: false });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('allows server owner to update description and tags', async () => {
    const res = await request(app)
      .patch('/api/discover/settings')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ serverId, description: 'New description', tags: ['games', 'fun'] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('allows server owner to update category', async () => {
    const res = await request(app)
      .patch('/api/discover/settings')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ serverId, category: 'gaming' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('rejects invalid category silently (ignored, not 400)', async () => {
    // Invalid category is just not applied, update still succeeds for other fields
    const res = await request(app)
      .patch('/api/discover/settings')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ serverId, category: 'totally_fake_category', description: 'ok' });
    expect(res.status).toBe(200);
  });

  it('rejects non-owner attempting to change settings (403)', async () => {
    const res = await request(app)
      .patch('/api/discover/settings')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ serverId, discoverable: false });
    expect(res.status).toBe(403);
  });

  it('returns 400 when serverId is missing', async () => {
    const res = await request(app)
      .patch('/api/discover/settings')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ discoverable: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/serverId/i);
  });

  it('returns 404 for unknown serverId', async () => {
    const res = await request(app)
      .patch('/api/discover/settings')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ serverId: uuidv4(), discoverable: true });
    expect(res.status).toBe(404);
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(app)
      .patch('/api/discover/settings')
      .send({ serverId, discoverable: true });
    expect(res.status).toBe(401);
  });
});

// ── POST /api/discover/admin/feature ─────────────────────────────────────────

describe('POST /api/discover/admin/feature', () => {
  it('allows admin to feature a server', async () => {
    const res = await request(app)
      .post('/api/discover/admin/feature')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ serverId, featured: true });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.featured).toBe(true);
    expect(res.body.serverId).toBe(serverId);
  });

  it('allows admin to un-feature a server', async () => {
    const res = await request(app)
      .post('/api/discover/admin/feature')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ serverId: featuredServerId, featured: false });
    expect(res.status).toBe(200);
    expect(res.body.featured).toBe(false);
  });

  it('returns 403 for non-admin users', async () => {
    const res = await request(app)
      .post('/api/discover/admin/feature')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ serverId, featured: true });
    expect(res.status).toBe(403);
  });

  it('returns 403 for server owner without admin flag', async () => {
    const res = await request(app)
      .post('/api/discover/admin/feature')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ serverId, featured: true });
    expect(res.status).toBe(403);
  });

  it('returns 400 when serverId is missing', async () => {
    const res = await request(app)
      .post('/api/discover/admin/feature')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ featured: true });
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown serverId', async () => {
    const res = await request(app)
      .post('/api/discover/admin/feature')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ serverId: uuidv4(), featured: true });
    expect(res.status).toBe(404);
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(app)
      .post('/api/discover/admin/feature')
      .send({ serverId, featured: true });
    expect(res.status).toBe(401);
  });
});

// ── GET /api/discover — category filter ──────────────────────────────────────

describe('GET /api/discover — category filter', () => {
  beforeEach(async () => {
    // Insert a server in gaming category
    const gamingSid = uuidv4();
    await db.servers.insert({
      _id: gamingSid, name: 'Gaming Hub', ownerId: uuidv4(),
      discoverable: 1, category: 'gaming', createdAt: Date.now(),
    });
    await db.members.insert({ userId: uuidv4(), serverId: gamingSid, roles: [] });
    await db.members.insert({ userId: uuidv4(), serverId: gamingSid, roles: [] });
  });

  it('filters results by category query param', async () => {
    const res = await request(app)
      .get('/api/discover?category=gaming')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    for (const s of res.body) {
      expect(s.category).toBe('gaming');
    }
  });

  it('returns empty array for unused category', async () => {
    const res = await request(app)
      .get('/api/discover?category=edu')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
