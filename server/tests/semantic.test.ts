// server/tests/semantic.test.ts
// FIX: route response shape uyumlu hale getirildi
//   - POST /search  → res.body.matches  (was: results)
//   - GET  /digest  → res.body.channelStats  (was: activeChannels)
//   - GET  /engagement → res.body.periods + trend  (was: score)
process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
const db      = require('../db/loader');
const jwt     = require('jsonwebtoken');
import { authMiddleware } from '../middleware/auth';
import semanticRouter from '../routes/semantic';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/semantic', authMiddleware, semanticRouter);
  return app;
}
function tok(uid: string) { return jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

describe('Semantic Routes', () => {
  let app: express.Express;
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

    await db.users.insert({ _id: userId, username: 'u1', displayName: 'User1', tokenVersion: 0, status: 'online' });
    await db.servers.insert({ _id: serverId, name: 'S1', ownerId: userId });
    await db.members.insert({ userId, serverId, roles: [] });
    await db.channels.insert({ _id: channelId, serverId, name: 'general', type: 'text' });
    for (let i = 0; i < 10; i++) {
      await db.messages.insert({
        _id: uuidv4(), channelId, userId,
        content: `Important decision number ${i} about the project`,
        createdAt: Date.now() - i * 60_000,
      });
    }
  });

  describe('POST /api/semantic/search', () => {
    it('returns 400 without query', async () => {
      const res = await request(app)
        .post('/api/semantic/search')
        .set('Authorization', `Bearer ${token}`)
        .send({ serverId });
      expect(res.status).toBe(400);
    });

    it('returns 400 without serverId', async () => {
      const res = await request(app)
        .post('/api/semantic/search')
        .set('Authorization', `Bearer ${token}`)
        .send({ query: 'test' });
      expect(res.status).toBe(400);
    });

    it('returns 403 for non-member', async () => {
      const other = uuidv4();
      await db.users.insert({ _id: other, username: 'other', displayName: 'Other', tokenVersion: 0 });
      const res = await request(app)
        .post('/api/semantic/search')
        .set('Authorization', `Bearer ${tok(other)}`)
        .send({ query: 'decisions', serverId });
      expect([403, 404]).toContain(res.status);
    });

    // FIX: route returns `matches`, not `results`
    it('returns matches array for member with valid query', async () => {
      const res = await request(app)
        .post('/api/semantic/search')
        .set('Authorization', `Bearer ${token}`)
        .send({ query: 'important decisions', serverId });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('matches');
      expect(Array.isArray(res.body.matches)).toBe(true);
    });

    it('includes expected top-level fields', async () => {
      const res = await request(app)
        .post('/api/semantic/search')
        .set('Authorization', `Bearer ${token}`)
        .send({ query: 'decision', serverId });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('query');
      expect(res.body).toHaveProperty('provider');
      expect(res.body).toHaveProperty('total');
      expect(res.body).toHaveProperty('days');
    });

    it('honors the requested result limit', async () => {
      const res = await request(app)
        .post('/api/semantic/search')
        .set('Authorization', `Bearer ${token}`)
        .send({ query: 'decision', serverId, limit: 3 });
      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(3);
      expect(res.body.matches.length).toBeLessThanOrEqual(3);
    });

    it.each([
      ['negative limit', { limit: -1 }],
      ['fractional limit', { limit: 1.5 }],
      ['string limit', { limit: '3' }],
      ['unsafe limit', { limit: Number.MAX_SAFE_INTEGER + 1 }],
      ['zero days', { days: 0 }],
      ['fractional days', { days: 1.2 }],
      ['string days', { days: '7' }],
    ])('rejects malformed numeric body input: %s', async (_label, patch) => {
      const res = await request(app)
        .post('/api/semantic/search')
        .set('Authorization', `Bearer ${token}`)
        .send({ query: 'decision', serverId, ...patch });
      expect(res.status).toBe(400);
    });

    it('keeps result limit in the semantic cache key', async () => {
      const first = await request(app).post('/api/semantic/search')
        .set('Authorization', `Bearer ${token}`)
        .send({ query: 'decision', serverId, limit: 8 });
      const second = await request(app).post('/api/semantic/search')
        .set('Authorization', `Bearer ${token}`)
        .send({ query: 'decision', serverId, limit: 2 });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.limit).toBe(2);
      expect(second.body.matches.length).toBeLessThanOrEqual(2);
    });

    it('total matches matches.length', async () => {
      const res = await request(app)
        .post('/api/semantic/search')
        .set('Authorization', `Bearer ${token}`)
        .send({ query: 'number', serverId });
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(res.body.matches.length);
    });

    it('each match has required fields', async () => {
      const res = await request(app)
        .post('/api/semantic/search')
        .set('Authorization', `Bearer ${token}`)
        .send({ query: 'project', serverId });
      expect(res.status).toBe(200);
      if (res.body.matches.length > 0) {
        const m = res.body.matches[0];
        expect(m).toHaveProperty('_id');
        expect(m).toHaveProperty('content');
        expect(m).toHaveProperty('userId');
        expect(m).toHaveProperty('channelId');
        expect(m).toHaveProperty('createdAt');
      }
    });
  });

  describe('GET /api/semantic/digest/:serverId', () => {
    it('returns 403 for non-member', async () => {
      const other = uuidv4();
      await db.users.insert({ _id: other, username: 'x', displayName: 'X', tokenVersion: 0 });
      const res = await request(app)
        .get(`/api/semantic/digest/${serverId}`)
        .set('Authorization', `Bearer ${tok(other)}`);
      expect([403, 404]).toContain(res.status);
    });

    // FIX: route returns `channelStats`, not `activeChannels`
    it('returns channelStats array for member', async () => {
      const res = await request(app)
        .get(`/api/semantic/digest/${serverId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('channelStats');
      expect(Array.isArray(res.body.channelStats)).toBe(true);
    });

    it('includes totalMessages and topUsers', async () => {
      const res = await request(app)
        .get(`/api/semantic/digest/${serverId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('totalMessages');
      expect(res.body).toHaveProperty('topUsers');
      expect(res.body).toHaveProperty('generatedAt');
    });

    it('respects days query param', async () => {
      const res = await request(app)
        .get(`/api/semantic/digest/${serverId}?days=14`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.days).toBe(14);
    });

    it.each(['-1', '1.5', '7x', '9007199254740992'])('rejects malformed digest days=%s', async (days) => {
      const res = await request(app)
        .get(`/api/semantic/digest/${serverId}?days=${days}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/semantic/engagement/:serverId', () => {
    // FIX: route returns `periods` + `trend`, not a flat `score`
    it('returns engagement periods array for member', async () => {
      const res = await request(app)
        .get(`/api/semantic/engagement/${serverId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('periods');
      expect(Array.isArray(res.body.periods)).toBe(true);
    });

    it('includes trend direction and peakHour', async () => {
      const res = await request(app)
        .get(`/api/semantic/engagement/${serverId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('trend');
      expect(res.body.trend).toHaveProperty('pct');
      expect(res.body.trend).toHaveProperty('direction');
      expect(['up', 'down', 'stable']).toContain(res.body.trend.direction);
      expect(res.body).toHaveProperty('peakHour');
      expect(res.body).toHaveProperty('peakHourFormatted');
    });

    it('returns 3 period entries (7/14/30 days)', async () => {
      const res = await request(app)
        .get(`/api/semantic/engagement/${serverId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.periods).toHaveLength(3);
    });

    it('each period has required numeric fields', async () => {
      const res = await request(app)
        .get(`/api/semantic/engagement/${serverId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      res.body.periods.forEach((p: Record<string, unknown>) => {
        expect(p).toHaveProperty('days');
        expect(p).toHaveProperty('messages');
        expect(p).toHaveProperty('activeUsers');
        expect(p).toHaveProperty('totalMembers');
        expect(p).toHaveProperty('engagementPct');
        expect(typeof p.engagementPct).toBe('number');
      });
    });

    it('returns 403 for non-member', async () => {
      const other = uuidv4();
      await db.users.insert({ _id: other, username: 'z', displayName: 'Z', tokenVersion: 0 });
      const res = await request(app)
        .get(`/api/semantic/engagement/${serverId}`)
        .set('Authorization', `Bearer ${tok(other)}`);
      expect([403, 404]).toContain(res.status);
    });
  });

  it('rejects unauthenticated', async () => {
    const res = await request(app).post('/api/semantic/search').send({ query: 'test', serverId });
    expect(res.status).toBe(401);
  });
});
