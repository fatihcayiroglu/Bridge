// server/tests/admin-privilege-boundary.test.ts
// FAZ D / ADMIN — YETKİ YÜKSELTME SINIRLARI.
//
// ════════════════════════════════════════════════════════════════════════════
// NE KANITLAR
// ════════════════════════════════════════════════════════════════════════════
// Admin yetkisi GLOBAL bir platform bayrağıdır (`users.isAdmin`) ve
// `adminOnly` her istekte VERİTABANINDAN taze okur — token'daki eski bir
// iddiaya güvenilmez. Bu paket, bayrağın yükseltilebileceği yolları kapatır:
//
//   1. sıradan kullanıcı admin ucunu kullanamaz,
//   2. kullanıcı KENDİ profil güncellemesiyle `isAdmin` alamaz
//      (`PATCH /auth/me` beyaz liste kullanır — mass assignment yok),
//   3. bootstrap ucu sunucu sırrı olmadan çalışmaz ve sır tanımsızsa
//      fail-closed davranır,
//   4. admin kendini değiştiremez/silemez,
//   5. audit kaydındaki aktör istek gövdesinden SAHTELENEMEZ.
//
// Not: Bu üründe düz (flat) bir global admin modeli vardır; admin'ler arası
// hiyerarşi YOKTUR. Var olmayan bir hiyerarşi semantiği UYDURULMAZ.

process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV       = 'test';

import { present } from './helpers/narrow';
import { createMockDb, requireDoc } from './helpers/mockDb';
const mockDb = createMockDb();

jest.mock('../db/index', () => mockDb);
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (
    req: { headers: { authorization?: string }; user?: unknown },
    res: { status: (c: number) => { json: (b: unknown) => unknown } },
    next: () => void,
  ) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const jwt = require('jsonwebtoken');
    try { req.user = jwt.verify(h.slice(7), 'test-jwt-secret-long-enough-32chars!!'); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
  },
}));
jest.mock('../middleware/rateLimit', () => ({
  limits: {
    moderation: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    settings:   () => (_req: unknown, _res: unknown, next: () => void) => next(),
    write:      () => (_req: unknown, _res: unknown, next: () => void) => next(),
  },
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import request from 'supertest';
import express from 'express';
const jwt = require('jsonwebtoken');

import adminRouter from '../routes/admin';

// ── isAdmin GERCEK BOOLEAN'DIR ─────────────────────────────────────────────
// `users."isAdmin"` semada BOOLEAN'dir ve `pg` surucusu okurken HER ZAMAN
// gercek bir boolean dondurur; `1` olarak OKUNAMAZ. Mock artik PostgreSQL'e
// sadik (helpers/mockDb.ts: BOOLEAN_COLUMNS), bu yuzden iddialar da tamsayi
// yerine boolean olcer. Uretim yazma yollari da gercek boolean yaziyor
// (routes/admin/core.ts, routes/admin/users.ts).

const app = express();
app.use(express.json());
app.use('/api/admin', adminRouter);

const tok = (id: string) => jwt.sign({ id, username: id, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });

const ADMIN  = 'admin-1';
const ADMIN2 = 'admin-2';
const NORMAL = 'normal-1';
const VICTIM = 'kurban-1';

beforeEach(async () => {
  mockDb._reset?.();
  await mockDb.users.insert({ _id: ADMIN,  username: 'admin1',  displayName: 'A1', isAdmin: true });
  await mockDb.users.insert({ _id: ADMIN2, username: 'admin2',  displayName: 'A2', isAdmin: true });
  await mockDb.users.insert({ _id: NORMAL, username: 'normal',  displayName: 'N',  isAdmin: false });
  await mockDb.users.insert({ _id: VICTIM, username: 'kurban',  displayName: 'K',  isAdmin: false });
});

describe('ADMIN — yetki kapısı', () => {
  it('POZİTİF KONTROL: admin istatistiklere erişebilir', async () => {
    const res = await request(app).get('/api/admin/stats').set('Authorization', `Bearer ${tok(ADMIN)}`);

    expect(res.status).toBe(200);
  });

  it('GÜVENLİK: sıradan kullanıcı admin ucunu KULLANAMAZ', async () => {
    const res = await request(app).get('/api/admin/stats').set('Authorization', `Bearer ${tok(NORMAL)}`);

    expect(res.status).toBe(403);
  });

  it('GÜVENLİK: kimliksiz istek reddedilir', async () => {
    const res = await request(app).get('/api/admin/stats');

    expect(res.status).toBe(401);
  });

  it('GÜVENLİK: token admin İDDİA ETSE de veritabanı belirleyicidir', async () => {
    // Token'a sahte alanlar konur; `adminOnly` yine DB'den okur.
    const sahte = jwt.sign(
      { id: NORMAL, username: 'normal', v: 0, isAdmin: true, role: 'admin' },
      'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' },
    );

    const res = await request(app).get('/api/admin/stats').set('Authorization', `Bearer ${sahte}`);

    expect(res.status).toBe(403);
  });

  it('GÜVENLİK: admin yetkisi ALINDIĞINDA erişim ANINDA biter', async () => {
    // Aynı token; yalnız veritabanındaki bayrak düşürülür.
    const before = await request(app).get('/api/admin/stats').set('Authorization', `Bearer ${tok(ADMIN)}`);
    expect(before.status).toBe(200);

    await mockDb.users.update({ _id: ADMIN }, { $set: { isAdmin: false } });

    const after = await request(app).get('/api/admin/stats').set('Authorization', `Bearer ${tok(ADMIN)}`);
    expect(after.status).toBe(403);
  });
});

describe('ADMIN — kullanıcı mutasyonu sınırları', () => {
  it('POZİTİF KONTROL: admin başka kullanıcıyı yükseltebilir', async () => {
    const res = await request(app)
      .patch(`/api/admin/users/${VICTIM}`)
      .set('Authorization', `Bearer ${tok(ADMIN)}`)
      .send({ isAdmin: true });

    expect(res.status).toBe(200);
    const after = await requireDoc(mockDb.users, { _id: VICTIM });
    expect(after.isAdmin).toBe(true);
  });

  it('GÜVENLİK: admin KENDİNİ değiştiremez', async () => {
    const res = await request(app)
      .patch(`/api/admin/users/${ADMIN}`)
      .set('Authorization', `Bearer ${tok(ADMIN)}`)
      .send({ isAdmin: false });

    expect(res.status).toBe(400);
  });

  it('GÜVENLİK: admin KENDİNİ silemez', async () => {
    const res = await request(app)
      .delete(`/api/admin/users/${ADMIN}`)
      .set('Authorization', `Bearer ${tok(ADMIN)}`);

    expect(res.status).toBe(400);
    expect(await mockDb.users.findOne({ _id: ADMIN })).not.toBeNull();
  });

  it('GÜVENLİK: sıradan kullanıcı BAŞKASINI yükseltemez', async () => {
    const res = await request(app)
      .patch(`/api/admin/users/${VICTIM}`)
      .set('Authorization', `Bearer ${tok(NORMAL)}`)
      .send({ isAdmin: true });

    expect(res.status).toBe(403);
    const after = await requireDoc(mockDb.users, { _id: VICTIM });
    expect(after.isAdmin).toBe(false);
  });

  it('GÜVENLİK: `isAdmin` DIŞINDA alan atanamaz (mass assignment yok)', async () => {
    const res = await request(app)
      .patch(`/api/admin/users/${VICTIM}`)
      .set('Authorization', `Bearer ${tok(ADMIN)}`)
      .send({ isAdmin: true, username: 'ele-gecirildi', password: 'x', tokenVersion: 999 });

    expect(res.status).toBe(200);
    const after = await requireDoc(mockDb.users, { _id: VICTIM });
    expect(after.username).toBe('kurban');       // değişmedi
    expect(after.tokenVersion).not.toBe(999);
  });

  it('GÜVENLİK: boolean olmayan isAdmin açıkça reddedilir', async () => {
    const res = await request(app)
      .patch(`/api/admin/users/${VICTIM}`)
      .set('Authorization', `Bearer ${tok(ADMIN)}`)
      .send({ isAdmin: 'true' });

    expect(res.status).toBe(400);
    const after = await requireDoc(mockDb.users, { _id: VICTIM });
    expect(after.isAdmin).toBe(false);               // dize yükseltmez
  });

  it('bilinmeyen hedef 404 döner', async () => {
    const res = await request(app)
      .patch('/api/admin/users/yok-boyle-kullanici')
      .set('Authorization', `Bearer ${tok(ADMIN)}`)
      .send({ isAdmin: true });

    expect(res.status).toBe(404);
  });
});

describe('ADMIN — audit kaydı sahtelenemez', () => {
  it('GÜVENLİK: aktör istek gövdesinden DEĞİL, token’dan alınır', async () => {
    await request(app)
      .patch(`/api/admin/users/${VICTIM}`)
      .set('Authorization', `Bearer ${tok(ADMIN)}`)
      .send({ isAdmin: true, adminId: 'sahte-aktor', actor: 'sahte-aktor' });

    const logs = await mockDb.adminLogs.find({});
    const entry = logs.find((l: Record<string, unknown>) => l.action === 'update_user');
    expect(entry).toBeDefined();
    expect(present(entry, 'denetim kaydi').adminId).toBe(ADMIN);
    expect(present(entry, 'denetim kaydi').adminId).not.toBe('sahte-aktor');
  });
});

// Gerçek uç: POST /api/admin/make-first-admin — sır: ADMIN_SETUP_SECRET.
// (Durum kodları KESİN beklenir; `404` kabul edilseydi rota adı yanlış olsa
// bile testler boş yere geçerdi.)
describe('ADMIN — ilk-admin bootstrap ucu fail-closed', () => {
  const bootstrap = (body: unknown) =>
    request(app).post('/api/admin/make-first-admin').send(body as object);

  afterEach(() => { delete process.env.ADMIN_SETUP_SECRET; });

  it('GÜVENLİK: sunucu sırrı TANIMSIZKEN reddedilir (fail-closed)', async () => {
    delete process.env.ADMIN_SETUP_SECRET;

    const res = await bootstrap({ username: 'normal', secret: '' });

    expect(res.status).toBe(403);
    expect((await requireDoc(mockDb.users, { _id: NORMAL })).isAdmin).toBe(false);
  });

  it('GÜVENLİK: sır tanımsızken DOĞRU görünen bir sır da işe yaramaz', async () => {
    delete process.env.ADMIN_SETUP_SECRET;

    const res = await bootstrap({ username: 'normal', secret: 'herhangi-bir-sir' });

    expect(res.status).toBe(403);
    expect((await requireDoc(mockDb.users, { _id: NORMAL })).isAdmin).toBe(false);
  });

  it('GÜVENLİK: yanlış sır reddedilir', async () => {
    process.env.ADMIN_SETUP_SECRET = 'dogru-sir';

    const res = await bootstrap({ username: 'normal', secret: 'yanlis-sir' });

    expect(res.status).toBe(403);
    expect((await requireDoc(mockDb.users, { _id: NORMAL })).isAdmin).toBe(false);
  });

  it('GÜVENLİK: admin ZATEN varken doğru sırla bile yeni admin üretilmez', async () => {
    process.env.ADMIN_SETUP_SECRET = 'dogru-sir';

    const res = await bootstrap({ username: 'normal', secret: 'dogru-sir' });

    expect(res.status).toBe(400);
    expect((await requireDoc(mockDb.users, { _id: NORMAL })).isAdmin).toBe(false);
  });

  it('POZİTİF KONTROL: HİÇ admin yokken doğru sır ilk admini atar', async () => {
    // Mevcut adminler düşürülür → gerçek bootstrap senaryosu.
    await mockDb.users.update({ _id: ADMIN },  { $set: { isAdmin: false } });
    await mockDb.users.update({ _id: ADMIN2 }, { $set: { isAdmin: false } });
    process.env.ADMIN_SETUP_SECRET = 'dogru-sir';

    const res = await bootstrap({ username: 'normal', secret: 'dogru-sir' });

    expect(res.status).toBe(200);
    expect((await requireDoc(mockDb.users, { _id: NORMAL })).isAdmin).toBe(true);
  });
});
