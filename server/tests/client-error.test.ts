// server/tests/client-error.test.ts
process.env.NODE_ENV = 'test';

jest.mock('../middleware/rateLimit', () => ({
  rateLimit: () => (_req, _res, next) => next(),
}));

// Mock redis adapter used by client-error.js for stats persistence
jest.mock('../lib/redisAdapter', () => ({
  cache: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(true),
  },
}));

import request from 'supertest';
import express from 'express';

function buildApp(userOverride) {
  const app = express();
  app.use(express.json());
  if (userOverride !== undefined) {
    app.use((req, _res, next) => { req.user = userOverride; next(); });
  }
  app.use('/api/client-error', require('../routes/client-error'));
  return app;
}

const VALID_REPORT = {
  type: 'manual', message: 'Test error', source: 'ui',
  line: 10, col: 2, stack: 'Error\n  at foo', url: '/', userAgent: 'jest', lang: 'tr',
};

describe('POST /api/client-error', () => {
  it('returns 400 for body missing message field', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/client-error').send({ notMessage: true });
    expect(res.status).toBe(400);
  });

  it('returns 400 when message is not a string', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/client-error').send({ message: 12345 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when message exceeds 2000 characters', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/client-error')
      .send({ ...VALID_REPORT, message: 'x'.repeat(2001) });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid type value', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/client-error')
      .send({ ...VALID_REPORT, type: 'invalid-type-xyz' });
    expect(res.status).toBe(400);
  });

  it('returns 204 for a valid full report', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/client-error').send(VALID_REPORT);
    expect(res.status).toBe(204);
  });

  it('returns 204 for report with only message (minimal valid)', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/client-error')
      .send({ message: 'Something went wrong' });
    expect(res.status).toBe(204);
  });

  it('accepts all valid type values', async () => {
    const validTypes = ['uncaught', 'unhandledrejection', 'resource', 'manual', 'crash'];
    const app = buildApp();
    for (const type of validTypes) {
      const res = await request(app)
        .post('/api/client-error')
        .send({ ...VALID_REPORT, type });
      expect(res.status).toBe(204);
    }
  });

  it('accepts report without optional type field', async () => {
    const app = buildApp();
    const { type, ...noType } = VALID_REPORT;
    const res = await request(app).post('/api/client-error').send(noType);
    expect(res.status).toBe(204);
  });
});

describe('GET /api/client-error/stats', () => {
  it('returns 403 when req.user is not set', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/client-error/stats');
    expect(res.status).toBe(403);
  });

  it('returns 403 for non-admin user', async () => {
    const app = buildApp({ id: 'user1', isAdmin: false });
    const res = await request(app).get('/api/client-error/stats');
    expect(res.status).toBe(403);
  });

  it('returns 200 with stats for admin user', async () => {
    const app = buildApp({ id: 'admin1', isAdmin: true });
    const res = await request(app).get('/api/client-error/stats');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('recent');
  });

  it('stats.recent is an array', async () => {
    const app = buildApp({ id: 'admin1', isAdmin: true });
    const res = await request(app).get('/api/client-error/stats');
    expect(Array.isArray(res.body.recent)).toBe(true);
  });

  it('stats.total is a number', async () => {
    const app = buildApp({ id: 'admin1', isAdmin: true });
    const res = await request(app).get('/api/client-error/stats');
    expect(typeof res.body.total).toBe('number');
  });
});

