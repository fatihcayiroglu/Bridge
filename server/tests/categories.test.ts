// server/tests/categories.test.ts
// Tests for channel category CRUD + reorder
import type { Request, Response, NextFunction } from 'express';

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

import { createMockDb } from './helpers/mockDb';
const mockDb = createMockDb();

jest.mock('../db/index', () => mockDb);
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (
    req: { headers: { authorization?: string }; user?: unknown },
    res: { status: (c: number) => { json: (b: unknown) => unknown } },
    next: () => void,
  ) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const jwt = require('jsonwebtoken');
    try { req.user = jwt.verify(h.slice(7), 'test-jwt-secret-long-enough-32chars!!'); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
  },
}));
jest.mock('../middleware/rateLimit', () => ({
  limits: { channels: () => (_req: unknown, _res: unknown, next: () => void) => next() },
}));

const mockHasPermission = jest.fn((..._args: unknown[]) => true);
jest.mock('../routes/roles', () => ({
  getMemberPerms: async () => 0xFFFFFFFF,
  hasPermission: (...args: unknown[]) => mockHasPermission(...args),
  PERMS: { MANAGE_CHANNELS: 16, MANAGE_MESSAGES: 32, ADMIN: 8 },
}));

import request from 'supertest';
import express from 'express';
const jwt     = require('jsonwebtoken');

import router from '../routes/categories';
import { requireDoc } from './helpers/mockDb';

const app = express();
app.use(express.json());
app.use((req: Request, _res: Response, next: NextFunction) => {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) {
    try { req.user = jwt.verify(h.slice(7), 'test-jwt-secret-long-enough-32chars!!'); } catch {}
  }
  next();
});
app.use('/api/servers/:serverId/categories', router);
app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(err.status || 500).json({ error: err.message }));

function token(id = 'u1') {
  return jwt.sign({ id, username: 'admin', v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });
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
  let catId: string;
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
    const updated = await requireDoc(mockDb.channelCategories, { _id: catId });
    expect(updated.name).toBe('RENAMED');
  });

  it('collapses a category', async () => {
    const res = await request(app)
      .patch(`/api/servers/${SERVER_ID}/categories/${catId}`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ collapsed: true });
    expect(res.status).toBe(200);
    const updated = await requireDoc(mockDb.channelCategories, { _id: catId });
    // Sema BOOLEAN; `pg` gercek boolean dondurur (1/0 OKUNAMAZ).
    expect(updated.collapsed).toBe(true);
  });

  it.each([
    [{ name: { bad:true } }], [{ name:'   ' }], [{ position:'2' }],
    [{ position:-1 }], [{ position:1.5 }], [{ collapsed:'false' }],
  ])('rejects coercible/malformed category patch %#', async (body) => {
    const res = await request(app).patch(`/api/servers/${SERVER_ID}/categories/${catId}`)
      .set('Authorization', `Bearer ${token()}`).send(body);
    expect(res.status).toBe(400);
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
  let catIds: string[];
  beforeAll(async () => {
    const cats = await mockDb.channelCategories.find({ serverId: SERVER_ID });
    catIds = cats.map(c => c._id);
  });

  it('reorders categories', async () => {
    const order = catIds.map((id: string, i: number) => ({ id, position: catIds.length - 1 - i }));
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/categories/reorder`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ order });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Check positions were updated
    const updated = await requireDoc(mockDb.channelCategories, { _id: order[0].id });
    expect(updated.position).toBe(order[0].position);
  });

  it('rejects missing order array', async () => {
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/categories/reorder`)
      .set('Authorization', `Bearer ${token()}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('rejects malformed/duplicate reorder items', async () => {
    const invalidOrders = [
      [{ id: catIds[0], position: -1 }],
      [{ id: catIds[0], position: 1.5 }],
      [{ id: catIds[0], position: '1' }],
      [{ id: '', position: 1 }],
      [{ id: catIds[0], position: 0 }, { id: catIds[0], position: 1 }],
      null,
    ];
    for (const order of invalidOrders) {
      const res = await request(app)
        .post(`/api/servers/${SERVER_ID}/categories/reorder`)
        .set('Authorization', `Bearer ${token()}`)
        .send({ order });
      expect(res.status).toBe(400);
    }
  });

  it('returns 404 rather than partially reordering when a scoped category is missing', async () => {
    const before = await requireDoc(mockDb.channelCategories, { _id: catIds[0] });
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/categories/reorder`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ order: [{ id: catIds[0], position: 77 }, { id: 'missing-cat', position: 78 }] });
    expect(res.status).toBe(404);
    const after = await requireDoc(mockDb.channelCategories, { _id: catIds[0] });
    expect(after.position).toBe(before.position);
  });
});

describe('DELETE /api/servers/:serverId/categories/:catId', () => {
  let catId: string;
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
    const ch = await requireDoc(mockDb.channels, { _id: 'ch-test' });
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

  it('returns 404 for a category outside the scoped server / missing category', async () => {
    const res = await request(app)
      .delete(`/api/servers/${SERVER_ID}/categories/missing-category`)
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(404);
  });
});
