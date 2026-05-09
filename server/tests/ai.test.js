// server/tests/ai.test.js
process.env.JWT_SECRET     = 'test-jwt-secret';
process.env.REFRESH_SECRET = 'test-refresh-secret';
process.env.NODE_ENV       = 'test';

const { createMockDb, makeUser, makeServer, makeMember, makeChannel, makeMessages } = require('./helpers/mockDb');

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

const request    = require('supertest');
const express    = require('express');
const { v4: uuidv4 } = require('uuid');
const db         = require('../db/loader');
const aiRouter   = require('../routes/ai');
const { authMiddleware } = require('../middleware/auth');
const jwt        = require('jsonwebtoken');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/ai', authMiddleware, aiRouter);
  return app;
}

function makeToken(userId) {
  return jwt.sign({ id: userId, v: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

describe('AI Routes', () => {
  let app, userId, serverId, channelId, token;

  beforeEach(async () => {
    db._reset?.();
    app       = buildApp();
    userId    = uuidv4();
    serverId  = uuidv4();
    channelId = uuidv4();
    token     = makeToken(userId);

    await db.users.insert({ _id: userId, username: 'testuser', displayName: 'Test', avatarColor: '#fff', tokenVersion: 0, status: 'online' });
    await db.servers.insert({ _id: serverId, name: 'Test Server', ownerId: userId });
    await db.members.insert({ userId, serverId, roles: [] });
    await db.channels.insert({ _id: channelId, serverId, name: 'general', type: 'text' });
    // Insert some messages for summarize/translate tests
    for (let i = 0; i < 5; i++) {
      await db.messages.insert({ _id: uuidv4(), channelId, userId, content: `Test message ${i}`, createdAt: Date.now() - i * 1000 });
    }
  });

  // ── /api/ai/summarize ────────────────────────────────────
  describe('POST /api/ai/summarize', () => {
    it('returns 400 without channelId', async () => {
      const res = await request(app)
        .post('/api/ai/summarize')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it('returns 403 if not a server member', async () => {
      const outsider = uuidv4();
      await db.users.insert({ _id: outsider, username: 'out', displayName: 'Out', tokenVersion: 0 });
      const outToken = makeToken(outsider);
      const res = await request(app)
        .post('/api/ai/summarize')
        .set('Authorization', `Bearer ${outToken}`)
        .send({ channelId });
      expect([403, 404]).toContain(res.status);
    });

    it('responds with summary structure when member', async () => {
      const res = await request(app)
        .post('/api/ai/summarize')
        .set('Authorization', `Bearer ${token}`)
        .send({ channelId, limit: 5 });
      // AI key olmayabilir — fallback keyword summary dönmeli (200 veya 200 with fallback)
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('summary');
    });
  });

  // ── /api/ai/translate ────────────────────────────────────
  describe('POST /api/ai/translate', () => {
    it('returns 400 without text', async () => {
      const res = await request(app)
        .post('/api/ai/translate')
        .set('Authorization', `Bearer ${token}`)
        .send({ targetLang: 'tr' });
      expect(res.status).toBe(400);
    });

    it('returns 400 without targetLang', async () => {
      const res = await request(app)
        .post('/api/ai/translate')
        .set('Authorization', `Bearer ${token}`)
        .send({ text: 'Hello world' });
      expect(res.status).toBe(400);
    });

    it('returns translation or fallback', async () => {
      const res = await request(app)
        .post('/api/ai/translate')
        .set('Authorization', `Bearer ${token}`)
        .send({ text: 'Hello world', targetLang: 'tr' });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('translation');
    });
  });

  // ── /api/ai/reply-suggestion ─────────────────────────────
  describe('POST /api/ai/reply-suggestion', () => {
    it('returns 400 without messageId', async () => {
      const res = await request(app)
        .post('/api/ai/reply-suggestion')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it('returns suggestions for valid message', async () => {
      const msgs = await db.messages.find({ channelId });
      const msgId = msgs[0]?._id;
      if (!msgId) return; // skip if no messages
      const res = await request(app)
        .post('/api/ai/reply-suggestion')
        .set('Authorization', `Bearer ${token}`)
        .send({ messageId: msgId, channelId });
      expect([200, 404]).toContain(res.status);
    });
  });

  // ── /api/ai/moderate ────────────────────────────────────
  describe('POST /api/ai/moderate', () => {
    it('returns 400 without content', async () => {
      const res = await request(app)
        .post('/api/ai/moderate')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it('returns moderation result for clean content', async () => {
      const res = await request(app)
        .post('/api/ai/moderate')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Hello, how are you today?' });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('safe');
    });
  });

  // ── Auth guard ───────────────────────────────────────────
  it('rejects unauthenticated requests', async () => {
    const res = await request(app).post('/api/ai/summarize').send({ channelId });
    expect(res.status).toBe(401);
  });
});
