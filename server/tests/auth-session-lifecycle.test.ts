// server/tests/auth-session-lifecycle.test.ts
//
// OTURUM YAŞAM DÖNGÜSÜ — ŞİFRE DEĞİŞTİRME, TÜM OTURUMLARI KAPATMA, CSRF
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BU DOSYA VAR
// ════════════════════════════════════════════════════════════════════════════
// `tests/auth.test.ts` dosyasının BAŞLIĞI şunu iddia ediyordu:
//
//     "Tests for auth routes: register, login, refresh, change-password,
//      logout-all"
//
// Ama o dosyada `change-password` veya `logout-all` için TEK BİR describe
// bloğu bile YOKTU. Kapsama bunu doğruladı: `routes/auth.ts` içinde
// 367-393 (change-password) ve 407-415 (logout-all) satırları TAMAMEN
// kapsanmamıştı. Başlık, var olmayan bir güvenceyi bildiriyordu.
//
// Bu iki uç, ürünün OTURUM İPTAL mekanizmasıdır: parolası çalınan ya da
// cihazı kaybolan bir kullanıcının diğer oturumları kapatmasının TEK yolu.
// Sessizce çalışmazlarsa, kullanıcı "her yerden çıkış yaptım" sanırken
// saldırganın oturumu AÇIK KALIR.
//
// ── ÖLÇÜLEN BAŞLANGIÇ ───────────────────────────────────────────────────────
// routes/auth.ts  →  %83.86 ifade · %52.23 dal · %22.22 fonksiyon

import { setCookiesOf } from './helpers/httpDoubles';
import request from 'supertest';
import express, { Express, Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';

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

const disconnectLiveUserSessions = jest.fn().mockResolvedValue(0);
jest.mock('../lib/sessionRevocation', () => ({ disconnectLiveUserSessions }));

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
    res.status(500).json({ error: err.message }));
  return app;
}

const app = buildApp();
beforeEach(() => { _db._reset?.(); });

const PAROLA = 'ilkParola123';

async function kayit(username: string) {
  const r = await request(app).post('/api/register').send({ username, password: PAROLA });
  return { token: r.body.token as string, userId: (r.body.user?._id ?? r.body.user?.id) as string };
}

const kullaniciOku = async (id: string) => _db.users.findOne({ _id: id });

// ════════════════════════════════════════════════════════════════════════════
// ŞİFRE DEĞİŞTİRME — girdi doğrulama
// ════════════════════════════════════════════════════════════════════════════
describe('POST /api/change-password — doğrulama', () => {
  it('eksik alanlar 400 döner', async () => {
    const { token } = await kayit('cp_eksik');
    const r = await request(app).post('/api/change-password')
      .set('Authorization', `Bearer ${token}`).send({ currentPassword: PAROLA });
    expect(r.status).toBe(400);
  });

  it('KISA yeni parola (8 karakterden az) reddedilir', async () => {
    const { token } = await kayit('cp_kisa');
    const r = await request(app).post('/api/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: PAROLA, newPassword: 'kisa123' });
    expect({ status: r.status }).toEqual({ status: 400 });
  });

  it('AŞIRI UZUN yeni parola (128+) reddedilir', async () => {
    // Sinirsiz uzunluk bcrypt uzerinden CPU tuketimi yaratabilir.
    const { token } = await kayit('cp_uzun');
    const r = await request(app).post('/api/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: PAROLA, newPassword: 'x'.repeat(129) });
    expect({ status: r.status }).toEqual({ status: 400 });
  });

  it('YANLIŞ mevcut parola reddedilir', async () => {
    // En onemli kontrol: calinmis bir OTURUM parolayi degistirememeli.
    const { token } = await kayit('cp_yanlis');
    const r = await request(app).post('/api/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'tamamenYanlis1', newPassword: 'yeniParola123' });
    expect({ status: r.status }).toEqual({ status: 400 });
  });

  it('kimlik doğrulaması OLMADAN erişilemez', async () => {
    const r = await request(app).post('/api/change-password')
      .send({ currentPassword: PAROLA, newPassword: 'yeniParola123' });
    expect(r.status).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ŞİFRE DEĞİŞTİRME — başarı ve OTURUM İPTALİ
// ════════════════════════════════════════════════════════════════════════════
describe('POST /api/change-password — başarı ve oturum iptali', () => {
  it('başarılı değişim YENİ access token + httpOnly refresh cookie üretir; refresh secret bodyye sızmaz', async () => {
    const { token } = await kayit('cp_ok');
    const r = await request(app).post('/api/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: PAROLA, newPassword: 'yeniParola123' });
    const cookies = setCookiesOf(r.headers);
    expect({
      status: r.status,
      token: typeof r.body.token === 'string' && r.body.token.length > 20,
      refreshInBody: Object.prototype.hasOwnProperty.call(r.body, 'refreshToken'),
      refreshCookie: cookies.some((v) => /bridge_refresh=.*HttpOnly/i.test(v)),
    }).toEqual({ status: 200, token: true, refreshInBody: false, refreshCookie: true });
  });

  it('parola GERÇEKTEN değişir — eski parola artık geçmez', async () => {
    // Yanit 200 dondurup diske yazmamak sessiz bir felaket olurdu.
    const { token, userId } = await kayit('cp_gercek');
    await request(app).post('/api/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: PAROLA, newPassword: 'yeniParola123' });

    const u = await kullaniciOku(userId);
    expect({
      yeniGecerli: await bcrypt.compare('yeniParola123', String(u.password)),
      eskiGecerli: await bcrypt.compare(PAROLA, String(u.password)),
    }).toEqual({ yeniGecerli: true, eskiGecerli: false });
  });

  it('tokenVersion ARTIRILIR — diğer oturumlar geçersizleşir', async () => {
    // Bu, "her yerden cikis yap" vaadinin ta kendisidir.
    const { token, userId } = await kayit('cp_versiyon');
    const once = (await kullaniciOku(userId)).tokenVersion ?? 0;
    await request(app).post('/api/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: PAROLA, newPassword: 'yeniParola123' });
    const sonra = (await kullaniciOku(userId)).tokenVersion ?? 0;
    expect({ artti: sonra > once }).toEqual({ artti: true });
  });

  it('açık socket oturumları 5 dakikalık periyodik kontrolü beklemeden revoke edilir', async () => {
    disconnectLiveUserSessions.mockClear();
    const { token, userId } = await kayit('cp_socket');
    await request(app).post('/api/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: PAROLA, newPassword: 'yeniParola123' });
    expect(disconnectLiveUserSessions).toHaveBeenCalledWith(userId, 'password_changed');
  });

  it('ESKİ erişim jetonu artık KABUL EDİLMEZ', async () => {
    // Gercek iptal kanitı: eski oturum kapanmali.
    const { token } = await kayit('cp_eskitoken');
    await request(app).post('/api/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: PAROLA, newPassword: 'yeniParola123' });

    const eskiyle = await request(app).get('/api/me').set('Authorization', `Bearer ${token}`);
    expect({ eskiTokenCalisiyor: eskiyle.status === 200 }).toEqual({ eskiTokenCalisiyor: false });
  });

  // ── POZİTİF KONTROL ───────────────────────────────────────────────────────
  it('POZİTİF KONTROL: YENİ jeton çalışır', async () => {
    // Bu olmadan "eski jeton olmez" testi, TUM jetonlari kiran bir hatada da
    // yesil kalirdi — ve kullanici degisimden sonra tamamen kilitlenirdi.
    const { token } = await kayit('cp_yenitoken');
    const r = await request(app).post('/api/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: PAROLA, newPassword: 'yeniParola123' });

    const yeniyle = await request(app).get('/api/me')
      .set('Authorization', `Bearer ${r.body.token}`);
    expect({ status: yeniyle.status }).toEqual({ status: 200 });
  });

  it('YENİ parola ile giriş yapılabilir', async () => {
    const { token } = await kayit('cp_yenigiris');
    await request(app).post('/api/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: PAROLA, newPassword: 'yeniParola123' });

    const giris = await request(app).post('/api/login')
      .send({ username: 'cp_yenigiris', password: 'yeniParola123' });
    expect({ status: giris.status }).toEqual({ status: 200 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TÜM OTURUMLARI KAPAT
// ════════════════════════════════════════════════════════════════════════════
describe('POST /api/logout-all', () => {
  it('tokenVersion ARTIRILIR', async () => {
    const { token, userId } = await kayit('la_versiyon');
    const once = (await kullaniciOku(userId)).tokenVersion ?? 0;
    const r = await request(app).post('/api/logout-all')
      .set('Authorization', `Bearer ${token}`).send({});
    const sonra = (await kullaniciOku(userId)).tokenVersion ?? 0;
    expect({ status: r.status, artti: sonra > once }).toEqual({ status: 200, artti: true });
  });

  it('ESKİ jeton artık KABUL EDİLMEZ', async () => {
    const { token } = await kayit('la_eski');
    await request(app).post('/api/logout-all')
      .set('Authorization', `Bearer ${token}`).send({});
    const sonra = await request(app).get('/api/me').set('Authorization', `Bearer ${token}`);
    expect({ hala: sonra.status === 200 }).toEqual({ hala: false });
  });

  it('açık socketleri anında revoke eder', async () => {
    disconnectLiveUserSessions.mockClear();
    const { token, userId } = await kayit('la_socket');
    await request(app).post('/api/logout-all').set('Authorization', `Bearer ${token}`).send({});
    expect(disconnectLiveUserSessions).toHaveBeenCalledWith(userId, 'logout_all');
  });

  it('kimlik doğrulaması OLMADAN erişilemez', async () => {
    const r = await request(app).post('/api/logout-all').send({});
    expect(r.status).toBe(401);
  });

  it('parola DEĞİŞMEZ — yalnızca oturumlar kapanır', async () => {
    // "Tum oturumlari kapat" bir parola sifirlama DEGILDIR; kullanici ayni
    // parolayla yeniden girebilmeli.
    const { token, userId } = await kayit('la_parola');
    const oncekiHash = (await kullaniciOku(userId)).password;
    await request(app).post('/api/logout-all')
      .set('Authorization', `Bearer ${token}`).send({});
    expect((await kullaniciOku(userId)).password).toBe(oncekiHash);

    const giris = await request(app).post('/api/login')
      .send({ username: 'la_parola', password: PAROLA });
    expect({ status: giris.status }).toEqual({ status: 200 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CSRF JETONU
// ════════════════════════════════════════════════════════════════════════════
describe('GET /api/csrf-token', () => {
  it('kimlikli istek jeton döner', async () => {
    const { token } = await kayit('csrf_ok');
    const r = await request(app).get('/api/csrf-token').set('Authorization', `Bearer ${token}`);
    expect({ status: r.status, jetonVar: typeof r.body.token === 'string' && r.body.token.length > 8 })
      .toEqual({ status: 200, jetonVar: true });
  });

  it('kimlik doğrulaması OLMADAN erişilemez', async () => {
    // CSRF jetonu kimlige BAGLIDIR; anonim uretim onu anlamsizlastirirdi.
    const r = await request(app).get('/api/csrf-token');
    expect(r.status).toBe(401);
  });

  it('FARKLI kullanıcılar FARKLI jeton alır', async () => {
    const a = await kayit('csrf_a');
    const b = await kayit('csrf_b');
    const ra = await request(app).get('/api/csrf-token').set('Authorization', `Bearer ${a.token}`);
    const rb = await request(app).get('/api/csrf-token').set('Authorization', `Bearer ${b.token}`);
    expect({ ayni: ra.body.token === rb.body.token }).toEqual({ ayni: false });
  });
});
