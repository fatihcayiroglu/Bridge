// server/tests/semantic-coverage.test.ts
// Sprint 110: semantic.ts coverage artırımı — edge case'ler, AI fallback, cache path
// Hedef: routes/semantic.ts satır coverage %70 → %80

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
}));
jest.mock('../lib/aiProvider', () => ({
  callAI:     jest.fn().mockResolvedValue(null),
  AI_ENABLED: false,
}));

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
const db  = require('../db/loader');
const jwt = require('jsonwebtoken');
import { authMiddleware } from '../middleware/auth';
import semanticRouter from '../routes/semantic';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/semantic', authMiddleware, semanticRouter);
  return app;
}
function tok(uid: string) {
  return jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

describe('Semantic — coverage artırımı', () => {
  let app: ReturnType<typeof express>;
  let userId: string;
  let serverId: string;
  let channelId: string;
  let token: string;

  beforeEach(async () => {
    db._reset?.();
    app       = buildApp();
    userId    = uuidv4();
    serverId  = uuidv4();
    channelId = uuidv4();
    token     = tok(userId);

    await db.users.insert({ _id: userId, username: 'u1', displayName: 'User1', tokenVersion: 0 });
    await db.servers.insert({ _id: serverId, name: 'S1', ownerId: userId });
    await db.members.insert({ userId, serverId, roles: [] });
    await db.channels.insert({ _id: channelId, serverId, name: 'general', type: 'text' });

    for (let i = 0; i < 15; i++) {
      await db.messages.insert({
        _id:       uuidv4(),
        channelId, userId,
        content:   `Sprint ${i} karar: önemli teknik seçim yapıldı`,
        createdAt: Date.now() - i * 3_600_000,
      });
    }
  });

  // ── POST /search — keyword fallback (AI disabled) ────────────────────────

  describe('POST /search — keyword fallback dalları', () => {
    it('keyword search matches relevant messages', async () => {
      const res = await request(app)
        .post('/api/semantic/search')
        .set('Authorization', `Bearer ${token}`)
        .send({ query: 'karar teknik', serverId, limit: 5 });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.matches)).toBe(true);
    });

    it('respects custom limit', async () => {
      const res = await request(app)
        .post('/api/semantic/search')
        .set('Authorization', `Bearer ${token}`)
        .send({ query: 'sprint', serverId, limit: 3 });
      expect(res.status).toBe(200);
      expect(res.body.matches.length).toBeLessThanOrEqual(3);
    });

    it('default limit applies when not specified', async () => {
      const res = await request(app)
        .post('/api/semantic/search')
        .set('Authorization', `Bearer ${token}`)
        .send({ query: 'karar', serverId });
      expect(res.status).toBe(200);
    });

    it('returns empty matches for unmatched query', async () => {
      const res = await request(app)
        .post('/api/semantic/search')
        .set('Authorization', `Bearer ${token}`)
        .send({ query: 'xyz_no_match_12345', serverId });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.matches)).toBe(true);
    });

    it('handles server with no messages gracefully', async () => {
      const emptySid = uuidv4();
      await db.servers.insert({ _id: emptySid, name: 'Empty', ownerId: userId });
      await db.members.insert({ userId, serverId: emptySid, roles: [] });
      const res = await request(app)
        .post('/api/semantic/search')
        .set('Authorization', `Bearer ${token}`)
        .send({ query: 'anything', serverId: emptySid });
      expect(res.status).toBe(200);
      expect(res.body.matches).toEqual([]);
    });

    it('uses cached result when available', async () => {
      const { cache } = require('../lib/redisAdapter');
      const cached = JSON.stringify({ matches: [{ _id: 'cached-id', content: 'cached' }] });
      cache.get.mockResolvedValueOnce(cached);
      const res = await request(app)
        .post('/api/semantic/search')
        .set('Authorization', `Bearer ${token}`)
        .send({ query: 'karar', serverId });
      expect(res.status).toBe(200);
    });
  });

  // ── GET /digest/:serverId ────────────────────────────────────────────────

  describe('GET /digest/:serverId', () => {
    it('returns digest for server owner', async () => {
      const res = await request(app)
        .get(`/api/semantic/digest/${serverId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('channelStats');
    });

    it('includes period range in digest', async () => {
      const res = await request(app)
        .get(`/api/semantic/digest/${serverId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('period');
    });

    it('returns 403 for non-member', async () => {
      const other = uuidv4();
      await db.users.insert({ _id: other, username: 'other', displayName: 'Other', tokenVersion: 0 });
      const res = await request(app)
        .get(`/api/semantic/digest/${serverId}`)
        .set('Authorization', `Bearer ${tok(other)}`);
      expect([403, 404]).toContain(res.status);
    });

    it('handles server with no messages in past week', async () => {
      const sid2 = uuidv4();
      await db.servers.insert({ _id: sid2, name: 'Empty', ownerId: userId });
      await db.members.insert({ userId, serverId: sid2, roles: [] });
      const res = await request(app)
        .get(`/api/semantic/digest/${sid2}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it('uses cache when digest is cached', async () => {
      const { cache } = require('../lib/redisAdapter');
      cache.get.mockResolvedValueOnce(JSON.stringify({ channelStats: [], period: {} }));
      const res = await request(app)
        .get(`/api/semantic/digest/${serverId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });
  });

  // ── GET /engagement/:serverId ────────────────────────────────────────────

  describe('GET /engagement/:serverId', () => {
    it('returns engagement metrics for member', async () => {
      const res = await request(app)
        .get(`/api/semantic/engagement/${serverId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('periods');
    });

    it('includes trend field', async () => {
      const res = await request(app)
        .get(`/api/semantic/engagement/${serverId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('trend');
    });

    it('returns 403 for non-member', async () => {
      const other = uuidv4();
      await db.users.insert({ _id: other, username: 'other2', displayName: 'Other2', tokenVersion: 0 });
      const res = await request(app)
        .get(`/api/semantic/engagement/${serverId}`)
        .set('Authorization', `Bearer ${tok(other)}`);
      expect([403, 404]).toContain(res.status);
    });

    it('uses cached engagement when available', async () => {
      const { cache } = require('../lib/redisAdapter');
      cache.get.mockResolvedValueOnce(JSON.stringify({ periods: [], trend: 'stable' }));
      const res = await request(app)
        .get(`/api/semantic/engagement/${serverId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it('handles server with one member gracefully', async () => {
      const sid3 = uuidv4();
      await db.servers.insert({ _id: sid3, name: 'Small', ownerId: userId });
      await db.members.insert({ userId, serverId: sid3, roles: [] });
      const res = await request(app)
        .get(`/api/semantic/engagement/${sid3}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });
  });
});
