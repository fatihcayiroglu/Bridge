// server/tests/auth.test.ts
// Tests for auth routes: register, login, refresh, change-password, logout-all
// Sprint 50: JS → TypeScript dönüşümü

import request from 'supertest';
import express, { Express, Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';

process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV       = 'test';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createMockDb } = require('./helpers/mockDb');

const _db = createMockDb();

jest.mock('../db/loader', () => _db);
jest.mock('../db/index',  () => _db);

jest.mock('../lib/captcha', () => ({
  botFilterMiddleware:            () => (_req: Request, _res: Response, next: NextFunction) => next(),
  loginLockMiddleware:            (_req: Request, _res: Response, next: NextFunction) => next(),
  progressiveCaptchaMiddleware:   (_req: Request, _res: Response, next: NextFunction) => next(),
  captchaMiddleware:              (_req: Request, _res: Response, next: NextFunction) => next(),
  registrationThrottleMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
  recordFailedLogin:              jest.fn().mockResolvedValue(undefined),
  recordSuccessfulLogin:          jest.fn().mockResolvedValue(undefined),
  checkSuspiciousLogin:           jest.fn().mockResolvedValue(undefined),
  recordRegistration:             jest.fn().mockResolvedValue(undefined),
  _getIp:                         () => '127.0.0.1',
  GENERIC_LOGIN_ERROR:            'Invalid username or password',
}));

jest.mock('../middleware/rateLimit', () => ({
  rateLimit: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  limits: new Proxy({}, { get: () => () => (_req: Request, _res: Response, next: NextFunction) => next() }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { router } = require('../routes/auth');

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api', router);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) =>
    res.status(500).json({ error: err.message }),
  );
  return app;
}

const app = buildApp();

beforeEach(() => { _db._reset(); });

// ────────────────────────────────────────────────────────────────────────────
describe('POST /api/register', () => {
  it('registers a new user', async () => {
    const res = await request(app)
      .post('/api/register')
      .send({ username: 'testuser', password: 'securepass123' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body.user.username).toBe('testuser');
  });

  it('rejects duplicate username', async () => {
    await request(app).post('/api/register').send({ username: 'testuser', password: 'securepass123' });
    const res = await request(app).post('/api/register').send({ username: 'testuser', password: 'anotherpass123' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/taken/i);
  });

  it('rejects short password', async () => {
    const res = await request(app).post('/api/register').send({ username: 'newuser2', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/8 characters/i);
  });

  it('rejects invalid username characters', async () => {
    const res = await request(app).post('/api/register').send({ username: 'bad user!', password: 'goodpassword' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/login', () => {
  beforeEach(async () => {
    await request(app).post('/api/register').send({ username: 'testuser', password: 'securepass123' });
  });

  it('logs in with correct credentials', async () => {
    const res = await request(app).post('/api/login').send({ username: 'testuser', password: 'securepass123' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
  });

  it('rejects wrong password', async () => {
    const res = await request(app).post('/api/login').send({ username: 'testuser', password: 'wrongpassword' });
    expect(res.status).toBe(401);
  });

  it('rejects non-existent user', async () => {
    const res = await request(app).post('/api/login').send({ username: 'nobody', password: 'anything' });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/refresh', () => {
  let refreshToken: string;

  beforeEach(async () => {
    await request(app).post('/api/register').send({ username: 'testuser', password: 'securepass123' });
    const res = await request(app).post('/api/login').send({ username: 'testuser', password: 'securepass123' });
    // refreshToken now set via httpOnly cookie — read from Set-Cookie header
    const cookies: string[] = res.headers['set-cookie'] ?? [];
    refreshToken = cookies.find((c: string) => c.includes('bridge_refresh')) ?? '';
  });

  it('returns new token pair', async () => {
    const res = await request(app).post('/api/refresh').set('Cookie', refreshToken).send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
  });

  it('rejects already-used refresh token (rotation)', async () => {
    const first = await request(app).post('/api/refresh').set('Cookie', refreshToken).send({});
    expect(first.status).toBe(200);

    const second = await request(app).post('/api/refresh').set('Cookie', refreshToken).send({});
    expect(second.status).toBe(401);
  });

  it('rejects invalid token', async () => {
    const res = await request(app).post('/api/refresh').set('Cookie', 'bridge_refresh=invalid').send({});
    expect(res.status).toBe(401);
  });

  it('rejects missing refreshToken body', async () => {
    const res = await request(app).post('/api/refresh').send({});
    expect(res.status).toBe(400);
  });
});

// ── startAuthCleanup — Sprint 62 ─────────────────────────────────────────────
describe('startAuthCleanup()', () => {
  beforeEach(() => {
    // Her testte idempotent guard'ı sıfırla
    const { _resetAuthCleanupForTest } = require('../middleware/auth');
    _resetAuthCleanupForTest();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('setInterval kaydeder (saatlik temizlik)', () => {
    const spy = jest.spyOn(global, 'setInterval');
    const { startAuthCleanup } = require('../middleware/auth');
    startAuthCleanup();
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 5 * 60 * 1000);
  });

  it('idempotent — iki kez çağrılırsa tek interval açılır', () => {
    const spy = jest.spyOn(global, 'setInterval');
    const { startAuthCleanup } = require('../middleware/auth');
    startAuthCleanup();
    startAuthCleanup();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('stopAuthCleanup intervali temizler ve yeniden başlatmaya izin verir', () => {
    jest.clearAllMocks();
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
    const { startAuthCleanup, stopAuthCleanup } = require('../middleware/auth');

    startAuthCleanup();
    const timer = setIntervalSpy.mock.results[0]?.value;

    stopAuthCleanup();
    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);

    startAuthCleanup();
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
  });

  it('module import edildiğinde otomatik başlamaz', () => {
    const spy = jest.spyOn(global, 'setInterval');
    require('../middleware/auth'); // sadece import — startAuthCleanup çağrılmıyor
    expect(spy).not.toHaveBeenCalled();
  });
});
