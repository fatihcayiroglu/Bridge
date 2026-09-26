// server/tests/auth-input-boundaries.test.ts
//
// ============================================================================
// /api/auth - GIRIS DOGRULAMASI VE PROFIL ALAN SINIRLARI
// ============================================================================
// `auth.test.ts` mutlu yollari ve oturum yasam dongusunu olcer. Bu dosya
// REDDETME siniri olcer, cunku her reddetme bir guvenlik ya da veri
// butunlugu karari tasir:
//
// · KULLANICI ADI bir KIMLIKTIR. Uzunluk ve karakter kumesi serbest
//   birakilirsa gorsel olarak ayirt edilemeyen hesaplar (homograf), asiri
//   uzun degerler ve depolama/gosterim kusurlari dogar.
// · PAROLA alt siniri bir guvenlik esigidir; UST siniri ise bir DoS
//   korumasidir - bcrypt girdi uzunluguyla pahalilasir.
// · PROFIL alanlari KULLANICI metnidir ve KIRPILIR. Kirpilmazsa uye
//   listesini ve profil kartini bozan sinirsiz metin saklanir.
// · `bannerUrl` ve `badge` KULLANICI TARAFINDAN YAZILAMAZ. Birincisi
//   depolamanin sahipligindedir, ikincisi sistem/yonetici atamasidir -
//   yazilabilir olsaydi herkes kendine rozet takardi.
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

// -- Testler ---------------------------------------------------

const jwtLib = require('jsonwebtoken');

/** Kayitli bir kullanici olusturur ve jetonunu dondurur. */
async function register(username: string, password = 'securepass123') {
  const res = await request(app).post('/api/register').send({ username, password });
  expect(res.status).toBe(200);
  return { token: res.body.token as string, user: res.body.user as Record<string, unknown> };
}

const authed = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('registration refuses an unusable identity', () => {
  it.each([
    ['no body at all', {}, /required/i],
    ['only a username', { username: 'solo' }, /required/i],
    ['only a password', { password: 'securepass123' }, /required/i],
  ])('rejects %s', async (_label, payload, message) => {
    const res = await request(app).post('/api/register').send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
  });

  it.each([
    ['a two-character username', 'ab'],
    ['a 33-character username', 'a'.repeat(33)],
  ])('rejects %s', async (_label, username) => {
    const res = await request(app).post('/api/register').send({ username, password: 'securepass123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at (least 3|most 32) characters/i);
  });

  it.each([
    ['a space', 'kotu ad'],
    ['punctuation', 'kotu.ad'],
    ['a dash', 'kotu-ad'],
    ['a non-ASCII letter', 'kullanici\u00e7'],
  ])('rejects a username containing %s', async (_label, username) => {
    const res = await request(app).post('/api/register').send({ username, password: 'securepass123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid format|letters, numbers and underscores/i);
  });

  it('accepts the documented character set at both length bounds', async () => {
    await register('abc');
    await register('a'.repeat(32));
    await register('with_underscore_9');
  });

  it('rejects a password over the hashing bound', async () => {
    // bcrypt girdi uzunluguyla pahalilasir; ust sinir bir DoS korumasidir.
    const res = await request(app)
      .post('/api/register')
      .send({ username: 'uzunparola', password: 'x'.repeat(129) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at most 128 characters|max 128/i);
  });
});

describe('login refuses an incomplete credential pair', () => {
  it.each([
    ['nothing', {}],
    ['only a username', { username: 'birisi' }],
    ['only a password', { password: 'securepass123' }],
  ])('rejects %s', async (_label, payload) => {
    const res = await request(app).post('/api/login').send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });
});

describe('refresh refuses a token it cannot use', () => {
  it.each([
    ['an absent token', {}],
    ['a non-string token', { refreshToken: 42 }],
    ['an empty token', { refreshToken: '' }],
  ])('rejects %s', async (_label, payload) => {
    const res = await request(app).post('/api/refresh').send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/refreshToken/i);
  });
});

describe('password change validates before it touches the hash', () => {
  it.each([
    ['neither field', {}],
    ['only the current password', { currentPassword: 'securepass123' }],
    ['only the new password', { newPassword: 'yenisifre123' }],
  ])('rejects %s', async (_label, payload) => {
    const { token } = await register('sifredegis1');
    const res = await request(app).post('/api/change-password').set(authed(token)).send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('rejects a new password below the security floor', async () => {
    const { token } = await register('sifredegis2');
    const res = await request(app).post('/api/change-password').set(authed(token))
      .send({ currentPassword: 'securepass123', newPassword: 'kisa' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/8 characters/i);
  });

  it('rejects a new password above the hashing bound', async () => {
    const { token } = await register('sifredegis3');
    const res = await request(app).post('/api/change-password').set(authed(token))
      .send({ currentPassword: 'securepass123', newPassword: 'x'.repeat(129) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at most 128 characters|max 128/i);
  });

  it('refuses a token whose account no longer exists', async () => {
    const { token, user } = await register('kaybolan');
    await _db.users.remove({ _id: user._id });
    const res = await request(app).post('/api/change-password').set(authed(token))
      .send({ currentPassword: 'securepass123', newPassword: 'yenisifre123' });
    // Hesap yoksa jeton da gecersizdir: kimlik katmani ONCE reddeder.
    expect(res.status).toBe(401);
  });
});

describe('profile updates bound every user-supplied field', () => {
  it('rejects an array body, which carries no field names', async () => {
    // NOT: `null` / cikplak sayi gibi govdeler daha ERKEN, `express.json`
    // katı (strict) ayristiricisinda reddedilir ve buraya hic ULASMAZ.
    // Rotanin kendi kontrolu, gecerli JSON olan ama NESNE OLMAYAN govde
    // icindir - dizi tam olarak o durumdur.
    const { token } = await register('profildizi');
    const res = await request(app).patch('/api/me').set(authed(token))
      .set('Content-Type', 'application/json')
      .send('[]');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be an object/i);
  });

  it('rejects an update that carries nothing recognisable', async () => {
    const { token } = await register('profil2');
    const res = await request(app).patch('/api/me').set(authed(token)).send({ bilinmeyen: 'alan' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Nothing to update/i);
  });

  it('truncates every free-text field to its documented bound', async () => {
    const { token, user } = await register('profil3');
    const res = await request(app).patch('/api/me').set(authed(token)).send({
      bio: 'b'.repeat(500),
      website: 'w'.repeat(500),
      location: 'l'.repeat(500),
      pronouns: 'p'.repeat(500),
    });
    expect(res.status).toBe(200);

    const stored = await _db.users.findOne({ _id: user._id });
    // Sinirsiz metin uye listesini ve profil kartini bozardi.
    expect(stored.bio).toHaveLength(180);
    expect(stored.website).toHaveLength(120);
    expect(stored.location).toHaveLength(60);
    expect(stored.pronouns).toHaveLength(40);
  });

  it('trims surrounding whitespace before storing', async () => {
    const { token, user } = await register('profil4');
    await request(app).patch('/api/me').set(authed(token)).send({ bio: '   bosluklu   ' });
    const stored = await _db.users.findOne({ _id: user._id });
    expect(stored.bio).toBe('bosluklu');
  });

  it.each([
    ['#abc', true],
    ['#abcd', true],
    ['#aabbcc', true],
    ['#aabbccdd', true],
    ['mavi', false],
    ['#ggg', false],
    ['#12345', false],
  ])('accepts banner colour %s = %s', async (bannerColor, accepted) => {
    const { token, user } = await register(`renk${bannerColor.replace(/[^a-z0-9]/gi, '')}`);
    const res = await request(app).patch('/api/me').set(authed(token)).send({ bannerColor });
    if (accepted) {
      expect(res.status).toBe(200);
      const stored = await _db.users.findOne({ _id: user._id });
      expect(stored.bannerColor).toBe(bannerColor);
    } else {
      // Taninmayan renk bir GUNCELLEME degildir; baska alan da yoksa 400.
      expect(res.status).toBe(400);
    }
  });

  it.each([
    ['status', 'parlak'],
    ['presenceVisibility', 'belki'],
    ['dmPrivacy', 'herkesbelki'],
  ])('ignores an unrecognised %s value', async (field, value) => {
    const { token } = await register(`enum${field.toLowerCase()}`);
    const res = await request(app).patch('/api/me').set(authed(token)).send({ [field]: value });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Nothing to update/i);
  });

  it.each([['online'], ['idle'], ['dnd'], ['offline']])('accepts the %s status', async (status) => {
    const { token, user } = await register(`durum${status}`);
    const res = await request(app).patch('/api/me').set(authed(token)).send({ status });
    expect(res.status).toBe(200);
    const stored = await _db.users.findOne({ _id: user._id });
    expect(stored.status).toBe(status);
  });

  it('refuses to let a client write a banner URL it does not own', async () => {
    const { token } = await register('afis1');
    const res = await request(app).patch('/api/me').set(authed(token))
      .send({ bannerUrl: 'https://saldirgan.test/afis.png' });
    // Depolama sahipligi istemciye devredilemez.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/storage-owned/i);
  });

  it('allows an explicit banner removal', async () => {
    const { token, user } = await register('afis2');
    const res = await request(app).patch('/api/me').set(authed(token)).send({ bannerUrl: null });
    expect(res.status).toBe(200);
    const stored = await _db.users.findOne({ _id: user._id });
    expect(stored.bannerUrl ?? null).toBeNull();
  });

  it('never lets a user award themselves a badge', async () => {
    const { token, user } = await register('rozet1');
    const res = await request(app).patch('/api/me').set(authed(token))
      .send({ badge: 'kurucu', bio: 'gecerli' });
    expect(res.status).toBe(200);
    const stored = await _db.users.findOne({ _id: user._id });
    // Rozet SISTEM atamasidir; istekten gelen deger yok sayilir.
    expect(stored.badge ?? null).not.toBe('kurucu');
  });

  it('rejects a display name that sanitises down to nothing', async () => {
    const { token } = await register('adtemiz');
    const res = await request(app).patch('/api/me').set(authed(token)).send({ displayName: '   ' });
    expect(res.status).toBe(400);
  });
});
