// server/tests/activity.test.ts
// Tests for activity endpoints: PATCH /, GET /:userId, GET /server/:serverId, GET /meta/types

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

import { createMockDb, makeUser, makeServer } from './helpers/mockDb';
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
  limits: new Proxy({}, { get: () => () => (_req: unknown, _res: unknown, next: () => void) => next() }),
}));

// Mock redisAdapter cache — simple in-memory
const cacheStore: Record<string, unknown> = {};
jest.mock('../lib/redisAdapter', () => ({
  redisClient: () => null,
  subscribeToChannel: async () => undefined,
  cache: {
    // Gercek adaptorde MEVCUT (lib/redisAdapter.ts) — mock'ta eksikti ve
    // `invalidateChannelMessages` her cagrida sessizce TypeError firlatiyordu.
    invalidatePattern: jest.fn().mockResolvedValue(undefined),
    get: async (k: string) => cacheStore[k] ?? null,
    set: async (k: string, v: unknown) => { cacheStore[k] = v; },
    del: async (k: string) => { delete cacheStore[k]; },
    delete: async (k: string) => { delete cacheStore[k]; },
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

jest.mock('../socket', () => ({ getIo: () => null }));

import request from 'supertest';
import express from 'express';
const jwt     = require('jsonwebtoken');

import { router } from '../routes/activity';

const app = express();
app.use(express.json());
app.use('/api/activity', router);
app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(err.status || 500).json({ error: err.message }));

function token(id: string) {
  return jwt.sign({ id, username: 'user', displayName: 'User', v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });
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
      .set('Authorization', `Bearer ${token(USER_A)}`);
      // NOT: burada `.send(null)` yaziliydi. superagent `send(null)` cagrisini
      // SESSIZCE YOK SAYAR (`isObject(null)` false, `typeof null` 'string'
      // degil), yani istek zaten BOS govdeyle gidiyordu. Cagri kaldirildi:
      // davranis aynidir, niyet ("bos govde") artik acikca yaziyor.

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
    const keys = res.body.types.map((t: Record<string, unknown>) => t.key);
    expect(keys).toContain('PLAYING');
    expect(keys).toContain('CODING');
    expect(keys).toContain('LISTENING');
  });
});

describe('PATCH /api/activity runtime body validation', () => {
  it.each([
    [{ type: 7, name: 'x' }, 'type'],
    [{ type: 'playing', name: 7 }, 'name'],
    [{ type: 'playing', name: 'x', detail: {} }, 'detail'],
    [{ type: 'playing', name: 'x', url: [] }, 'url'],
    [{ type: 'playing', name: 'x', emoji: 1 }, 'emoji'],
  ])('rejects malformed field types without throwing: %#', async (body, field) => {
    const res = await request(app).patch('/api/activity')
      .set('Authorization', `Bearer ${token(USER_A)}`).send(body);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(new RegExp(field, 'i'));
  });
});
