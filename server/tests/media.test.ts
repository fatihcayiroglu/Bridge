// server/tests/media.test.ts
import { installFetchMock, uninstallFetchMock } from './helpers/fetchDouble';
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
import mediaRouter from '../routes/media';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/media', authMiddleware, mediaRouter);
  return app;
}
function tok(uid: string, v = 0) { return jwt.sign({ id: uid, v }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

describe('Media Routes', () => {
  let app: express.Express;
  let userId: string;
  let userToken: string;

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
      installFetchMock().mockResolvedValue({ json: () => Promise.resolve({ results: [] }) });
      const res = await request(app)
        .get('/api/media/gif/search')
        .set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(400);
      // `globalThis.fetch` ZORUNLU bir uyedir; `delete` istege bagli
      // olmayan bir uyede calismaz. Ikiz yardimciyla kaldirilir.
      uninstallFetchMock();
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

describe('Media translation runtime input boundary', () => {
  let app: ReturnType<typeof buildApp>;
  let userId: string;
  let userToken: string;

  beforeEach(async () => {
    db._reset?.();
    app = buildApp();
    userId = uuidv4();
    userToken = tok(userId);
    await db.users.insert({ _id: userId, username: 'boundary-user', displayName: 'Boundary User', tokenVersion: 0 });
  });
  it.each([
    [{ q: 7 }, /q required/i],
    [{ q: 'hello', source: {} }, /source\/target/i],
    [{ q: 'hello', target: 'tr\nignore-all' }, /source\/target/i],
    [{ q: 'hello', source: 'english' }, /source\/target/i],
  ])('rejects malformed translation body %p before any upstream fetch', async (body, error) => {
    process.env.LIBRETRANSLATE_URL = 'http://localhost:5000';
    const hadFetch = Object.prototype.hasOwnProperty.call(globalThis, 'fetch');
    const fetchHolder = globalThis as typeof globalThis & { fetch?: typeof fetch };
    const previousFetch = fetchHolder.fetch;
    const fetchSpy = jest.fn().mockRejectedValue(new Error('must not fetch'));
    Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: fetchSpy });
    try {
      const res = await request(app)
        .post('/api/media/translate')
        .set('Authorization', `Bearer ${userToken}`)
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(error);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      if (hadFetch) Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: previousFetch });
      else Reflect.deleteProperty(fetchHolder, 'fetch');
      delete process.env.LIBRETRANSLATE_URL;
    }
  });
});
