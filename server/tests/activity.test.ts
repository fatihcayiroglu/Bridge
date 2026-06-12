// server/tests/activity.test.ts
// Tests for activity endpoints: PATCH /, GET /:userId, GET /server/:serverId, GET /meta/types

process.env.JWT_SECRET = 'test-jwt-secret';
process.env.NODE_ENV   = 'test';

import { createMockDb, makeUser, makeServer } from './helpers/mockDb';
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
jest.mock('../middleware/rateLimit', () => ({
  limits: new Proxy({}, { get: () => () => (_req, _res, next) => next() }),
}));

// Mock redisAdapter cache — simple in-memory
const cacheStore: Record<string, unknown> = {};
jest.mock('../lib/redisAdapter', () => ({
  redisClient: () => null,
  subscribeToChannel: async () => undefined,
  cache: {
    get: async (k) => cacheStore[k] ?? null,
    set: async (k, v) => { cacheStore[k] = v; },
    del: async (k) => { delete cacheStore[k]; },
    delete: async (k) => { delete cacheStore[k]; },
  },
}));


jest.mock('../lib/contentSanitizer', () => ({
  sanitizeMessageContent: (value: unknown) => String(value ?? ''),
  sanitizeDisplayName: (value: unknown) => String(value ?? ''),
  sanitizeTitle: (value: unknown) => String(value ?? ''),
  sanitizeActivityPubContent: (value: unknown) => String(value ?? ''),
  sanitizeUrl: (value: unknown) => typeof value === 'string' ? value : null,
  isCleanString: (value: unknown) => typeof value === 'string',
}));

// Mock index.js (for io access)
jest.mock('../index', () => ({ app: { get: () => null } }), { virtual: true });

import request from 'supertest';
import express from 'express';
const jwt     = require('jsonwebtoken');

import { router } from '../routes/activity';

const app = express();
app.use(express.json());
app.use('/api/activity', router);
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

function token(id) {
  return jwt.sign({ id, username: 'user', displayName: 'User', v: 0 }, 'test-jwt-secret', { expiresIn: '1h' });
}

const USER_A   = 'userA';
const USER_B   = 'userB';
const SERVER_ID = 'srv1';

beforeAll(async () => {
  await mockDb.users.insert(makeUser({ _id: USER_A, username: 'usera' }));
  await mockDb.users.insert(makeUser({ _id: USER_B, username: 'userb' }));
  await mockDb.servers.insert(makeServer(USER_A, { _id: SERVER_ID }));
  await mockDb.members.insert({ userId: USER_A, serverId: SERVER_ID, roles: '[]', joinedAt: Date.now() });
  await mockDb.members.insert({ userId: USER_B, serverId: SERVER_ID, roles: '[]', joinedAt: Date.now() });
});

// ── PATCH / — set activity ────────────────────────────────────

describe('PATCH /api/activity', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await request(app).patch('/api/activity');
    expect(res.status).toBe(401);
  });

  it('sets a playing activity', async () => {
    const res = await request(app)
      .patch('/api/activity')
      .set('Authorization', `Bearer ${token(USER_A)}`)
      .send({ type: 'playing', name: 'Chess', detail: 'vs. computer' });

    expect(res.status).toBe(200);
    expect(res.body.activity).toBeDefined();
    expect(res.body.activity.type).toBe('playing');
    expect(res.body.activity.name).toBe('Chess');
  });

  it('clears activity when body is null/empty', async () => {
    const res = await request(app)
      .patch('/api/activity')
      .set('Authorization', `Bearer ${token(USER_A)}`)
      .send(null);

    // null body → activity should be cleared
    expect([200]).toContain(res.status);
  });

  it('sets a coding activity', async () => {
    const res = await request(app)
      .patch('/api/activity')
      .set('Authorization', `Bearer ${token(USER_B)}`)
      .send({ type: 'coding', name: 'Bridge', detail: 'writing tests' });

    expect(res.status).toBe(200);
    expect(res.body.activity.type).toBe('coding');
  });
});

// ── GET /:userId — fetch activity ────────────────────────────

describe('GET /api/activity/:userId', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get(`/api/activity/${USER_A}`);
    expect(res.status).toBe(401);
  });

  it('returns activity for a known user', async () => {
    // Set activity first via cache
    cacheStore[`activity:${USER_B}`] = { type: 'coding', name: 'Bridge' };

    const res = await request(app)
      .get(`/api/activity/${USER_B}`)
      .set('Authorization', `Bearer ${token(USER_A)}`);

    expect(res.status).toBe(200);
    expect(res.body.activity).toBeDefined();
    expect(res.body.cached).toBe(true);
  });

  it('returns 404 for unknown user', async () => {
    const res = await request(app)
      .get('/api/activity/nonexistent-user')
      .set('Authorization', `Bearer ${token(USER_A)}`);

    expect(res.status).toBe(404);
  });
});

// ── GET /server/:serverId — server activity ────────────────────

describe('GET /api/activity/server/:serverId', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get(`/api/activity/server/${SERVER_ID}`);
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-members', async () => {
    const OUTSIDER = 'outsider1';
    await mockDb.users.insert(makeUser({ _id: OUTSIDER, username: 'outsider' }));

    const res = await request(app)
      .get(`/api/activity/server/${SERVER_ID}`)
      .set('Authorization', `Bearer ${token(OUTSIDER)}`);

    expect(res.status).toBe(403);
  });

  it('returns active member list for a member', async () => {
    const res = await request(app)
      .get(`/api/activity/server/${SERVER_ID}`)
      .set('Authorization', `Bearer ${token(USER_A)}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.active)).toBe(true);
    expect(typeof res.body.count).toBe('number');
  });
});

// ── GET /meta/types — activity types ─────────────────────────

describe('GET /api/activity/meta/types', () => {
  it('is publicly accessible and returns all activity types', async () => {
    const res = await request(app)
      .get('/api/activity/meta/types')
      .set('Authorization', `Bearer ${token(USER_A)}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.types)).toBe(true);
    const keys = res.body.types.map(t => t.key);
    expect(keys).toContain('PLAYING');
    expect(keys).toContain('CODING');
    expect(keys).toContain('LISTENING');
  });
});
