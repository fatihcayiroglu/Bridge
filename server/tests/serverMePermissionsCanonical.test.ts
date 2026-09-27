// server/tests/serverMePermissionsCanonical.test.ts
// FAZ C2 — GET /api/servers/:sid/me/permissions  ·  KANONİK ÇÖZÜMLEME
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN AYRI BİR DOSYA
// ════════════════════════════════════════════════════════════════════════════
// `serverMePermissions.test.ts` sözleşmeyi (401/şekil/sızıntı) doğrular ama
// `getMemberPerms`i MOCK'lar — yani ucun izinleri GERÇEKTEN kanonik
// hesaplamadan aldığını KANITLAMAZ. Mock'lanmış bir uç, ayrı ve yanlış bir
// izin modeline bağlanmış olsa bile yeşil kalırdı.
//
// Bu paket HİÇBİR izin mantığını mock'lamaz: yalnız veritabanı sahte,
// `resolvePermissions` (server/lib/permissions.ts:78) gerçek çalışır.
// Böylece istemcinin gördüğü değer ile yazma rotalarının uyguladığı değer
// AYNI kaynaktan gelir ve sapamaz.
//
// EN KRİTİK KANIT: başka bir sunucudaki üyelik/rol durumu bu yanıtı
// ETKİLEYEMEZ (çapraz kiracı yetki sızıntısı yok).

process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV       = 'test';

import request from 'supertest';
import express from 'express';
const jwt = require('jsonwebtoken');

jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/index', () => {
  const { createMockDb } = require('./helpers/mockDb');
  return createMockDb();
});

// DİKKAT: `../routes/roles` BİLEREK mock'lanmaz — kanonik zincir budur:
//   route → getMemberPerms → resolvePermissions → repositories
jest.mock('../middleware/rateLimit', () => ({
  limits: {
    servers:  () => (_req: unknown, _res: unknown, next: () => void) => next(),
    channels: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    invite:   () => (_req: unknown, _res: unknown, next: () => void) => next(),
    write:    () => (_req: unknown, _res: unknown, next: () => void) => next(),
    // `../routes/roles` BİLEREK mock'lanmadığı için gerçek modül yüklenir ve
    // kendi limiter'ını ister.
    roles:    () => (_req: unknown, _res: unknown, next: () => void) => next(),
  },
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import serversRouter from '../routes/servers';
import { PERMS, DEFAULT_PERMISSIONS } from '../lib/permissions';
import type { MockDb, ServerFixture, UserFixture } from './helpers/mockDb';

const OWNER_ALL = 0x7FFFFFFF;

function makeToken(userId: string) {
  return jwt.sign({ id: userId, username: userId, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });
}

function buildApp() {
  const app = express();
  app.set('io', null);
  app.use(express.json());
  app.use('/api/servers', serversRouter);
  app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(500).json({ error: err.message }));
  return app;
}

let app: express.Express;
let db: MockDb;
let sahip: UserFixture;
let yonetici: UserFixture;
let uye: UserFixture;
let yabanci: UserFixture;
let srvA: ServerFixture;
let srvB: ServerFixture;

/** İstemcinin açıcı için sorduğu tek soru. */
const canManage = (perms: number): boolean =>
  (perms & PERMS.ADMINISTRATOR) !== 0 || (perms & PERMS.MANAGE_CHANNELS) !== 0;

beforeEach(async () => {
  const { createMockDb, makeUser, makeServer } = require('./helpers/mockDb');
  db = createMockDb();
  Object.assign(require('../db/index'), db);
  Object.assign(require('../db/loader'), db);

  sahip    = makeUser({ username: 'sahip' });
  yonetici = makeUser({ username: 'yonetici' });
  uye      = makeUser({ username: 'uye' });
  yabanci  = makeUser({ username: 'yabanci' });
  for (const u of [sahip, yonetici, uye, yabanci]) await db.users.insert(u);

  srvA = makeServer(sahip._id, { name: 'A' });
  srvB = makeServer(yonetici._id, { name: 'B' });   // yönetici B'nin SAHİBİ
  await db.servers.insert(srvA);
  await db.servers.insert(srvB);

  app = buildApp();
});

const get = (user: { _id: string }, sid: string) =>
  request(app).get(`/api/servers/${sid}/me/permissions`).set('Authorization', `Bearer ${makeToken(user._id)}`);

// ════════════════════════════════════════════════════════════════════════════
describe('C2 — me/permissions KANONİK hesaplamayı kullanır', () => {
  it('SAHİP tam yetki alır ve MANAGE_CHANNELS içerir', async () => {
    const res = await get(sahip, srvA._id);

    expect(res.status).toBe(200);
    expect(res.body.permissions).toBe(OWNER_ALL);
    expect(canManage(res.body.permissions)).toBe(true);
  });

  it('MANAGE_CHANNELS taşıyan ROL üyeye bu yetkiyi verir', async () => {
    await db.roles.insert({
      _id: 'rol-mod', serverId: srvA._id, name: 'Mod',
      permissions: PERMS.MANAGE_CHANNELS, position: 1, color: '#fff',
    });
    await db.members.insert({ _id: 'm1', userId: uye._id, serverId: srvA._id, roles: ['rol-mod'] });

    const res = await get(uye, srvA._id);

    expect(res.status).toBe(200);
    expect(canManage(res.body.permissions)).toBe(true);
  });

  it('rolsüz sıradan üye DEFAULT_PERMISSIONS alır ve MANAGE_CHANNELS ALMAZ', async () => {
    await db.members.insert({ _id: 'm2', userId: uye._id, serverId: srvA._id, roles: [] });

    const res = await get(uye, srvA._id);

    expect(res.body.permissions).toBe(DEFAULT_PERMISSIONS);
    expect(canManage(res.body.permissions)).toBe(false);
  });

  it('GÜVENLİK: üye olmayan 0 alır', async () => {
    const res = await get(yabanci, srvA._id);

    expect(res.body.permissions).toBe(0);
    expect(canManage(res.body.permissions)).toBe(false);
  });

  it('GÜVENLİK: var olmayan sunucu kimliği fail-closed (0)', async () => {
    const res = await get(sahip, 'hic-boyle-bir-sunucu-yok');

    expect(res.status).toBe(200);
    expect(res.body.permissions).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ÇAPRAZ KİRACI — C2'nin asıl dersi: URL yuvalanması aidiyet KANITLAMAZ
// ════════════════════════════════════════════════════════════════════════════
describe('C2 — GÜVENLİK: başka sunucudaki yetki BURAYA sızmaz', () => {
  it('B’nin SAHİBİ olmak A’da yetki VERMEZ', async () => {
    // yönetici B'nin sahibidir ve A'da hiç üye değildir.
    const a = await get(yonetici, srvA._id);
    const b = await get(yonetici, srvB._id);

    expect(b.body.permissions).toBe(OWNER_ALL);      // kendi sunucusunda tam
    expect(a.body.permissions).toBe(0);              // A'da hiç
    expect(canManage(a.body.permissions)).toBe(false);
  });

  it('GÜVENLİK: BAŞKA sunucuya ait rol kimliği üyeye yetki KAZANDIRMAZ', async () => {
    // Saldırı: A üyeliğinin roles dizisine B'nin güçlü rolünün kimliği yazılır.
    // `Roles.findByIdsInServer` serverId ile kapsadığı için bu rol çözülmemeli.
    await db.roles.insert({
      _id: 'rol-B-guclu', serverId: srvB._id, name: 'B Admin',
      permissions: PERMS.ADMINISTRATOR, position: 1, color: '#fff',
    });
    await db.members.insert({ _id: 'm3', userId: uye._id, serverId: srvA._id, roles: ['rol-B-guclu'] });

    const res = await get(uye, srvA._id);

    // ASIL KANIT: yabancı rolün ADMINISTRATOR biti SIZMAZ.
    expect(canManage(res.body.permissions)).toBe(false);
    expect(res.body.permissions & PERMS.ADMINISTRATOR).toBe(0);

    // Kanonik davranış (permissions.ts:94-97): `roles` dizisi BOŞ DEĞİL ama
    // hiçbiri bu sunucuda çözülmüyorsa taban `reduce(..., 0)` ile 0 olur —
    // DEFAULT_PERMISSIONS'a düşülmez. Yani sonuç beklenenden de DARdır.
    // Bu C2'nin getirdiği bir şey değil, mevcut kanonik semantiktir; burada
    // gözlemlenen gerçek davranış sabitlenir (0, fail-closed).
    expect(res.body.permissions).toBe(0);
    expect(DEFAULT_PERMISSIONS & PERMS.ADMINISTRATOR).toBe(0);
  });

  it('GÜVENLİK: A’daki üyelik B’nin yanıtını ETKİLEMEZ', async () => {
    await db.roles.insert({
      _id: 'rol-A-mod', serverId: srvA._id, name: 'A Mod',
      permissions: PERMS.MANAGE_CHANNELS, position: 1, color: '#fff',
    });
    await db.members.insert({ _id: 'm4', userId: uye._id, serverId: srvA._id, roles: ['rol-A-mod'] });

    const a = await get(uye, srvA._id);
    const b = await get(uye, srvB._id);

    expect(canManage(a.body.permissions)).toBe(true);
    expect(canManage(b.body.permissions)).toBe(false);
    expect(b.body.permissions).toBe(0);
  });
});
