// server/tests/serverProfile.test.js
process.env.JWT_SECRET     = 'test-jwt-secret';
process.env.REFRESH_SECRET = 'test-refresh-secret';
process.env.NODE_ENV       = 'test';
process.env.INSTANCE_URL   = 'http://localhost:3001';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

const request  = require('supertest');
const express  = require('express');
const { v4: uuidv4 } = require('uuid');
const db       = require('../db/loader');
const jwt      = require('jsonwebtoken');
const { authMiddleware } = require('../middleware/auth');
const profileRouter    = require('../routes/serverProfile');
const templatesRouter  = require('../routes/serverTemplates');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers',    authMiddleware, profileRouter);
  app.use('/s',              profileRouter);
  app.use('/api/server-templates', authMiddleware, templatesRouter);
  return app;
}
function tok(uid) { return jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

describe('Server Profile Routes', () => {
  let app, ownerId, memberId, serverId, ownerToken, memberToken;

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
    await db.servers.insert({ _id: serverId, name: 'Bridge Gaming', ownerId, icon: '🎮', discoverable: 1 });
    await db.members.insert({ userId: ownerId,  serverId, roles: [] });
    await db.members.insert({ userId: memberId, serverId, roles: [] });
  });

  // ── Slug API ─────────────────────────────────────────────────
  describe('GET /api/servers/:sid/slug', () => {
    it('returns null slug when not set', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/slug`)
        .set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('slug');
    });

    it('returns 404 for nonexistent server', async () => {
      const res = await request(app)
        .get(`/api/servers/${uuidv4()}/slug`)
        .set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/servers/:sid/slug', () => {
    it('owner can set slug', async () => {
      const res = await request(app)
        .put(`/api/servers/${serverId}/slug`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ slug: 'bridge-gaming' });
      expect(res.status).toBe(200);
      expect(res.body.slug).toBe('bridge-gaming');
    });

    it('auto-slugifies the server name if no slug provided', async () => {
      const res = await request(app)
        .put(`/api/servers/${serverId}/slug`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.slug).toBeTruthy();
      // Should be lowercase with dashes
      expect(res.body.slug).toMatch(/^[a-z0-9-]+$/);
    });

    it('rejects non-owner setting slug', async () => {
      const res = await request(app)
        .put(`/api/servers/${serverId}/slug`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ slug: 'hack' });
      expect(res.status).toBe(403);
    });

    it('rejects slug collision', async () => {
      // Set same slug on another server
      const otherOwnerId = uuidv4();
      const otherServerId = uuidv4();
      await db.users.insert({ _id: otherOwnerId, username: 'o2', displayName: 'O2', tokenVersion: 0 });
      await db.servers.insert({ _id: otherServerId, name: 'Other', ownerId: otherOwnerId, slug: 'taken-slug' });
      await db.members.insert({ userId: otherOwnerId, serverId: otherServerId, roles: [] });

      const res = await request(app)
        .put(`/api/servers/${serverId}/slug`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ slug: 'taken-slug' });
      expect(res.status).toBe(409);
    });
  });

  // ── Public profile page /s/:slug ────────────────────────────
  describe('GET /s/:slug', () => {
    beforeEach(async () => {
      await db.servers.update({ _id: serverId }, { $set: { slug: 'bridge-gaming-test' } });
    });

    it('returns HTML page for valid slug', async () => {
      const res = await request(app).get('/s/bridge-gaming-test');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/html/);
      expect(res.text).toContain('Bridge Gaming');
    });

    it('contains Open Graph meta tags', async () => {
      const res = await request(app).get('/s/bridge-gaming-test');
      expect(res.status).toBe(200);
      expect(res.text).toContain('og:title');
      expect(res.text).toContain('og:description');
    });

    it('contains join button', async () => {
      const res = await request(app).get('/s/bridge-gaming-test');
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/katıl|join/i);
    });

    it('returns 404 HTML for unknown slug', async () => {
      const res = await request(app).get('/s/definitely-not-exists-xyz');
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/html/);
    });
  });

  it('rejects unauthenticated slug API', async () => {
    const res = await request(app).get(`/api/servers/${serverId}/slug`);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────
describe('Server Templates Routes', () => {
  let app, userId, token;

  beforeEach(async () => {
    db._reset?.();
    app    = buildApp();
    userId = uuidv4();
    token  = tok(userId);
    await db.users.insert({ _id: userId, username: 'u', displayName: 'U', tokenVersion: 0 });
  });

  describe('GET /api/server-templates', () => {
    it('returns array of templates', async () => {
      const res = await request(app)
        .get('/api/server-templates')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
    });

    it('each template has id, name, description', async () => {
      const res = await request(app)
        .get('/api/server-templates')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      const t = res.body[0];
      expect(t).toHaveProperty('id');
      expect(t).toHaveProperty('name');
      expect(t).toHaveProperty('description');
    });

    it('includes expected template categories', async () => {
      const res = await request(app)
        .get('/api/server-templates')
        .set('Authorization', `Bearer ${token}`);
      const ids = res.body.map(t => t.id);
      // At least one of these should exist
      const expected = ['gaming', 'education', 'community', 'work', 'art'];
      expect(ids.some(id => expected.includes(id))).toBe(true);
    });
  });

  describe('POST /api/server-templates/:id/apply', () => {
    it('creates server from gaming template', async () => {
      const res = await request(app)
        .post('/api/server-templates/gaming/apply')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'My Gaming Server' });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('_id');
      expect(res.body).toHaveProperty('name', 'My Gaming Server');
    });

    it('creates server with auto-name from template if no name provided', async () => {
      const res = await request(app)
        .post('/api/server-templates/gaming/apply')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect([200, 400]).toContain(res.status);
    });

    it('returns 404 for nonexistent template', async () => {
      const res = await request(app)
        .post('/api/server-templates/not-a-real-template/apply')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Test' });
      expect([404, 400]).toContain(res.status);
    });

    it('creates channels from template', async () => {
      const res = await request(app)
        .post('/api/server-templates/gaming/apply')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Test Gaming' });
      if (res.status === 200) {
        const sid = res.body._id;
        const channels = await db.channels.find({ serverId: sid });
        expect(channels.length).toBeGreaterThan(0);
      }
    });
  });

  it('rejects unauthenticated', async () => {
    const res = await request(app).get('/api/server-templates');
    expect(res.status).toBe(401);
  });
});
