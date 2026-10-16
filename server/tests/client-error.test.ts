// server/tests/client-error.test.ts
import type { JwtPayload } from '../middleware/auth';
import { makeJwtUser } from './helpers/userDoubles';
import type { Request, Response, NextFunction } from 'express';
process.env.NODE_ENV = 'test';

jest.mock('../middleware/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../middleware/auth', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  castAuthed: (req: Request) => req,
}));

jest.mock('../lib/adminAuthority', () => ({
  databaseAdminOnly: (req: Request, res: Response, next: NextFunction) => req.user?.isAdmin === true
    ? next()
    : res.status(403).json({ error: 'Admin only' }),
}));

// Mock redis adapter used by client-error.js for stats persistence
jest.mock('../lib/redisAdapter', () => ({
  cache: {
    // Gercek adaptorde MEVCUT (lib/redisAdapter.ts) — mock'ta eksikti ve
    // `invalidateChannelMessages` her cagrida sessizce TypeError firlatiyordu.
    invalidatePattern: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(true),
  },
}));

import request from 'supertest';
import express from 'express';

function buildApp(userOverride?: Partial<JwtPayload> & { id: string }) {
  const app = express();
  app.use(express.json());
  if (userOverride !== undefined) {
    app.use((req: Request, _res: Response, next: NextFunction) => { req.user = makeJwtUser(userOverride.id, userOverride); next(); });
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

  it('rejects non-string type instead of coercing it into an aggregation key', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/client-error').send({
      ...VALID_REPORT, type: { injected: true },
    });
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

  it('B3: excludes IP, user id, user-agent, URL and client-selected timestamp', async () => {
    const app = buildApp({ id: 'b3-specific-user-id', isAdmin: true });
    const res = await request(app).post('/api/client-error').send({
      type: 'manual', message: 'b3-report-marker', source: 'ui',
      userAgent: 'B3-private-device-string', url: '/secret?token=B3-query-secret',
      lang: 'tr', timestamp: 9999999999999,
    });
    expect(res.status).toBe(204);
    const stats = await request(app).get('/api/client-error/stats');
    expect(stats.status).toBe(200);
    const report = stats.body.recent.find((x: { message?: string }) => x.message === 'b3-report-marker');
    expect(report).toBeDefined();
    expect(report).toEqual(expect.objectContaining({
      type: 'manual', message: 'b3-report-marker', receivedAt: expect.any(Number),
    }));
    for (const forbidden of ['ip', 'userId', 'userAgent', 'url', 'lang', 'timestamp']) {
      expect(report).not.toHaveProperty(forbidden);
    }
    expect(JSON.stringify(report)).not.toMatch(/B3-private-device-string|B3-query-secret|b3-specific-user-id/);
    expect(report.receivedAt).toBeLessThan(9999999999999);
  });

  it('B3: does not persist or log arbitrary URL/path source and bounds line/col fields', async () => {
    const app = buildApp({ id: 'admin1', isAdmin: true });
    const marker = 'B3-source-allowlist-report';
    const res = await request(app).post('/api/client-error').send({
      type: 'manual', message: marker,
      source: 'https://service.example/debug.js?token=B3-source-private-token',
      line: 'Infinity', col: -500,
    });
    expect(res.status).toBe(204);
    const stats = await request(app).get('/api/client-error/stats');
    expect(stats.status).toBe(200);
    const report = stats.body.recent.find((x: { message?: string }) => x.message === marker);
    expect(report).toEqual(expect.objectContaining({
      source: 'other', line: 0, col: 0,
    }));
    expect(JSON.stringify(report)).not.toMatch(/service\\.example|B3-source-private-token|debug\\.js/);
  });

  it('B3: retains allowlisted diagnostic categories and finite integer positions', async () => {
    const app = buildApp({ id: 'admin1', isAdmin: true });
    const marker = 'B3-safe-source-position-report';
    const res = await request(app).post('/api/client-error').send({
      type: 'manual', message: marker, source: 'ui', line: '21', col: 8,
    });
    expect(res.status).toBe(204);
    const stats = await request(app).get('/api/client-error/stats');
    const report = stats.body.recent.find((x: { message?: string }) => x.message === marker);
    expect(report).toEqual(expect.objectContaining({
      source: 'ui', line: 21, col: 8,
    }));
  });

  it('B3: expires individual recent entries after 24h even if reports keep arriving', async () => {
    const app = buildApp({ id: 'admin1', isAdmin: true });
    const dateSpy = jest.spyOn(Date, 'now');
    const t0 = 1_750_000_000_000;
    try {
      dateSpy.mockReturnValue(t0);
      expect((await request(app).post('/api/client-error').send({ type: 'manual', message: 'B3-old-entry' })).status).toBe(204);
      dateSpy.mockReturnValue(t0 + 24 * 60 * 60 * 1000 + 1);
      expect((await request(app).post('/api/client-error').send({ type: 'manual', message: 'B3-new-entry' })).status).toBe(204);
      const res = await request(app).get('/api/client-error/stats');
      expect(res.status).toBe(200);
      expect(res.body.recent.some((e: { message?: string }) => e.message === 'B3-old-entry')).toBe(false);
      expect(res.body.recent.some((e: { message?: string }) => e.message === 'B3-new-entry')).toBe(true);
    } finally {
      dateSpy.mockRestore();
    }
  });
});

