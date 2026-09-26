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

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
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
