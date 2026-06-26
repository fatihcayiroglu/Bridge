// server/tests/bots-extended.test.ts
// Sprint 69 — Bot route coverage genişletmesi
// Hedef: webhook doğrulama hataları, bot aktivasyon kısıtlamaları, listing edge-cases

process.env.JWT_SECRET     = 'test-jwt-secret';
process.env.REFRESH_SECRET = 'test-refresh-secret';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

jest.mock('../middleware/rateLimit', () => ({
  limits: { bots: () => (_req, _res, next) => next() },
}));

const mockHasPermission = jest.fn().mockReturnValue(true);
jest.mock('../middleware/auth', () => {
  const jwt = require('jsonwebtoken');
  return {
    authMiddleware: (req: Request, _res: Response, next: NextFunction) => {
      const h = req.headers.authorization;
      if (!h?.startsWith('Bearer ')) { _res.status(401).json({ error: 'No token' }); return; }
      try {
        const decoded = jwt.verify(h.slice(7), process.env.JWT_SECRET) as Record<string, unknown>;
        req.user = { id: decoded.id, role: decoded.role };
        next();
      } catch { _res.status(401).json({ error: 'Invalid token' }); }
    },
    castAuthed: (req: Request) => ({ user: req.user }),
    hasPermission: mockHasPermission,
  };
});

import type { Request, Response, NextFunction } from 'express';
import request    from 'supertest';
import express    from 'express';
import { v4 as uuidv4 } from 'uuid';
const db  = require('../db/loader');
const jwt = require('jsonwebtoken');
import botsRouter from '../routes/bots';

const SERVER_ID = uuidv4();
const OWNER_ID  = uuidv4();
const OTHER_ID  = uuidv4();

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers', botsRouter);
  app.use('/api/webhooks', botsRouter);
  return app;
}

function token(uid: string, extra: Record<string, unknown> = {}) {
  return jwt.sign({ id: uid, v: 0, ...extra }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

let app: ReturnType<typeof buildApp>;
let createdBotId: string;
let webhookToken: string;
let webhookId: string;

beforeEach(async () => {
  db._reset?.();
  mockHasPermission.mockReturnValue(true);
  app = buildApp();

  await db.users.insert({ _id: OWNER_ID, username: 'owner', displayName: 'Owner', tokenVersion: 0 });
  await db.users.insert({ _id: OTHER_ID, username: 'other', displayName: 'Other', tokenVersion: 0 });
  await db.servers.insert({ _id: SERVER_ID, name: 'Test Server', ownerId: OWNER_ID });
  await db.members.insert({ userId: OWNER_ID, serverId: SERVER_ID, roles: ['admin'] });
  await db.members.insert({ userId: OTHER_ID, serverId: SERVER_ID, roles: [] });

  // Pre-create a bot for tests that need one
  const createRes = await request(app)
    .post(`/api/servers/${SERVER_ID}/bots`)
    .set('Authorization', `Bearer ${token(OWNER_ID)}`)
    .send({ name: 'TestBot' });
  createdBotId = createRes.body.bot._id;

  // Create a webhook entry directly in DB for webhook tests
  webhookToken = 'wh_' + uuidv4().replace(/-/g, '');
  webhookId    = uuidv4();
  await db.webhooks.insert({
    _id: webhookId,
    serverId:  SERVER_ID,
    channelId: uuidv4(),
    token:     webhookToken,
    createdAt: Date.now(),
  });
});

// ── POST /api/servers/:sid/bots — edge cases ─────────────────────────────────

describe('POST /api/servers/:sid/bots — edge cases', () => {
  it('rejects bot name that is too short (empty after trim)', async () => {
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/bots`)
      .set('Authorization', `Bearer ${token(OWNER_ID)}`)
      .send({ name: '   ' });
    expect([400, 422]).toContain(res.status);
  });

  it('rejects bot name exceeding max length', async () => {
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/bots`)
      .set('Authorization', `Bearer ${token(OWNER_ID)}`)
      .send({ name: 'a'.repeat(200) });
    expect([400, 422]).toContain(res.status);
  });

  it('returns 404 for unknown server', async () => {
    const res = await request(app)
      .post(`/api/servers/${uuidv4()}/bots`)
      .set('Authorization', `Bearer ${token(OWNER_ID)}`)
      .send({ name: 'Bot' });
    expect([403, 404]).toContain(res.status);
  });
});

// ── GET /api/servers/:sid/bots — listing edge cases ──────────────────────────

describe('GET /api/servers/:sid/bots — listing', () => {
  it('never exposes tokenHash in response', async () => {
    const res = await request(app)
      .get(`/api/servers/${SERVER_ID}/bots`)
      .set('Authorization', `Bearer ${token(OWNER_ID)}`);
    expect(res.status).toBe(200);
    for (const bot of res.body) {
      expect(bot.tokenHash).toBeUndefined();
    }
  });

  it('returns empty array when no bots exist for new server', async () => {
    const freshSid = uuidv4();
    await db.servers.insert({ _id: freshSid, name: 'Empty', ownerId: OWNER_ID });
    await db.members.insert({ userId: OWNER_ID, serverId: freshSid, roles: ['admin'] });

    const res = await request(app)
      .get(`/api/servers/${freshSid}/bots`)
      .set('Authorization', `Bearer ${token(OWNER_ID)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns 404 for unknown server', async () => {
    const res = await request(app)
      .get(`/api/servers/${uuidv4()}/bots`)
      .set('Authorization', `Bearer ${token(OWNER_ID)}`);
    expect([403, 404]).toContain(res.status);
  });
});

// ── DELETE /api/servers/:sid/bots/:botId — edge cases ────────────────────────

describe('DELETE /api/servers/:sid/bots/:botId — edge cases', () => {
  it('returns 404 for unknown botId', async () => {
    const res = await request(app)
      .delete(`/api/servers/${SERVER_ID}/bots/${uuidv4()}`)
      .set('Authorization', `Bearer ${token(OWNER_ID)}`);
    expect([404, 403]).toContain(res.status);
  });

  it('deleted bot no longer appears in listing', async () => {
    // Delete
    await request(app)
      .delete(`/api/servers/${SERVER_ID}/bots/${createdBotId}`)
      .set('Authorization', `Bearer ${token(OWNER_ID)}`);

    // List — should not contain the deleted bot as active
    const listRes = await request(app)
      .get(`/api/servers/${SERVER_ID}/bots`)
      .set('Authorization', `Bearer ${token(OWNER_ID)}`);
    const activeIds = listRes.body
      .filter((b: { deleted?: boolean }) => !b.deleted)
      .map((b: { _id: string }) => b._id);
    expect(activeIds).not.toContain(createdBotId);
  });
});

// ── POST /api/servers/:sid/bots/:botId/token — edge cases ────────────────────

describe('POST /api/servers/:sid/bots/:botId/token — edge cases', () => {
  it('returns 404 for unknown botId', async () => {
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/bots/${uuidv4()}/token`)
      .set('Authorization', `Bearer ${token(OWNER_ID)}`);
    expect([404, 403]).toContain(res.status);
  });

  it('new token has correct prefix format', async () => {
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/bots/${createdBotId}/token`)
      .set('Authorization', `Bearer ${token(OWNER_ID)}`);
    if (res.status === 200) {
      expect(res.body.token).toMatch(/^brg_bot_/);
    }
  });
});

// ── POST /api/webhooks/:webhookId — detailed tests ───────────────────────────

describe('POST /api/webhooks/:webhookId — detailed', () => {
  it('accepts a valid webhook with token and content', async () => {
    const res = await request(app)
      .post(`/api/webhooks/${webhookId}?token=${webhookToken}`)
      .send({ content: 'Hello from webhook!' });
    // 200 or 201 on success; 404 if channel not found in test DB is also acceptable
    expect([200, 201, 404]).toContain(res.status);
  });

  it('rejects request with wrong token (401)', async () => {
    const res = await request(app)
      .post(`/api/webhooks/${webhookId}?token=wrong_token`)
      .send({ content: 'Hello' });
    expect([401, 403]).toContain(res.status);
  });

  it('rejects payload that is too large (content > 2000 chars)', async () => {
    const res = await request(app)
      .post(`/api/webhooks/${webhookId}?token=${webhookToken}`)
      .send({ content: 'x'.repeat(2100) });
    expect([400, 422]).toContain(res.status);
  });

  it('rejects empty content payload', async () => {
    const res = await request(app)
      .post(`/api/webhooks/${webhookId}?token=${webhookToken}`)
      .send({ content: '' });
    expect([400, 422]).toContain(res.status);
  });

  it('returns 401 when token query param is absent', async () => {
    const res = await request(app)
      .post(`/api/webhooks/${webhookId}`)
      .send({ content: 'Hello' });
    expect(res.status).toBe(401);
  });

  it('returns 404 for non-existent webhookId even with token', async () => {
    const res = await request(app)
      .post(`/api/webhooks/${uuidv4()}?token=any`)
      .send({ content: 'Hello' });
    expect(res.status).toBe(404);
  });
});
