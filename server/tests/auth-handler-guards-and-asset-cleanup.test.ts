// server/tests/auth-handler-guards-and-asset-cleanup.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// AUTH — İŞLEYİCİNİN KENDİ KORUMALARI VE PROFİL DOSYASI TEMİZLİĞİ
// ════════════════════════════════════════════════════════════════════════════
//
// Kayıt/parola uçlarında iki savunma katmanı vardır: şema doğrulaması
// (`validateBody`) ve İŞLEYİCİNİN KENDİ denetimleri. Diğer testler şema
// katmanından geçemediği için ikinci katman HİÇ ÇALIŞTIRILMAMIŞTI — yani
// kimse gerçekten çalıştığını ölçmemişti. Şema bir gün gevşetilir ya da uç
// başka bir yerden monte edilirse, ölçülmemiş katman tek savunma olur.
//
// Bu dosya şema katmanını KASITLI olarak geçirir ve işleyicinin kendi
// kararlarını ölçer. Ayrıca profil varlığı (avatar/banner) temizliğini ölçer:
//
//   · Eski dosya YALNIZCA artık hiçbir mesajdan referans verilmiyorsa silinir.
//   · Referans sorgusu belirsizse dosya KORUNUR (fail-closed) ve loglanır —
//     sarkan bir satır, kaybolmuş bir görselden iyidir.
//   · Depoya ait olmayan (harici) bir adres için hiç dosya işlemi yapılmaz.

import request from 'supertest';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { requireDoc } from './helpers/mockDb';
import { TINY_PNG } from './helpers/tinyImages';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-auth-guards-'));
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV = 'test';
process.env.BRIDGE_UPLOAD_ROOT = ROOT;

const { createMockDb } = require('./helpers/mockDb');
const _db = createMockDb();
jest.mock('../db/loader', () => _db);
jest.mock('../db/index', () => _db);

const claimRegistrationSlot = jest.fn().mockResolvedValue(true);
jest.mock('../lib/captcha', () => ({
  botFilterMiddleware: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  loginLockMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
  progressiveCaptchaMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
  captchaMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
  registrationThrottleMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
  recordFailedLogin: jest.fn().mockResolvedValue(undefined),
  recordSuccessfulLogin: jest.fn().mockResolvedValue(undefined),
  checkSuspiciousLogin: jest.fn().mockResolvedValue(undefined),
  recordRegistration: jest.fn().mockResolvedValue(undefined),
  claimRegistrationSlot: (...args: unknown[]) => claimRegistrationSlot(...args),
  _getIp: () => '127.0.0.1',
  GENERIC_LOGIN_ERROR: 'Invalid username or password',
}));
jest.mock('../middleware/rateLimit', () => ({
  rateLimit: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  limits: new Proxy({}, { get: () => () => (_req: Request, _res: Response, next: NextFunction) => next() }),
}));

// The point of this file: reach the handler's own guards, so the schema layer
// in front of them is deliberately made a pass-through.
jest.mock('../middleware/validate', () => {
  const actual = jest.requireActual('../middleware/validate');
  return {
    ...actual,
    validateBody: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  };
});

const hasLiveUploadReference = jest.fn();
jest.mock('../lib/uploadReferenceSafety', () => {
  const actual = jest.requireActual('../lib/uploadReferenceSafety');
  return { ...actual, hasLiveUploadReference: (...a: unknown[]) => hasLiveUploadReference(...a) };
});

const logError = jest.fn();
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: (...a: unknown[]) => logError(...a) },
}));

jest.mock('../lib/presenceCache', () => ({
  setPresenceVisibility: jest.fn().mockResolvedValue(undefined),
  markOnline: jest.fn().mockResolvedValue(undefined),
  markOffline: jest.fn().mockResolvedValue(undefined),
  socketCount: jest.fn(() => 0),
  isUserOnline: jest.fn().mockResolvedValue(false),
}));
jest.mock('../socket', () => ({
  getIo: () => ({
    to: () => ({ emit() {}, disconnectSockets() {} }),
    in: () => ({ fetchSockets: async () => [], emit() {}, disconnectSockets() {} }),
    sockets: { sockets: new Map() },
  }),
}));

import crypto from 'crypto';
const { router } = require('../routes/auth');

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api', router);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) =>
    res.status(500).json({ error: err.message }));
  return app;
}
const app = buildApp();

let seq = 0;
async function register(username: string, password = 'parola-1234') {
  return request(app).post('/api/register').send({ username, password, displayName: 'Ad' });
}
async function loginToken(username: string, password = 'parola-1234'): Promise<string> {
  const res = await request(app).post('/api/login').send({ username, password });
  return String(res.body.token ?? '');
}

beforeEach(() => {
  jest.clearAllMocks();
  claimRegistrationSlot.mockResolvedValue(true);
  hasLiveUploadReference.mockResolvedValue(false);
});

afterEach(() => { jest.restoreAllMocks(); });

afterAll(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

describe('registration guards hold even without the schema layer', () => {
  const rejected: Array<[string, Record<string, unknown>, RegExp]> = [
    ['no username', { password: 'parola-1234' }, /Username and password required/],
    ['no password', { username: 'someone' }, /Username and password required/],
    ['an empty username', { username: '', password: 'parola-1234' }, /Username and password required/],
    ['a two-character username', { username: 'ab', password: 'parola-1234' }, /3-32 characters/],
    ['a 33-character username', { username: 'a'.repeat(33), password: 'parola-1234' }, /3-32 characters/],
    ['a username with punctuation', { username: 'bad-name', password: 'parola-1234' }, /letters, numbers and underscores/],
    ['a username with spaces', { username: 'bad name', password: 'parola-1234' }, /letters, numbers and underscores/],
    ['a seven-character password', { username: 'shortpw', password: '1234567' }, /at least 8 characters/],
    ['a 129-character password', { username: 'longpw', password: 'a'.repeat(129) }, /max 128 characters/],
  ];

  for (const [name, body, message] of rejected) {
    it(`refuses ${name} without consuming the registration quota`, async () => {
      const res = await request(app).post('/api/register').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(message);
      expect(claimRegistrationSlot).not.toHaveBeenCalled();
    });
  }

  it('accepts the boundary values on both sides', async () => {
    const min = await register('abc', 'a'.repeat(8));
    expect(min.status).toBe(200);
    const max = await register('a'.repeat(32), 'a'.repeat(128));
    expect(max.status).toBe(200);
  });

  it('refuses to create an account when identity keys cannot be generated', async () => {
    // A federated account without an RSA identity can never sign anything, so
    // a half-provisioned row is worse than no row at all.
    const keygen = jest.spyOn(crypto, 'generateKeyPairSync')
      .mockImplementation(() => { throw new Error('no entropy available'); });
    try {
      const name = `nokeys${++seq}`;
      const res = await register(name);
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('Identity key generation failed');
      expect(await _db.users.findOne({ username: name })).toBeFalsy();
    } finally { keygen.mockRestore(); }
  });
});

describe('login guards hold without the schema layer', () => {
  const rejected: Array<[string, Record<string, unknown>]> = [
    ['no username', { password: 'parola-1234' }],
    ['no password', { username: 'someone' }],
    ['neither', {}],
  ];
  for (const [name, body] of rejected) {
    it(`refuses ${name}`, async () => {
      const res = await request(app).post('/api/login').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/required/i);
    });
  }
});

describe('refresh failures are explained distinctly', () => {
  const missing: Array<[string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
  ];
  for (const [name, refreshToken] of missing) {
    it(`refuses ${name}`, async () => {
      const res = await request(app).post('/api/refresh').send({ refreshToken });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('refreshToken required');
    });
  }

  it('refuses a non-string or over-long token before any store lookup', async () => {
    const nonString = await request(app).post('/api/refresh').send({ refreshToken: 12345 });
    expect(nonString.status).toBe(400);
    expect(nonString.body.error).toBe('refreshToken invalid');

    const tooLong = await request(app).post('/api/refresh').send({ refreshToken: 'a'.repeat(513) });
    expect(tooLong.status).toBe(400);
  });

  it('an unknown token is a plain rejection with a machine-readable reason', async () => {
    const res = await request(app).post('/api/refresh').send({ refreshToken: 'a'.repeat(64) });
    expect(res.status).toBe(401);
    expect(res.body.reason).toBe('not_found');
    expect(res.body.error).toBe('Invalid or expired refresh token');
  });
});

describe('change-password guards hold without the schema layer', () => {
  let token = '';
  const NAME = 'pwguard';

  beforeEach(async () => {
    if (!token) {
      await register(NAME);
      token = await loginToken(NAME);
    }
  });

  const rejected: Array<[string, Record<string, unknown>, RegExp]> = [
    ['no current password', { newPassword: 'yeniparola-1' }, /currentPassword and newPassword required/],
    ['no new password', { currentPassword: 'parola-1234' }, /currentPassword and newPassword required/],
    ['a seven-character new password', { currentPassword: 'parola-1234', newPassword: '1234567' }, /at least 8 characters/],
    ['a 129-character new password', { currentPassword: 'parola-1234', newPassword: 'a'.repeat(129) }, /max 128 characters/],
  ];
  for (const [name, body, message] of rejected) {
    it(`refuses ${name}`, async () => {
      const res = await request(app).post('/api/change-password')
        .set('Authorization', `Bearer ${token}`).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(message);
    });
  }

  it('refuses a wrong current password', async () => {
    const res = await request(app).post('/api/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'yanlis-parola', newPassword: 'yeniparola-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Current password is incorrect');
  });

  it('an account with no password hash cannot be unlocked by an empty string', async () => {
    const ssoName = `ssoonly${++seq}`;
    await register(ssoName);
    const ssoToken = await loginToken(ssoName);
    const row = await _db.users.findOne({ username: ssoName });
    await _db.users.update({ _id: row._id }, { $set: { password: null } });

    const res = await request(app).post('/api/change-password')
      .set('Authorization', `Bearer ${ssoToken}`)
      .send({ currentPassword: '', newPassword: 'yeniparola-1' });

    // The empty current password is refused by the required-field guard, and
    // the null hash never compares equal to anything either.
    expect(res.status).toBe(400);
  });
});

// The cleanup helper is module-private; it is driven through the avatar
// endpoint that owns it, which is also how it runs in production.
describe('profile asset cleanup', () => {
  let token = '';
  let userId = '';
  const NAME = 'assetowner';

  beforeEach(async () => {
    if (!token) {
      await register(NAME);
      token = await loginToken(NAME);
      userId = String((await requireDoc(_db.users, { username: NAME }))._id);
    }
  });

  function seedAvatar(fileName: string): string {
    const dir = path.join(ROOT, 'avatars');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, Buffer.from('\x89PNG\r\n\x1a\n avatar bytes'));
    return filePath;
  }

  it('deletes the previous avatar once nothing references it', async () => {
    const filePath = seedAvatar('avatar_old.png');
    await _db.users.update({ _id: userId }, { $set: { avatarUrl: '/uploads/avatars/avatar_old.png' } });
    hasLiveUploadReference.mockResolvedValue(false);

    const res = await request(app).delete('/api/me/avatar').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(hasLiveUploadReference.mock.calls.map(call => call[1]))
      .toContain('uploads/avatars/avatar_old.png');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  // ── Final21 Faz 8 — F21-8-02 ───────────────────────────────────────────────
  // Avatar DEĞİŞTİRME eski dosyayı SİLMEZ. Mesajlar yazarın avatarını anlık
  // görüntü olarak tutar ve istemci onu çizer; eski dosyanın silinmesi, gerçek
  // uçlar üzerinden üretildiği gibi GEÇMİŞTEKİ TÜM mesajların avatarını
  // kırıyordu (A yükle → mesaj → B yükle → GET A = 404).
  //
  // Referans denetimi burada BİLEREK `false` döndürür — en kötü durum. Eski
  // kod tam bu durumda dosyayı silerdi; düzeltmeden sonra dosya kalmalıdır.
  it('replacing the avatar KEEPS the old file — message snapshots still render it', async () => {
    const filePath = seedAvatar('avatar_replaced.png');
    await _db.users.update({ _id: userId }, { $set: { avatarUrl: '/uploads/avatars/avatar_replaced.png' } });
    hasLiveUploadReference.mockResolvedValue(false);

    const png = TINY_PNG; // P7 B3: a real image — uploads are walked for metadata
    const res = await request(app).post('/api/me/avatar')
      .set('Authorization', `Bearer ${token}`)
      .attach('avatar', png, { filename: 'new.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.avatarUrl).toMatch(/^\/uploads\/avatars\//);
    expect(res.body.avatarUrl).not.toBe('/uploads/avatars/avatar_replaced.png');
    expect(fs.existsSync(filePath)).toBe(true);
    // Değiştirme yolu referans denetimine hiç başvurmaz: silme kararı yoktur.
    expect(hasLiveUploadReference.mock.calls.map(call => call[1]))
      .not.toContain('uploads/avatars/avatar_replaced.png');
  });

  // NOT (Final21 Faz 8): bu test referans denetimini MOCK'layıp `true`
  // döndürür. Kanıtladığı şey ROTANIN denetimin cevabına UYDUĞUDUR — gerçek
  // SQL'in bir mesaj referansını TANIDIĞI değil. Nitekim gerçek sorgu
  // `messages.avatarUrl`i kapsamıyordu ve bu test yine geçiyordu (F21-8-02).
  it('keeps the previous avatar while a message still references it', async () => {
    const filePath = seedAvatar('avatar_referenced.png');
    await _db.users.update({ _id: userId }, { $set: { avatarUrl: '/uploads/avatars/avatar_referenced.png' } });
    hasLiveUploadReference.mockResolvedValue(true);

    const res = await request(app).delete('/api/me/avatar').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('keeps the file when the reference lookup itself fails', async () => {
    const filePath = seedAvatar('avatar_uncertain.png');
    await _db.users.update({ _id: userId }, { $set: { avatarUrl: '/uploads/avatars/avatar_uncertain.png' } });
    hasLiveUploadReference.mockRejectedValue(new Error('reference index offline'));

    const res = await request(app).delete('/api/me/avatar').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'profile_asset.cleanup_failed' }), expect.any(String));
  });

  it('an externally hosted avatar triggers no filesystem work at all', async () => {
    await _db.users.update({ _id: userId }, { $set: { avatarUrl: 'https://cdn.example/avatar.png' } });

    const res = await request(app).delete('/api/me/avatar').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(hasLiveUploadReference).not.toHaveBeenCalled();
  });

  it('an account with no avatar at all is a clean no-op', async () => {
    await _db.users.update({ _id: userId }, { $set: { avatarUrl: null } });
    const res = await request(app).delete('/api/me/avatar').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(hasLiveUploadReference).not.toHaveBeenCalled();
  });

  it('an avatar row that points outside the avatars directory is left alone', async () => {
    await _db.users.update({ _id: userId }, { $set: { avatarUrl: '/uploads/banners/banner_x.png' } });
    const res = await request(app).delete('/api/me/avatar').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(hasLiveUploadReference).not.toHaveBeenCalled();
  });
});

// ── Refresh tokens that must no longer mint access ─────────────────────────
// The route answers each refusal with a distinct, machine-readable reason, and
// a refused token is gone afterwards: it can never be retried into a session.
describe('refresh tokens die with expiry and with a stale token generation', () => {
  const refreshCookieOf = (res: { headers: Record<string, unknown> }) => {
    const cookie = ([] as string[]).concat((res.headers['set-cookie'] as string[] | undefined) ?? [])
      .find((c) => c.startsWith('bridge_refresh='));
    return decodeURIComponent(String(cookie).split(';')[0]!.slice('bridge_refresh='.length));
  };
  /** Registration and the later sign-in each open their own refresh session. */
  async function signIn(username: string) {
    const registered = await register(username);
    const res = await request(app).post('/api/login').send({ username, password: 'parola-1234' });
    const user = await requireDoc(_db.users, { username });
    return { registrationToken: refreshCookieOf(registered), refreshToken: refreshCookieOf(res), userId: String(user._id) };
  }
  const refresh = (refreshToken: string) => request(app).post('/api/refresh').send({ refreshToken });
  const newRefreshCookie = (res: { headers: Record<string, unknown> }) =>
    ([] as string[]).concat((res.headers['set-cookie'] as string[] | undefined) ?? [])
      .some((c) => /^bridge_refresh=[^;]+/.test(c));

  it('an expired refresh token is refused as expired and is then gone', async () => {
    const { refreshToken, userId } = await signIn(`expired${++seq}`);
    expect(refreshToken.length).toBeGreaterThan(32);
    await _db.refreshTokens.update({ userId }, { $set: { expiresAt: Date.now() - 1_000 } }, { multi: true });

    const first = await refresh(refreshToken);
    expect(first.status).toBe(401);
    expect(first.body).toEqual({ error: 'Refresh token expired. Please log in again.', reason: 'expired' });
    expect(first.body.token).toBeUndefined();
    expect(newRefreshCookie(first)).toBe(false);

    const retry = await refresh(refreshToken);
    expect(retry.status).toBe(401);
    expect(retry.body.reason).toBe('not_found');
  });

  it('every refresh session from an older token generation is refused as revoked and removed', async () => {
    // Another path (an account-security action, another node) bumped the
    // generation without deleting these rows: a surviving row is not enough.
    const { registrationToken, refreshToken, userId } = await signIn(`stale${++seq}`);
    expect(registrationToken).not.toBe(refreshToken);
    expect(await _db.refreshTokens.find({ userId })).toHaveLength(2);
    const user = await requireDoc(_db.users, { _id: userId });
    await _db.users.update({ _id: userId }, { $set: { tokenVersion: Number(user.tokenVersion ?? 0) + 1 } });

    for (const token of [refreshToken, registrationToken]) {
      const res = await refresh(token);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Session revoked. Please log in again.', reason: 'revoked' });
      expect(newRefreshCookie(res)).toBe(false);
    }
    expect(await _db.refreshTokens.find({ userId })).toEqual([]);
    expect((await refresh(refreshToken)).body.reason).toBe('not_found');
  });

  it('control: the same flow with an unchanged generation rotates normally', async () => {
    const { refreshToken } = await signIn(`fresh${++seq}`);
    const res = await refresh(refreshToken);
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(newRefreshCookie(res)).toBe(true);
  });
});

// ── P7 B3: an image whose metadata cannot be removed is never stored ───────
// The file passes the magic-byte check (it starts like a PNG) but its chunk
// structure cannot be walked, so location/device metadata could not be
// proven absent. The upload is refused, the temporary file deleted and the
// profile left exactly as it was.
describe('profile image uploads refuse what metadata stripping cannot clean', () => {
  let token = '';
  let userId = '';
  const CORRUPT_PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x00, 0x00, 0x0d]), Buffer.from('IHDR'), Buffer.alloc(3, 0x01), // truncated chunk
  ]);
  const filesIn = (dir: string) => (fs.existsSync(path.join(ROOT, dir)) ? fs.readdirSync(path.join(ROOT, dir)) : []);

  beforeEach(async () => {
    if (!token) {
      const name = `imgowner${++seq}`;
      await register(name);
      token = await loginToken(name);
      userId = String((await requireDoc(_db.users, { username: name }))._id);
    }
  });

  it.each([
    ['avatar', '/api/me/avatar', 'avatars', 'avatarUrl'],
    ['banner', '/api/me/banner', 'banners', 'bannerUrl'],
  ])('a %s that cannot be walked is refused with 422 and leaves nothing behind', async (field, url, dir, column) => {
    const before = filesIn(dir);
    const profileBefore = (await requireDoc(_db.users, { _id: userId }))[column];
    const res = await request(app).post(url)
      .set('Authorization', `Bearer ${token}`)
      .attach(field, CORRUPT_PNG, { filename: 'photo.png', contentType: 'image/png' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('IMAGE_UNPARSEABLE');
    expect(res.body[column]).toBeUndefined();
    // The temporary upload is removed asynchronously; give the unlink a tick.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(filesIn(dir)).toEqual(before);
    expect((await requireDoc(_db.users, { _id: userId }))[column]).toEqual(profileBefore);
  });

  it('control: a real image of the same type is accepted as a banner', async () => {
    const res = await request(app).post('/api/me/banner')
      .set('Authorization', `Bearer ${token}`)
      .attach('banner', TINY_PNG, { filename: 'banner.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    expect(res.body.bannerUrl).toMatch(/^\/uploads\/banners\//);
  });

  it('a banner request without a file is refused before anything is written', async () => {
    const before = await requireDoc(_db.users, { _id: userId });
    const res = await request(app).post('/api/me/banner').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('No file uploaded');
    expect((await requireDoc(_db.users, { _id: userId })).bannerUrl).toEqual(before.bannerUrl);
  });
});

// ── Push copy language: only a locale the server has copy for is stored ────
describe('profile locale updates keep only languages the server can speak', () => {
  let token = '';
  let userId = '';
  beforeEach(async () => {
    if (!token) {
      const name = `localeowner${++seq}`;
      await register(name);
      token = await loginToken(name);
      userId = String((await requireDoc(_db.users, { username: name }))._id);
    }
  });
  const patchLocale = (locale: unknown) =>
    request(app).patch('/api/me').set('Authorization', `Bearer ${token}`).send({ locale });
  const storedLocale = async () => (await requireDoc(_db.users, { _id: userId })).locale;

  it('a regional tag of a supported language is stored as that language', async () => {
    expect((await patchLocale('EN-us')).status).toBe(200);
    expect(await storedLocale()).toBe('en');
  });

  it('an unsupported language leaves the stored locale alone instead of falling back to the default', async () => {
    await patchLocale('en');
    // Nothing acceptable was sent, so nothing is written (not the default 'tr').
    const res = await patchLocale('xx-YY');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Nothing to update');
    expect(await storedLocale()).toBe('en');
  });

  it('a non-string locale is ignored, also next to a valid field', async () => {
    await patchLocale('en');
    expect((await patchLocale(42)).status).toBe(400);
    expect(await storedLocale()).toBe('en');
    // Alongside a valid field, the bad locale is dropped and the rest applies.
    const mixed = await request(app).patch('/api/me').set('Authorization', `Bearer ${token}`).send({ locale: 'xx', bio: 'hello' });
    expect(mixed.status).toBe(200);
    expect(await storedLocale()).toBe('en');
    expect((await requireDoc(_db.users, { _id: userId })).bio).toBe('hello');
  });
});
