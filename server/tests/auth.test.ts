// server/tests/auth.test.ts
// Tests for auth routes: register, login, refresh, logout, PATCH /me
//
// DIKKAT: bu baslik eskiden "change-password, logout-all" da iddia ediyordu
// ama o ucler icin BU DOSYADA tek bir test YOKTU — kapsama da bunu
// dogruladi (routes/auth.ts 367-393 ve 407-415 tamamen kapsanmamisti).
// Var olmayan bir guvenceyi bildiren basliktan daha yaniltici az sey vardir.
// O uclerin gercek testleri: tests/auth-session-lifecycle.test.ts
// Sprint 50: JS → TypeScript dönüşümü

import { setCookiesOf } from './helpers/httpDoubles';
import request from 'supertest';
import express, { Express, Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';

process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV       = 'test';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createMockDb } = require('./helpers/mockDb');
import { requireDoc } from './helpers/mockDb';

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
  claimRegistrationSlot:          jest.fn().mockResolvedValue(true),
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

beforeEach(() => { _db._reset?.(); });

// ────────────────────────────────────────────────────────────────────────────
describe('POST /api/register', () => {
  it('registers a new user', async () => {
    const res = await request(app)
      .post('/api/register')
      .send({ username: 'testuser', password: 'securepass123' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body.user.username).toBe('testuser');
    // P7 B2: the password was just set — level-1 step-up grants, one per scope.
    expect(res.body.stepUp).toEqual(expect.objectContaining({ level: 1, method: 'password' }));
    expect(Object.keys(res.body.stepUp.grants)).toHaveLength(4);
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

  it('does not strand a durable account when initial refresh-session persistence fails', async () => {
    const insert = jest.spyOn(_db.refreshTokens, 'insert')
      .mockRejectedValueOnce(new Error('refresh store down'));
    try {
      const res = await request(app)
        .post('/api/register')
        .send({ username: 'partialaccount', password: 'securepass123' });

      expect(res.status).toBe(500);
      expect(await _db.users.findOne({ username: 'partialaccount' })).toBeNull();
    } finally {
      insert.mockRestore();
    }
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
    // P7 B2: a fresh password sign-in carries level-1 grants, each valid for one scope only.
    expect(res.body.stepUp).toEqual(expect.objectContaining({ level: 1, method: 'password', ttlMs: 600_000 }));
    expect(Object.keys(res.body.stepUp.grants).sort())
      .toEqual(['account-security', 'destructive-admin', 'moderation-burst', 'sensitive-export']);
  });

  it('[SECURITY] 2FA-enabled password login cannot mint a session before second factor', async () => {
    const stored = await _db.users.findOne({ username: 'testuser' });
    await _db.users.update({ _id: stored._id }, { $set: {
      twoFactorEnabled: true,
      twoFactorSecret: 'JBSWY3DPEHPK3PXP',
      twoFactorBackup: [],
    } });

    const res = await request(app).post('/api/login').send({ username: 'testuser', password: 'securepass123' });
    expect(res.status).toBe(202);
    expect(res.body.requiresTwoFactor).toBe(true);
    expect(typeof res.body.tempToken).toBe('string');
    expect(res.body).not.toHaveProperty('token');
    expect(res.body).not.toHaveProperty('refreshToken');
    // Nor a step-up grant: the password alone is not this account's sign-in strength.
    expect(res.body).not.toHaveProperty('stepUp');
    const cookies = setCookiesOf(res.headers);
    expect(cookies.some((value) => value.startsWith('bridge_refresh='))).toBe(false);
    expect(cookies.some((value) => value.startsWith('bridge_media='))).toBe(false);
  });

  it('email verification policy blocks a correct password until verification', async () => {
    const saved = process.env.REQUIRE_EMAIL_VERIFICATION;
    process.env.REQUIRE_EMAIL_VERIFICATION = 'true';
    try {
      const res = await request(app).post('/api/login').send({ username: 'testuser', password: 'securepass123' });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('EMAIL_NOT_VERIFIED');
      expect(res.body).not.toHaveProperty('token');
    } finally {
      if (saved === undefined) delete process.env.REQUIRE_EMAIL_VERIFICATION;
      else process.env.REQUIRE_EMAIL_VERIFICATION = saved;
    }
  });

  it('şüpheli-giriş advisory kontrolü çökse bile geçerli login tamamlanır', async () => {
    const captchaMock = require('../lib/captcha');
    captchaMock.checkSuspiciousLogin.mockRejectedValueOnce(new Error('advisory unavailable'));
    const res = await request(app).post('/api/login').send({ username: 'testuser', password: 'securepass123' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    await new Promise(resolve => setImmediate(resolve));
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

describe('PATCH /api/me — privacy preferences', () => {
  // ── NEDEN AYRI ZAMAN AŞIMI ────────────────────────────────────────────────
  // Bu test GERÇEK kayıt + giriş akışını çalıştırır; `routes/auth.ts` parolaları
  // bcrypt cost 12 ile hash'ler (üretim için DOĞRU değer, DÜŞÜRÜLMEZ). Tek
  // başına ~saniyeler sürer, ancak `jest --coverage` altında enstrümantasyon
  // maliyetiyle 10 sn'lik genel sınırı aşıyordu:
  //
  //     thrown: "Exceeded timeout of 10000 ms for a test."
  //
  // Bu bir ÜRÜN arızası değil, ölçüm modunun maliyetidir — kapsamsız koşuda ve
  // tek başına çalıştırıldığında geçer. İddialar DEĞİŞMEDİ; yalnızca bu testin
  // bütçesi gerçekçi hâle getirildi. Alternatif (bcrypt maliyetini testte
  // düşürmek) üretim yolundan sapma yaratacağı için seçilmedi.
  it('DM ve presence tercihlerini sunucu truth olarak kalıcılaştırır', async () => {
    const registered = await request(app)
      .post('/api/register')
      .send({ username: 'privacyuser', password: 'securepass123' });
    const token = registered.body.token;

    const updated = await request(app)
      .patch('/api/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ dmPrivacy: 'friends', presenceVisibility: 'hidden' });
    expect(updated.status).toBe(200);
    expect(updated.body.dmPrivacy).toBe('friends');
    expect(updated.body.presenceVisibility).toBe('hidden');

    const me = await request(app).get('/api/me').set('Authorization', `Bearer ${token}`);
    expect(me.body.dmPrivacy).toBe('friends');
    expect(me.body.presenceVisibility).toBe('hidden');
  }, 30_000);

  it('malformed profile payload 500 üretmez ve storage-owned bannerUrl enjekte edilemez', async () => {
    const registered = await request(app)
      .post('/api/register')
      .send({ username: 'profilecontract', password: 'securepass123' });
    const auth = { Authorization: `Bearer ${registered.body.token}` };

    for (const body of [
      { displayName: 123 },
      { displayName: { trim: 'not-a-function' } },
      { bannerUrl: '/uploads/banners/forged.png' },
      { bannerColor: '#12345' },
    ]) {
      const res = await request(app).patch('/api/me').set(auth).send(body);
      expect(res.status).toBe(400);
    }

    const clear = await request(app).patch('/api/me').set(auth).send({ bannerUrl: null });
    expect(clear.status).toBe(200);
    expect(clear.body.bannerUrl).toBeNull();
  }, 30_000);

  it('geçersiz privacy enumlarını sessiz başarıyla kabul etmez', async () => {
    const registered = await request(app)
      .post('/api/register')
      .send({ username: 'privacybad', password: 'securepass123' });
    const res = await request(app)
      .patch('/api/me')
      .set('Authorization', `Bearer ${registered.body.token}`)
      .send({ dmPrivacy: 'contacts', presenceVisibility: 'sometimes' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Nothing to update/i);
  });
});

describe('POST /api/refresh', () => {
  let refreshToken: string;

  beforeEach(async () => {
    await request(app).post('/api/register').send({ username: 'testuser', password: 'securepass123' });
    const res = await request(app).post('/api/login').send({ username: 'testuser', password: 'securepass123' });
    // refreshToken now set via httpOnly cookie — read from Set-Cookie header
    const cookies = setCookiesOf(res.headers);
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

  it.each([{ refreshToken: {} }, { refreshToken: 123 }, { refreshToken: 'x'.repeat(513) }])('rejects malformed refreshToken body %#', async (body) => {
    const res = await request(app).post('/api/refresh').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });
});

describe('POST /api/logout', () => {
  it('clears both the refresh and path-scoped media cookies', async () => {
    const res = await request(app).post('/api/logout').redirects(1).send({});
    const cookies = setCookiesOf(res.headers);

    expect(res.status).toBe(200);
    expect(cookies.some((value) => /bridge_refresh=;.*Path=\/api\/refresh/i.test(value))).toBe(true);
    expect(cookies.some((value) => /bridge_media=;.*Path=\/uploads/i.test(value))).toBe(true);
  });

  it('[SECURITY] browser path-scoped cookie is revoked server-side through the logout redirect', async () => {
    const agent = request.agent(app);
    await agent.post('/api/register').send({ username: 'logoutuser', password: 'securepass123' });
    const login = await agent.post('/api/login').send({ username: 'logoutuser', password: 'securepass123' });
    const rawSetCookie = setCookiesOf(login.headers);
    const refreshCookie = rawSetCookie.find((value) => value.startsWith('bridge_refresh='));
    expect(refreshCookie).toBeTruthy();

    const logout = await agent.post('/api/logout').redirects(1).send({});
    expect(logout.status).toBe(200);

    // Negative control: even if the old secret was copied before logout, the
    // server-side row is gone and replay cannot mint a new access token.
    const replay = await request(app).post('/api/refresh').set('Cookie', refreshCookie!).send({});
    expect(replay.status).toBe(401);
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
