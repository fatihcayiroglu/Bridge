// server/tests/media.test.ts
process.env.JWT_SECRET     = 'test-jwt-secret';
process.env.REFRESH_SECRET = 'test-refresh-secret';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
const db      = require('../db/loader');
const jwt     = require('jsonwebtoken');
import { authMiddleware } from '../middleware/auth';
import mediaRouter from '../routes/media';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/media', authMiddleware, mediaRouter);
  return app;
}
function tok(uid, v = 0) { return jwt.sign({ id: uid, v }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

describe('Media Routes', () => {
  let app, userId, userToken;

  beforeEach(async () => {
    db._reset?.();
    app       = buildApp();
    userId    = uuidv4();
    userToken = tok(userId);
    await db.users.insert({ _id: userId, username: 'alice', displayName: 'Alice', tokenVersion: 0 });
    // Clear env keys to ensure predictable "not configured" behaviour
    delete process.env.TENOR_API_KEY;
    delete process.env.LIBRETRANSLATE_URL;
  });

  describe('GET /api/media/gif/trending', () => {
    it('returns 503 when TENOR_API_KEY is not configured', async () => {
      const res = await request(app)
        .get('/api/media/gif/trending')
        .set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/not configured/i);
    });

    it('rejects unauthenticated requests', async () => {
      const res = await request(app).get('/api/media/gif/trending');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/media/gif/search', () => {
    it('returns 503 when TENOR_API_KEY is not configured', async () => {
      const res = await request(app)
        .get('/api/media/gif/search?q=cat')
        .set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(503);
    });

    it('returns 400 when q is missing and key is set', async () => {
      process.env.TENOR_API_KEY = 'fake-key';
      // We mock fetch to avoid actual network call
      global.fetch = jest.fn().mockResolvedValue({ json: () => Promise.resolve({ results: [] }) });
      const res = await request(app)
        .get('/api/media/gif/search')
        .set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(400);
      delete global.fetch;
      delete process.env.TENOR_API_KEY;
    });

    it('rejects unauthenticated requests', async () => {
      const res = await request(app).get('/api/media/gif/search?q=dog');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/media/translate', () => {
    it('returns 503 when LIBRETRANSLATE_URL is not configured', async () => {
      const res = await request(app)
        .post('/api/media/translate')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ q: 'hello', source: 'en', target: 'tr' });
      expect(res.status).toBe(503);
    });

    it('returns 400 when q is empty', async () => {
      process.env.LIBRETRANSLATE_URL = 'http://localhost:5000';
      const res = await request(app)
        .post('/api/media/translate')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ q: '   ' });
      expect(res.status).toBe(400);
      delete process.env.LIBRETRANSLATE_URL;
    });

    it('rejects unauthenticated requests', async () => {
      const res = await request(app)
        .post('/api/media/translate')
        .send({ q: 'hello' });
      expect(res.status).toBe(401);
    });
  });
});
