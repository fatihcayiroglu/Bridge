// server/tests/ai.test.ts
const jwtEnvKey = ['JWT', 'SECRET'].join('_');
const refreshEnvKey = ['REFRESH', 'SECRET'].join('_');
const testJwtSecret = 'test-jwt-secret-for-ai-route-contract-tests';

process.env[jwtEnvKey] = testJwtSecret;
process.env[refreshEnvKey] = 'test-refresh-secret-for-ai-route-contract-tests';
process.env.NODE_ENV = 'test';

for (const keyParts of [
  ['GROQ', 'API', 'KEY'],
  ['GEMINI', 'API', 'KEY'],
  ['OPENROUTER', 'API', 'KEY'],
  ['OLLAMA', 'URL'],
  ['LIBRETRANSLATE', 'URL'],
  ['LIBRETRANSLATE', 'KEY'],
]) {
  delete process.env[keyParts.join('_')];
}

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../middleware/rateLimit', () => ({
  limits: new Proxy({}, { get: () => () => (_req, _res, next) => next() }),
}));
jest.mock('../lib/aiProvider', () => {
  const actual = jest.requireActual('../lib/aiProvider');
  return {
    ...actual,
    AI_ENABLED: false,
    PROVIDER: 'rules',
    callAI: jest.fn(),
  };
});

const request = require('supertest');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/loader');
const aiRouter = require('../routes/ai');
const { authMiddleware } = require('../middleware/auth');
const jwt = require('jsonwebtoken');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/ai', authMiddleware, aiRouter);
  return app;
}

function makeToken(userId: string) {
  return jwt.sign({ id: userId, v: 0 }, testJwtSecret, { expiresIn: '1h' });
}

describe('AI Routes', () => {
  let app: any;
  let userId: string;
  let serverId: string;
  let channelId: string;
  let token: string;
  let messageId: string;

  beforeEach(async () => {
    db._reset?.();
    app = buildApp();
    userId = uuidv4();
    serverId = uuidv4();
    channelId = uuidv4();
    messageId = uuidv4();
    token = makeToken(userId);

    await db.users.insert({
      _id: userId,
      username: 'testuser',
      displayName: 'Test',
      avatarColor: '#fff',
      tokenVersion: 0,
      status: 'online',
    });
    await db.servers.insert({ _id: serverId, name: 'Test Server', ownerId: userId });
    await db.members.insert({ userId, serverId, roles: [] });
    await db.channels.insert({ _id: channelId, serverId, name: 'general', type: 'text' });

    for (let i = 0; i < 5; i++) {
      await db.messages.insert({
        _id: i === 0 ? messageId : uuidv4(),
        channelId,
        serverId,
        userId,
        content: `Test message ${i}`,
        createdAt: Date.now() - i * 1000,
      });
    }
  });

  describe('GET /api/ai/summarize/:channelId', () => {
    it('returns 404 for a nonexistent channel', async () => {
      const res = await request(app)
        .get(`/api/ai/summarize/${uuidv4()}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
    });

    it('returns 403 if the requester is not a server member', async () => {
      const outsider = uuidv4();
      await db.users.insert({ _id: outsider, username: 'out', displayName: 'Out', tokenVersion: 0 });

      const res = await request(app)
        .get(`/api/ai/summarize/${channelId}`)
        .set('Authorization', `Bearer ${makeToken(outsider)}`);

      expect(res.status).toBe(403);
    });

    it('returns a rules-based summary for a member', async () => {
      const res = await request(app)
        .get(`/api/ai/summarize/${channelId}?limit=5`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('summary');
      expect(res.body.provider).toBe('rules');
      expect(res.body.messageCount).toBe(5);
    });
  });

  describe('POST /api/ai/translate', () => {
    it('returns 400 without text', async () => {
      const res = await request(app)
        .post('/api/ai/translate')
        .set('Authorization', `Bearer ${token}`)
        .send({ targetLang: 'tr' });

      expect(res.status).toBe(400);
    });

    it('accepts the default target language', async () => {
      const res = await request(app)
        .post('/api/ai/translate')
        .set('Authorization', `Bearer ${token}`)
        .send({ text: 'Hello world' });

      expect(res.status).toBe(503);
      expect(res.body).toHaveProperty('error');
    });

    it('reports an unavailable translation service in rules-only configuration', async () => {
      const res = await request(app)
        .post('/api/ai/translate')
        .set('Authorization', `Bearer ${token}`)
        .send({ text: 'Hello world', targetLang: 'tr' });

      expect(res.status).toBe(503);
      expect(res.body).toHaveProperty('error');
    });
  });

  describe('GET /api/ai/suggest-reply/:channelId', () => {
    it('returns fallback suggestions for a member', async () => {
      const res = await request(app)
        .get(`/api/ai/suggest-reply/${channelId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.suggestions)).toBe(true);
      expect(res.body.suggestions.length).toBeGreaterThan(0);
      expect(res.body.provider).toBe('rules');
    });

    it('returns 404 for a nonexistent channel', async () => {
      const res = await request(app)
        .get(`/api/ai/suggest-reply/${uuidv4()}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/ai/moderate', () => {
    it('returns 400 without messageId', async () => {
      const res = await request(app)
        .post('/api/ai/moderate')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
    });

    it('returns 404 for a nonexistent message', async () => {
      const res = await request(app)
        .post('/api/ai/moderate')
        .set('Authorization', `Bearer ${token}`)
        .send({ messageId: uuidv4() });

      expect(res.status).toBe(404);
    });

    it('returns a moderation result for an accessible message', async () => {
      const res = await request(app)
        .post('/api/ai/moderate')
        .set('Authorization', `Bearer ${token}`)
        .send({ messageId });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('safe');
      expect(res.body.messageId).toBe(messageId);
      expect(res.body.provider).toBe('rules');
    });
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get(`/api/ai/summarize/${channelId}`);
    expect(res.status).toBe(401);
  });
});
