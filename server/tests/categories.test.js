// server/tests/categories.test.js
// Tests for channel category CRUD + reorder

process.env.JWT_SECRET = 'test-jwt-secret';
process.env.NODE_ENV   = 'test';

const { createMockDb } = require('./helpers/mockDb');
const mockDb = createMockDb();

jest.mock('../db/index', () => mockDb);
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req, res, next) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const jwt = require('jsonwebtoken');
    try { req.user = jwt.verify(h.slice(7), 'test-jwt-secret'); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
  },
}));

const mockHasPermission = jest.fn(() => true);
jest.mock('../routes/roles', () => ({
  getMemberPerms: async () => 0xFFFFFFFF,
  hasPermission: (...args) => mockHasPermission(...args),
  PERMS: { MANAGE_CHANNELS: 16, MANAGE_MESSAGES: 32, ADMIN: 8 },
}));

const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');

const router = require('../routes/categories');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) {
    try { req.user = jwt.verify(h.slice(7), 'test-jwt-secret'); } catch {}
  }
  next();
});
app.use('/api/servers/:serverId/categories', router);
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

function token(id = 'u1') {
  return jwt.sign({ id, username: 'admin', v: 0 }, 'test-jwt-secret', { expiresIn: '1h' });
}

const SERVER_ID = 'srv1';
const USER_ID   = 'u1';

beforeAll(async () => {
  await mockDb.members.insert({ userId: USER_ID, serverId: SERVER_ID, roles: '[]', joinedAt: Date.now() });
});

describe('POST /api/servers/:serverId/categories', () => {
  it('creates a new category', async () => {
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/categories`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ name: 'general' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('GENERAL');  // toUpperCase
    expect(res.body.serverId).toBe(SERVER_ID);
    expect(res.body.collapsed).toBe(false);
  });

  it('creates a second category with incremented position', async () => {
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/categories`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ name: 'voice' });
    expect(res.status).toBe(200);
    expect(res.body.position).toBe(1);
  });

  it('rejects empty name', async () => {
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/categories`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ name: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name required/i);
  });

  it('rejects without permission', async () => {
    mockHasPermission.mockReturnValueOnce(false);
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/categories`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ name: 'test' });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/servers/:serverId/categories', () => {
  it('returns categories sorted by position', async () => {
    const res = await request(app)
      .get(`/api/servers/${SERVER_ID}/categories`)
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
    // position ascending
    for (let i = 1; i < res.body.length; i++) {
      expect(res.body[i].position).toBeGreaterThanOrEqual(res.body[i - 1].position);
    }
  });

  it('returns 403 for non-members', async () => {
    const res = await request(app)
      .get(`/api/servers/${SERVER_ID}/categories`)
      .set('Authorization', `Bearer ${token('outsider')}`);
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/servers/:serverId/categories/:catId', () => {
  let catId;
  beforeAll(async () => {
    const cats = await mockDb.channelCategories.find({ serverId: SERVER_ID });
    catId = cats[0]?._id;
  });

  it('renames a category (uppercased)', async () => {
    const res = await request(app)
      .patch(`/api/servers/${SERVER_ID}/categories/${catId}`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ name: 'renamed' });
    expect(res.status).toBe(200);
    const updated = await mockDb.channelCategories.findOne({ _id: catId });
    expect(updated.name).toBe('RENAMED');
  });

  it('collapses a category', async () => {
    const res = await request(app)
      .patch(`/api/servers/${SERVER_ID}/categories/${catId}`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ collapsed: true });
    expect(res.status).toBe(200);
    const updated = await mockDb.channelCategories.findOne({ _id: catId });
    expect(updated.collapsed).toBe(1);
  });

  it('rejects without permission', async () => {
    mockHasPermission.mockReturnValueOnce(false);
    const res = await request(app)
      .patch(`/api/servers/${SERVER_ID}/categories/${catId}`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ name: 'nope' });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/servers/:serverId/categories/reorder', () => {
  let catIds;
  beforeAll(async () => {
    const cats = await mockDb.channelCategories.find({ serverId: SERVER_ID });
    catIds = cats.map(c => c._id);
  });

  it('reorders categories', async () => {
    const order = catIds.map((id, i) => ({ id, position: catIds.length - 1 - i }));
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/categories/reorder`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ order });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Check positions were updated
    const updated = await mockDb.channelCategories.findOne({ _id: order[0].id });
    expect(updated.position).toBe(order[0].position);
  });

  it('rejects missing order array', async () => {
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/categories/reorder`)
      .set('Authorization', `Bearer ${token()}`)
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/servers/:serverId/categories/:catId', () => {
  let catId;
  beforeAll(async () => {
    // Create a fresh category to delete
    const cat = await mockDb.channelCategories.insert({
      serverId: SERVER_ID, name: 'TO_DELETE', position: 99, collapsed: false, createdAt: Date.now(),
    });
    catId = cat._id;
    // Add a channel assigned to this category
    await mockDb.channels.insert({ _id: 'ch-test', serverId: SERVER_ID, name: 'test', categoryId: catId, createdAt: Date.now() });
  });

  it('deletes the category', async () => {
    const res = await request(app)
      .delete(`/api/servers/${SERVER_ID}/categories/${catId}`)
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    const gone = await mockDb.channelCategories.findOne({ _id: catId });
    expect(gone).toBeNull();
  });

  it('moves channels to uncategorized (null)', async () => {
    const ch = await mockDb.channels.findOne({ _id: 'ch-test' });
    expect(ch.categoryId).toBeNull();
  });

  it('rejects without permission', async () => {
    // Create another cat to try to delete
    const cat2 = await mockDb.channelCategories.insert({
      serverId: SERVER_ID, name: 'NO_PERM', position: 100, collapsed: false, createdAt: Date.now(),
    });
    mockHasPermission.mockReturnValueOnce(false);
    const res = await request(app)
      .delete(`/api/servers/${SERVER_ID}/categories/${cat2._id}`)
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(403);
  });
});
