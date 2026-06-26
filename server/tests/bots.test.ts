// server/tests/bots.test.ts
// Tests for bot management endpoints: create, list, delete, token-rotate, webhook

process.env.JWT_SECRET = 'test-jwt-secret';
process.env.NODE_ENV   = 'test';

import { createMockDb, makeUser, makeServer } from './helpers/mockDb';
const mockDb = createMockDb();

jest.mock('../db/index', () => mockDb);
jest.mock('../db/loader', () => require('../db/index'));

jest.mock('../middleware/rateLimit', () => ({
  limits: { bots: () => (_req, _res, next) => next() },
}));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req, res, next) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const jwt = require('jsonwebtoken');
    try { req.user = jwt.verify(h.slice(7), 'test-jwt-secret'); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
  },
}));

// Mock permissions — owner has MANAGE_SERVER by default
const mockResolvePermissions = jest.fn(async () => 0xFFFFFFFF);
const mockHasPermission = jest.fn((perms, permission) => (perms & permission) === permission);
jest.mock('../lib/permissions', () => ({
  resolvePermissions: (...args) => mockResolvePermissions(...args),
  hasPermission: (...args) => mockHasPermission(...args),
  PERMS: {
    MANAGE_SERVER:   1 << 3,
    ADMIN:           1 << 30,
    SEND_MESSAGES:   0x800,
    READ_HISTORY:    0x400,
    EMBED_LINKS:     0x4000,
  },
}));

import request from 'supertest';
import express from 'express';
const jwt     = require('jsonwebtoken');

import router from '../routes/bots';

const app = express();
app.use(express.json());
// bots routes use both /api/servers/:sid/bots and /api/bot/... and /api/webhooks/...
app.use('/api/servers', router);
app.use('/api/bot', router);
app.use('/api/webhooks', router);
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

function token(id) {
  return jwt.sign({ id, username: 'owner', displayName: 'Owner', v: 0 }, 'test-jwt-secret', { expiresIn: '1h' });
}

const OWNER_ID  = 'owner1';
const OTHER_ID  = 'other1';
const SERVER_ID = 'srv1';

beforeAll(async () => {
  await mockDb.users.insert(makeUser({ _id: OWNER_ID, username: 'owner' }));
  await mockDb.users.insert(makeUser({ _id: OTHER_ID, username: 'other' }));
  await mockDb.servers.insert(makeServer(OWNER_ID, { _id: SERVER_ID }));
  await mockDb.members.insert({ userId: OWNER_ID, serverId: SERVER_ID, roles: '[]', joinedAt: Date.now() });
  await mockDb.members.insert({ userId: OTHER_ID, serverId: SERVER_ID, roles: '[]', joinedAt: Date.now() });
});

let createdBotId;
let createdBotToken;

// ── Create bot ────────────────────────────────────────────────

describe('POST /api/servers/:sid/bots', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await request(app).post(`/api/servers/${SERVER_ID}/bots`).send({ name: 'TestBot' });
    expect(res.status).toBe(401);
  });

  it('rejects missing bot name', async () => {
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/bots`)
      .set('Authorization', `Bearer ${token(OWNER_ID)}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name required/i);
  });

  it('rejects non-members (403)', async () => {
    mockResolvePermissions.mockResolvedValueOnce(0);
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/bots`)
      .set('Authorization', `Bearer ${token(OTHER_ID)}`)
      .send({ name: 'UnauthorizedBot' });
    expect(res.status).toBe(403);
  });

  it('creates a bot and returns a one-time token', async () => {
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/bots`)
      .set('Authorization', `Bearer ${token(OWNER_ID)}`)
      .send({ name: 'MyBot', description: 'A test bot' });

    expect(res.status).toBe(201);
    expect(res.body.bot._id).toBeDefined();
    expect(res.body.token).toMatch(/^brg_bot_/);
    expect(res.body.warning).toMatch(/not be shown again/i);

    createdBotId    = res.body.bot._id;
    createdBotToken = res.body.token;
  });
});

// ── List bots ─────────────────────────────────────────────────

describe('GET /api/servers/:sid/bots', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get(`/api/servers/${SERVER_ID}/bots`);
    expect(res.status).toBe(401);
  });

  it('returns bot list (no tokenHash exposed)', async () => {
    const res = await request(app)
      .get(`/api/servers/${SERVER_ID}/bots`)
      .set('Authorization', `Bearer ${token(OWNER_ID)}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // tokenHash must not be exposed to clients
    res.body.forEach(bot => {
      expect(bot.tokenHash).toBeUndefined();
    });
  });
});

// ── Token rotate ──────────────────────────────────────────────

describe('POST /api/servers/:sid/bots/:botId/token', () => {
  it('rejects when permission check fails', async () => {
    mockResolvePermissions.mockResolvedValueOnce(0);
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/bots/${createdBotId}/token`)
      .set('Authorization', `Bearer ${token(OTHER_ID)}`);
    expect(res.status).toBe(403);
  });

  it('rotates the token and returns a new one', async () => {
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/bots/${createdBotId}/token`)
      .set('Authorization', `Bearer ${token(OWNER_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^brg_bot_/);
    expect(res.body.token).not.toBe(createdBotToken);
    expect(res.body.warning).toMatch(/previous token/i);
  });
});

// ── Delete bot ────────────────────────────────────────────────

describe('DELETE /api/servers/:sid/bots/:botId', () => {
  it('rejects when permission check fails', async () => {
    mockResolvePermissions.mockResolvedValueOnce(0);
    const res = await request(app)
      .delete(`/api/servers/${SERVER_ID}/bots/${createdBotId}`)
      .set('Authorization', `Bearer ${token(OTHER_ID)}`);
    expect(res.status).toBe(403);
  });

  it('soft-deletes the bot', async () => {
    const res = await request(app)
      .delete(`/api/servers/${SERVER_ID}/bots/${createdBotId}`)
      .set('Authorization', `Bearer ${token(OWNER_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });
});

// ── Webhook endpoint ──────────────────────────────────────────

describe('POST /api/webhooks/:webhookId', () => {
  it('returns 400 for an empty payload', async () => {
    const res = await request(app).post('/api/webhooks/nonexistent').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/content|embeds/i);
  });

  it('returns 401 for an unknown webhook', async () => {
    const res = await request(app)
      .post('/api/webhooks/doesnotexist')
      .send({ content: 'Hello' });
    expect(res.status).toBe(401);
  });
});
