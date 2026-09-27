// server/tests/avatar-banner-upload-security.test.ts
//
// AVATAR / BANNER YÜKLEME — MIME SAHTECİLİĞİ VE TÜR KISITI
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BU DOSYA VAR
// ════════════════════════════════════════════════════════════════════════════
// `POST /api/me/avatar` ve `/api/me/banner` üç ayrı güvenlik kontrolü taşır:
//
//   1. `fileFilter`      — MIME izin listesi (yalnızca jpeg/png/webp/gif)
//   2. `limits.fileSize` — avatar 5 MB, banner 10 MB
//   3. `checkMagicBytes` — beyan edilen MIME ile GERÇEK içerik uyuşmalı
//
// Üçü de TAMAMEN test edilmemişti. Kapsama bunu doğruladı: `routes/auth.ts`
// içinde 548-562, 570-580 (avatar) ve 600-614 (banner) satırları hiç
// çalışmıyordu.
//
// ── EN ÖNEMLİSİ: MAGIC BYTE KONTROLÜ ────────────────────────────────────────
// `fileFilter` yalnızca istemcinin BEYAN ETTİĞİ Content-Type'a bakar; onu
// saldırgan seçer. Yürütülebilir bir dosyayı `image/png` diye göndermek
// önemsizdir. Tek gerçek savunma, dosyanın İLK BAYTLARINI okuyup beyanla
// karşılaştırmaktır — ve uyuşmazsa dosyayı diskten SİLMEKTİR.
//
// Bu dosya o savunmayı gerçek çok parçalı (multipart) isteklerle sürer.

import request from 'supertest';
import express, { Express, Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import fs from 'fs';
import path from 'path';

process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV       = 'test';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createMockDb } = require('./helpers/mockDb');
const _db = createMockDb();

jest.mock('../db/loader', () => _db);
jest.mock('../db/index',  () => _db);

jest.mock('../lib/captcha', () => ({
  botFilterMiddleware:            () => (_q: Request, _s: Response, n: NextFunction) => n(),
  loginLockMiddleware:            (_q: Request, _s: Response, n: NextFunction) => n(),
  progressiveCaptchaMiddleware:   (_q: Request, _s: Response, n: NextFunction) => n(),
  captchaMiddleware:              (_q: Request, _s: Response, n: NextFunction) => n(),
  registrationThrottleMiddleware: (_q: Request, _s: Response, n: NextFunction) => n(),
  recordFailedLogin:              jest.fn().mockResolvedValue(undefined),
  recordSuccessfulLogin:          jest.fn().mockResolvedValue(undefined),
  checkSuspiciousLogin:           jest.fn().mockResolvedValue(undefined),
  recordRegistration:             jest.fn().mockResolvedValue(undefined),
  claimRegistrationSlot:          jest.fn().mockResolvedValue(true),
  _getIp:                         () => '127.0.0.1',
  GENERIC_LOGIN_ERROR:            'Invalid username or password',
}));

jest.mock('../middleware/rateLimit', () => ({
  rateLimit: () => (_q: Request, _s: Response, n: NextFunction) => n(),
  limits: new Proxy({}, { get: () => () => (_q: Request, _s: Response, n: NextFunction) => n() }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { router } = require('../routes/auth');

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api', router);
  app.use((err: Error, _q: Request, res: Response, _n: NextFunction) =>
    res.status(500).json({ error: err.message }));
  return app;
}
const app = buildApp();

// ── Gerçek bayt dizileri ────────────────────────────────────────────────────
// MAGIC tablosu ilk 12 bayta bakar (routes/upload.ts).
const PNG_BYTES  = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(9)]);
const GIF_BYTES  = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(6)]);
// Windows yurutulebilir dosyasi — "MZ" ile baslar, PNG DEGILDIR.
const EXE_BYTES  = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(10, 0x90)]);

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const AVATAR_DIR = path.join(UPLOAD_DIR, 'avatars');
const BANNER_DIR = path.join(UPLOAD_DIR, 'banners');

/** Testin diske biraktigi dosyalari sayar — sizinti kontrolu icin. */
const say = (dir: string) => {
  try { return fs.readdirSync(dir).length; } catch { return 0; }
};

let yaratilan: string[] = [];
function yeniDosyalariYakala(dir: string, oncekiListe: string[]) {
  try {
    const simdi = fs.readdirSync(dir);
    for (const f of simdi) if (!oncekiListe.includes(f)) yaratilan.push(path.join(dir, f));
  } catch { /* dizin yok */ }
}

beforeEach(() => { _db._reset?.(); yaratilan = []; });
afterEach(() => {
  // Test yalnizca KENDI yarattigi dosyalari siler.
  for (const f of yaratilan) { try { fs.unlinkSync(f); } catch { /* zaten yok */ } }
  yaratilan = [];
});

async function kayitliToken(username: string) {
  const r = await request(app).post('/api/register')
    .send({ username, password: 'yuklemeParola123' });
  return r.body.token as string;
}

// ════════════════════════════════════════════════════════════════════════════
// MIME SAHTECİLİĞİ — asıl savunma
// ════════════════════════════════════════════════════════════════════════════
describe('avatar — MIME sahteciliği', () => {
  it('SÖMÜRÜ: image/png BEYAN eden YÜRÜTÜLEBİLİR reddedilir', async () => {
    // `fileFilter` bunu GECIRIR (beyan edilen tur izinli). Tek savunma
    // magic byte kontrolu.
    const token = await kayitliToken('up_spoof');
    const once = (() => { try { return fs.readdirSync(AVATAR_DIR); } catch { return []; } })();

    const r = await request(app).post('/api/me/avatar')
      .set('Authorization', `Bearer ${token}`)
      .attach('avatar', EXE_BYTES, { filename: 'kotu.png', contentType: 'image/png' });

    yeniDosyalariYakala(AVATAR_DIR, once);
    expect({ status: r.status }).toEqual({ status: 400 });
    expect(String(r.body.error)).toMatch(/does not match/i);
  });

  it('sahte dosya DİSKTE BIRAKILMAZ', async () => {
    // Reddedip diskte birakmak, depolamayi zamanla doldurur ve dosya
    // baska bir yoldan servis edilirse gercek bir risk olur.
    const token = await kayitliToken('up_temizlik');
    const once = say(AVATAR_DIR);
    await request(app).post('/api/me/avatar')
      .set('Authorization', `Bearer ${token}`)
      .attach('avatar', EXE_BYTES, { filename: 'kotu.png', contentType: 'image/png' });
    expect({ artis: say(AVATAR_DIR) - once }).toEqual({ artis: 0 });
  });

  it('image/jpeg BEYAN eden PNG içeriği reddedilir', async () => {
    // Turler arasi uyusmazlik da yakalanmali.
    const token = await kayitliToken('up_capraz');
    const once = (() => { try { return fs.readdirSync(AVATAR_DIR); } catch { return []; } })();
    const r = await request(app).post('/api/me/avatar')
      .set('Authorization', `Bearer ${token}`)
      .attach('avatar', PNG_BYTES, { filename: 'x.jpg', contentType: 'image/jpeg' });
    yeniDosyalariYakala(AVATAR_DIR, once);
    expect({ status: r.status }).toEqual({ status: 400 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TÜR İZİN LİSTESİ
// ════════════════════════════════════════════════════════════════════════════
describe('avatar — tür kısıtı', () => {
  it('GÖRÜNTÜ OLMAYAN tür fileFilter tarafından reddedilir', async () => {
    const token = await kayitliToken('up_turkotu');
    const r = await request(app).post('/api/me/avatar')
      .set('Authorization', `Bearer ${token}`)
      .attach('avatar', Buffer.from('#!/bin/sh\necho hi'), { filename: 'a.sh', contentType: 'application/x-sh' });
    expect({ status: r.status }).toEqual({ status: 400 });
    expect(String(r.body.error)).toMatch(/Only images/i);
  });

  it('SVG reddedilir (betik taşıyabilir)', async () => {
    const token = await kayitliToken('up_svg');
    const r = await request(app).post('/api/me/avatar')
      .set('Authorization', `Bearer ${token}`)
      .attach('avatar', Buffer.from('<svg onload="alert(1)"></svg>'),
        { filename: 'x.svg', contentType: 'image/svg+xml' });
    expect({ status: r.status }).toEqual({ status: 400 });
  });

  it('DOSYA YOKSA 400 döner', async () => {
    const token = await kayitliToken('up_dosyasiz');
    const r = await request(app).post('/api/me/avatar')
      .set('Authorization', `Bearer ${token}`);
    expect({ status: r.status }).toEqual({ status: 400 });
  });

  it('kimlik doğrulaması OLMADAN erişilemez', async () => {
    const r = await request(app).post('/api/me/avatar')
      .attach('avatar', PNG_BYTES, { filename: 'a.png', contentType: 'image/png' });
    expect(r.status).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POZİTİF KONTROL — meşru yükleme ÇALIŞIR
// ════════════════════════════════════════════════════════════════════════════
describe('POZİTİF KONTROL: geçerli görüntüler kabul edilir', () => {
  it('GERÇEK PNG kabul edilir ve avatarUrl döner', async () => {
    // Bu olmadan tum testler "her seyi reddet" gibi bozuk bir uygulamada da
    // yesil kalirdi — ve kimse avatar yukleyemezdi.
    const token = await kayitliToken('up_png');
    const once = (() => { try { return fs.readdirSync(AVATAR_DIR); } catch { return []; } })();
    const r = await request(app).post('/api/me/avatar')
      .set('Authorization', `Bearer ${token}`)
      .attach('avatar', PNG_BYTES, { filename: 'iyi.png', contentType: 'image/png' });
    yeniDosyalariYakala(AVATAR_DIR, once);
    expect({ status: r.status, url: String(r.body.avatarUrl || '').startsWith('/uploads/avatars/') })
      .toEqual({ status: 200, url: true });
  });

  it('GERÇEK JPEG kabul edilir', async () => {
    const token = await kayitliToken('up_jpg');
    const once = (() => { try { return fs.readdirSync(AVATAR_DIR); } catch { return []; } })();
    const r = await request(app).post('/api/me/avatar')
      .set('Authorization', `Bearer ${token}`)
      .attach('avatar', JPEG_BYTES, { filename: 'iyi.jpg', contentType: 'image/jpeg' });
    yeniDosyalariYakala(AVATAR_DIR, once);
    expect({ status: r.status }).toEqual({ status: 200 });
  });

  it('avatarUrl kullanıcıya KALICI olarak yazılır', async () => {
    const token = await kayitliToken('up_kalici');
    const once = (() => { try { return fs.readdirSync(AVATAR_DIR); } catch { return []; } })();
    await request(app).post('/api/me/avatar')
      .set('Authorization', `Bearer ${token}`)
      .attach('avatar', PNG_BYTES, { filename: 'iyi.png', contentType: 'image/png' });
    yeniDosyalariYakala(AVATAR_DIR, once);
    const me = await request(app).get('/api/me').set('Authorization', `Bearer ${token}`);
    expect(String(me.body.avatarUrl || '')).toMatch(/^\/uploads\/avatars\//);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// BANNER — kardeş yol
// ════════════════════════════════════════════════════════════════════════════
describe('banner — kardeş yol aynı korumaları taşır', () => {
  it('MIME sahteciliği banner’da da reddedilir', async () => {
    // KARDES-YOL KURALI: bu projede ayni kontrolun bir yolda olup digerinde
    // olmamasi defalarca gercek acik uretti.
    const token = await kayitliToken('bn_spoof');
    const once = (() => { try { return fs.readdirSync(BANNER_DIR); } catch { return []; } })();
    const r = await request(app).post('/api/me/banner')
      .set('Authorization', `Bearer ${token}`)
      .attach('banner', EXE_BYTES, { filename: 'kotu.png', contentType: 'image/png' });
    yeniDosyalariYakala(BANNER_DIR, once);
    expect({ status: r.status }).toEqual({ status: 400 });
  });

  it('görüntü olmayan tür banner’da da reddedilir', async () => {
    const token = await kayitliToken('bn_tur');
    const r = await request(app).post('/api/me/banner')
      .set('Authorization', `Bearer ${token}`)
      .attach('banner', Buffer.from('x'), { filename: 'a.sh', contentType: 'application/x-sh' });
    expect({ status: r.status }).toEqual({ status: 400 });
  });

  it('POZİTİF KONTROL: geçerli GIF banner kabul edilir', async () => {
    const token = await kayitliToken('bn_gif');
    const once = (() => { try { return fs.readdirSync(BANNER_DIR); } catch { return []; } })();
    const r = await request(app).post('/api/me/banner')
      .set('Authorization', `Bearer ${token}`)
      .attach('banner', GIF_BYTES, { filename: 'iyi.gif', contentType: 'image/gif' });
    yeniDosyalariYakala(BANNER_DIR, once);
    expect({ status: r.status, url: String(r.body.bannerUrl || '').startsWith('/uploads/banners/') })
      .toEqual({ status: 200, url: true });
  });

  it('kimlik doğrulaması OLMADAN erişilemez', async () => {
    const r = await request(app).post('/api/me/banner')
      .attach('banner', PNG_BYTES, { filename: 'a.png', contentType: 'image/png' });
    expect(r.status).toBe(401);
  });
});
