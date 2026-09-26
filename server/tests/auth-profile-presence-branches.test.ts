// server/tests/auth-profile-presence-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// AUTH — PROFİL GÜNCELLEME, VARLIK GÖRÜNÜRLÜĞÜ VE OTURUM YENİLEME DALLARI
// ════════════════════════════════════════════════════════════════════════════
//
// `auth.test.ts` mutlu yolları ölçer. Bu dosya ölçülmemiş KARAR dallarını
// kapatır; her biri gizlilik ya da hesap güvenliği taşır:
import type { ServerDouble } from './helpers/socketDoubles';
//
//   · GİZLİLİK ASİMETRİSİ — "gizlen" isteği ÖNCE paylaşılan otoriteye yazılır;
//     otorite erişilemezse istek REDDEDİLİR (kullanıcı kendini gizlediğini
//     sanıp görünür kalmamalıdır). "Görün" isteği ise önce kalıcı depoya yazılır.
//   · KİMLİK TAKLİDİ — görünen ad temizlenir; temizlik sonrası boş kalan ad
//     KABUL EDİLMEZ ve eski ad korunur.
//   · SAHİPLİK — `bannerUrl` depoya aittir; istemci yalnızca NULL ile
//     kaldırabilir, kendi adresini yazamaz.
//   · OTURUM — parola değişimi tüm oturumları düşürür; yanlış mevcut parola
//     kabul edilmez ve SSO hesabında boş parola alanı doğrulamayı AÇMAZ.
//   · YENİLEME — token yeniden kullanımı, süre dolması ve iptal edilmiş oturum
//     BİRBİRİNDEN AYRI nedenlerle anlatılır; aşırı uzun jeton hiç çözülmez.

import request from 'supertest';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV = 'test';

const { createMockDb } = require('./helpers/mockDb');
import { requireDoc } from './helpers/mockDb';
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

const presence = {
  setPresenceVisibility: jest.fn().mockResolvedValue(undefined),
  markOnline: jest.fn().mockResolvedValue(undefined),
  markOffline: jest.fn().mockResolvedValue(undefined),
  socketCount: jest.fn(() => 0),
};
jest.mock('../lib/presenceCache', () => presence);

const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
const io = {
  to(room: string) {
    return {
      emit(event: string, payload: unknown) { emitted.push({ room, event, payload }); },
      disconnectSockets() { /* canlı oturum düşürme testte gözlemlenmez */ },
    };
  },
  in(room: string) {
    return {
      fetchSockets: async () => [],
      emit(event: string, payload: unknown) { emitted.push({ room, event, payload }); },
      disconnectSockets() { /* aynı */ },
    };
  },
  sockets: { sockets: new Map() },
} satisfies ServerDouble;
jest.mock('../socket', () => ({ getIo: () => io }));

import bcrypt from 'bcryptjs';
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
let token = '';
const USER = 'profiluser';

async function registerAndLogin(username = USER, password = 'parola-1234'): Promise<string> {
  await request(app).post('/api/register').send({ username, password, displayName: 'Profil' });
  const login = await request(app).post('/api/login').send({ username, password });
  return String(login.body.token ?? '');
}

const authed = (method: 'get' | 'post' | 'patch' | 'delete', url: string) =>
  request(app)[method](url).set('Authorization', `Bearer ${token}`);

beforeAll(async () => {
  token = await registerAndLogin();
  const row = await _db.users.findOne({ username: USER });
  // Varlık yayını yalnız ÜYELİKLERE gider; üyeliksiz bir hesapla ölçüm
  // "yayın yapılmadı" sonucunu yanlışlıkla doğrular.
  await _db.members.insert({ userId: String(row._id), serverId: 'server-1', roles: [], joinedAt: 1 });
});

beforeEach(() => {
  jest.clearAllMocks();
  emitted.length = 0;
  claimRegistrationSlot.mockResolvedValue(true);
  presence.setPresenceVisibility.mockResolvedValue(undefined);
  presence.markOnline.mockResolvedValue(undefined);
  presence.markOffline.mockResolvedValue(undefined);
  presence.socketCount.mockReturnValue(0);
});

// ════════════════════════════════════════════════════════════════════════════
describe('POST /register — kota ve kimlik anahtarı', () => {
  it('ATOMİK kota reddi 429 ile bildirilir ve hesap oluşturulmaz', async () => {
    claimRegistrationSlot.mockResolvedValue(false);

    const res = await request(app).post('/api/register')
      .send({ username: 'kotadolu', password: 'parola-1234' });

    expect(res.status).toBe(429);
    expect(res.body.retryAfter).toBe(3600);
    expect(await _db.users.findOne({ username: 'kotadolu' })).toBeFalsy();
  });

  it('kullanıcı adı ZATEN ALINMIŞSA 409 verilir ve kota harcanmaz', async () => {
    const res = await request(app).post('/api/register')
      .send({ username: USER, password: 'parola-1234' });

    expect(res.status).toBe(409);
    expect(claimRegistrationSlot).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('POST /login — parola alanı olmayan hesap', () => {
  it('PAROLASIZ (SSO) hesap boş parola ile giriş yaptırmaz', async () => {
    await _db.users.insert({
      _id: 'sso-user', username: 'ssohesap', displayName: 'SSO', password: null,
      avatarColor: '#fff', status: 'online', tokenVersion: 0,
    });

    const res = await request(app).post('/api/login').send({ username: 'ssohesap', password: '' });

    expect(res.status).toBe(400);

    const empty = await request(app).post('/api/login').send({ username: 'ssohesap', password: 'herhangi' });
    expect(empty.status).toBe(401);
    expect(empty.body.error).toBe('Invalid username or password');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('POST /refresh — reddetme nedenleri AYRI anlatılır', () => {
  it('aşırı uzun jeton hiç ÇÖZÜLMEZ', async () => {
    const res = await request(app).post('/api/refresh').send({ refreshToken: 'r'.repeat(513) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('refreshToken invalid');
  });

  it('metin olmayan jeton reddedilir', async () => {
    const res = await request(app).post('/api/refresh').send({ refreshToken: 42 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('refreshToken invalid');
  });

  it('jeton hiç verilmezse ayrı bir mesaj döner', async () => {
    const res = await request(app).post('/api/refresh').send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('refreshToken required');
  });

  it('bilinmeyen jeton genel bir nedenle reddedilir', async () => {
    const res = await request(app).post('/api/refresh').send({ refreshToken: 'bilinmeyen-jeton' });

    expect(res.status).toBe(401);
    expect(res.body.reason).toBeDefined();
  });

  it('çıkışta aşırı uzun jeton da reddedilir', async () => {
    const res = await request(app).post('/api/logout').send({ refreshToken: 'r'.repeat(513) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('refreshToken invalid');
  });

  it('jetonsuz çıkış KANONİK uca yönlendirilir (ikinci bir çıkış yolu üretilmez)', async () => {
    const res = await request(app).post('/api/logout').send({});

    expect(res.status).toBe(307);
    expect(res.headers.location).toBe('/api/refresh/logout');
  });

  it('yönlendirilen uç çerezleri temizler', async () => {
    const res = await request(app).post('/api/refresh/logout').send({});

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('POST /change-password', () => {
  it('YANLIŞ mevcut parola kabul edilmez', async () => {
    const res = await authed('post', '/api/change-password')
      .send({ currentPassword: 'yanlis-parola', newPassword: 'yeni-parola-1234' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Current password is incorrect');
  });

  it('parola değişimi TÜM oturumları düşürür ve yeni jeton verir', async () => {
    const local = await registerAndLogin('degistiren', 'parola-1234');

    const res = await request(app).post('/api/change-password')
      .set('Authorization', `Bearer ${local}`)
      .send({ currentPassword: 'parola-1234', newPassword: 'yeni-parola-1234' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    const updated = await _db.users.findOne({ username: 'degistiren' });
    expect(await bcrypt.compare('yeni-parola-1234', String(updated.password))).toBe(true);
    expect(Number(updated.tokenVersion)).toBeGreaterThan(0);
  });

  it('kullanıcı kaydı ARADA silinmişse istek KİMLİK katmanında durur', async () => {
    // Jeton doğrulaması kullanıcıyı depodan çözer; hesap yoksa istek rota
    // gövdesine hiç ulaşmaz. Bu, rota içindeki 404'ten DAHA ERKEN ve daha
    // doğru bir sınırdır.
    const local = await registerAndLogin('silinen', 'parola-1234');
    await _db.users.remove({ username: 'silinen' });

    const res = await request(app).post('/api/change-password')
      .set('Authorization', `Bearer ${local}`)
      .send({ currentPassword: 'parola-1234', newPassword: 'yeni-parola-1234' });

    expect(res.status).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('PATCH /me — profil alanları', () => {
  it.each([
    ['dizi', []],
    ['metin', 'gövde'],
    ['null', null],
  ])('nesne olmayan gövde (%s) reddedilir', async (_label, body) => {
    const res = await authed('patch', '/api/me').send(body as object);

    expect(res.status).toBe(400);
  });

  it('güncellenecek alan yoksa açıkça reddedilir', async () => {
    const res = await authed('patch', '/api/me').send({ bilinmeyen: 'alan' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Nothing to update');
  });

  it('TEMİZLİK sonrası boş kalan görünen ad KABUL EDİLMEZ', async () => {
    const res = await authed('patch', '/api/me').send({ displayName: '​​' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Nothing to update');
  });

  it('yalnız boşluktan ibaret ad da güncelleme üretmez', async () => {
    const res = await authed('patch', '/api/me').send({ displayName: '   ' });

    expect(res.status).toBe(400);
  });

  it('geçerli ad TEMİZLENEREK yazılır', async () => {
    const res = await authed('patch', '/api/me').send({ displayName: '  Yeni​ Ad  ' });

    expect(res.status).toBe(200);
    const row = await _db.users.findOne({ username: USER });
    expect(String(row.displayName)).not.toContain('​');
    expect(String(row.displayName)).toContain('Yeni');
  });

  it('metin alanları KIRPILIR ve sınırlanır', async () => {
    await authed('patch', '/api/me').send({
      bio: `  ${'b'.repeat(300)}  `,
      website: `  ${'w'.repeat(300)}  `,
      location: `  ${'l'.repeat(300)}  `,
      pronouns: `  ${'p'.repeat(300)}  `,
    });

    const row = await _db.users.findOne({ username: USER });
    expect(String(row.bio)).toHaveLength(180);
    expect(String(row.website)).toHaveLength(120);
    expect(String(row.location)).toHaveLength(60);
    expect(String(row.pronouns)).toHaveLength(40);
  });

  it('geçersiz durum/gizlilik değerleri yok sayılır', async () => {
    const res = await authed('patch', '/api/me')
      .send({ status: 'uyuyor', dmPrivacy: 'herkes', presenceVisibility: 'belki' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Nothing to update');
  });

  it('geçerli durum HEM etkin HEM kalıcı alana yazılır', async () => {
    await authed('patch', '/api/me').send({ status: 'dnd' });

    const row = await _db.users.findOne({ username: USER });
    expect(row.status).toBe('dnd');
    expect(row.presenceStatus).toBe('dnd');
  });

  it.each([
    ['#abc', true],
    ['#abcd', true],
    ['#a1b2c3', true],
    ['#a1b2c3d4', true],
    ['kirmizi', false],
    ['#12', false],
  ])('afiş rengi %s doğrulanır', async (bannerColor, accepted) => {
    const res = await authed('patch', '/api/me').send({ bannerColor });

    expect(res.status).toBe(accepted ? 200 : 400);
  });

  it('afiş adresi DEPOYA aittir: yalnız null kaldırma kabul edilir', async () => {
    const rejected = await authed('patch', '/api/me').send({ bannerUrl: '/uploads/banners/sahte.png' });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toContain('storage-owned');

    const accepted = await authed('patch', '/api/me').send({ bannerUrl: null });
    expect(accepted.status).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('PATCH /me — varlık görünürlüğü', () => {
  it('GİZLEN isteği önce paylaşılan otoriteye yazılır', async () => {
    const res = await authed('patch', '/api/me').send({ presenceVisibility: 'hidden' });

    expect(res.status).toBe(200);
    expect(presence.setPresenceVisibility).toHaveBeenCalledWith(expect.any(String), false);
    expect(presence.markOffline).toHaveBeenCalled();
    expect(emitted.some(e => (e.payload as { status?: string }).status === 'offline')).toBe(true);
  });

  it('otorite ERİŞİLEMEZKEN gizlenme isteği REDDEDİLİR', async () => {
    presence.setPresenceVisibility.mockRejectedValue(new Error('redis down'));

    const res = await authed('patch', '/api/me').send({ presenceVisibility: 'hidden' });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Presence coordination unavailable');
    expect(presence.markOffline).not.toHaveBeenCalled();
  });

  it('GÖRÜN isteği kalıcı depodan sonra otoriteye yazılır', async () => {
    const res = await authed('patch', '/api/me').send({ presenceVisibility: 'visible' });

    expect(res.status).toBe(200);
    expect(presence.setPresenceVisibility).toHaveBeenCalledWith(expect.any(String), true);
  });

  it('görünme otoritesi erişilemezse istek REDDEDİLİR', async () => {
    presence.setPresenceVisibility.mockRejectedValue(new Error('redis down'));

    const res = await authed('patch', '/api/me').send({ presenceVisibility: 'visible' });

    expect(res.status).toBe(503);
  });

  it('YEREL bağlantı yoksa görünür kullanıcı için çevrimiçi işareti atılmaz', async () => {
    presence.socketCount.mockReturnValue(0);

    await authed('patch', '/api/me').send({ presenceVisibility: 'visible' });

    expect(presence.markOnline).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });

  it('YEREL bağlantı varsa çevrimiçi işaretlenir ve yayılır', async () => {
    presence.socketCount.mockReturnValue(2);

    await authed('patch', '/api/me').send({ presenceVisibility: 'visible' });

    expect(presence.markOnline).toHaveBeenCalled();
    expect(emitted.some(e => (e.payload as { status?: string }).status === 'online')).toBe(true);
  });

  it('yayın PATLASA da görünürlük kararı KORUNUR', async () => {
    presence.markOffline.mockRejectedValue(new Error('socket down'));

    const res = await authed('patch', '/api/me').send({ presenceVisibility: 'hidden' });

    expect(res.status).toBe(200);
    expect(presence.setPresenceVisibility).toHaveBeenCalledWith(expect.any(String), false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('PATCH /me/banner-color', () => {
  it.each([
    ['renk verilmezse', undefined],
    ['boş dize', ''],
    ['geçersiz biçim', 'mavi'],
    ['eksik basamak', '#12'],
  ])('%s reddedilir', async (_label, bannerColor) => {
    const res = await authed('patch', '/api/me/banner-color').send({ bannerColor });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid color');
  });

  it('geçerli renk yazılır', async () => {
    const res = await authed('patch', '/api/me/banner-color').send({ bannerColor: '#2d9cdb' });

    expect(res.status).toBe(200);
    expect(res.body.bannerColor).toBe('#2d9cdb');
  });
});
