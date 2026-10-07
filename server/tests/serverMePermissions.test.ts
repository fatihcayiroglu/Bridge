// server/tests/serverMePermissions.test.ts
// FAZ C2 — GET /api/servers/:sid/me/permissions
//
// Bu uç, istemcinin "MANAGE_CHANNELS varsa açıcıyı göster" kararını
// verebilmesi için eklendi. Kanal izin rotaları yetkilendirmeyi tam olarak
// aynı düzeyde yapar (`resolvePermissions(user, sid)`), bu yüzden sinyal ile
// gerçek kapı AYNI değeri kullanır ve sapamaz.
//
// KANITLANANLAR:
//   · kimlik doğrulaması ZORUNLU
//   · yalnız ÇAĞIRANIN kendi bitleri döner (başkasının izni sızmaz)
//   · üye olmayan / var olmayan sunucu için AYRIM YAPILMADAN 0 döner

process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV       = 'test';

import request from 'supertest';
import express from 'express';
const jwt = require('jsonwebtoken');

let mockDb: MockDb;

jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/index', () => {
  const { createMockDb } = require('./helpers/mockDb');
  mockDb = createMockDb();
  return mockDb;
});

// Çağıran → izin bitleri. Test içinden değiştirilir.
const permsByUser: Record<string, number> = {};

jest.mock('../routes/roles', () => ({
  getMemberPerms: async (userId: string) => permsByUser[userId] ?? 0,
  hasPermission:  () => true,
  PERMS:          { MANAGE_CHANNELS: 2, ADMINISTRATOR: 1 << 30 },
}));

jest.mock('../middleware/rateLimit', () => ({
  limits: {
    servers:  () => (_req: unknown, _res: unknown, next: () => void) => next(),
    channels: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    invite:   () => (_req: unknown, _res: unknown, next: () => void) => next(),
    write:    () => (_req: unknown, _res: unknown, next: () => void) => next(),
    moderation: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  },
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import serversRouter from '../routes/servers';
import type { MockDb, UserFixture } from './helpers/mockDb';

const MANAGE_CHANNELS = 1 << 1;
const SID = 'srv-A';

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

const url = (sid = SID) => `/api/servers/${sid}/me/permissions`;

let app: express.Express;
let db: MockDb;
let yonetici: UserFixture;
let sirasan: UserFixture;
let yabanci: UserFixture;

// authMiddleware kullanıcıyı GERÇEKTEN veritabanında arar; token tek başına
// yetmez. Bu yüzden kullanıcılar her testte tohumlanır.
beforeEach(async () => {
  const { createMockDb, makeUser } = require('./helpers/mockDb');
  db = createMockDb();
  Object.assign(require('../db/index'), db);
  Object.assign(require('../db/loader'), db);

  yonetici = makeUser({ username: 'yonetici' });
  sirasan  = makeUser({ username: 'sirasan' });
  yabanci  = makeUser({ username: 'yabanci' });
  await db.users.insert(yonetici);
  await db.users.insert(sirasan);
  await db.users.insert(yabanci);

  for (const k of Object.keys(permsByUser)) delete permsByUser[k];
  app = buildApp();
});

const get = (user: { _id: string }, sid = SID) =>
  request(app).get(url(sid)).set('Authorization', `Bearer ${makeToken(user._id)}`);

describe('C2 — GET /:sid/me/permissions', () => {
  it('kimlik doğrulaması olmadan 401', async () => {
    const res = await request(app).get(url());
    expect(res.status).toBe(401);
  });

  it('çağıranın ÇÖZÜLMÜŞ bitlerini döner', async () => {
    permsByUser[yonetici._id] = MANAGE_CHANNELS;

    const res = await get(yonetici);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ permissions: MANAGE_CHANNELS });
  });

  it('GÜVENLİK: BAŞKA kullanıcının izinleri sızmaz — herkes kendi bitini alır', async () => {
    permsByUser[yonetici._id] = MANAGE_CHANNELS;
    permsByUser[sirasan._id]  = 0;

    const a = await get(yonetici);
    const b = await get(sirasan);

    expect(a.body.permissions).toBe(MANAGE_CHANNELS);
    expect(b.body.permissions).toBe(0);
  });

  it('GÜVENLİK: üye olmayan 0 alır (fail-closed)', async () => {
    const res = await get(yabanci);

    expect(res.status).toBe(200);
    expect(res.body.permissions).toBe(0);
  });

  it('GÜVENLİK: var olmayan sunucu ile üye olunmayan sunucu AYNI yanıtı verir (varlık sızıntısı yok)', async () => {
    const yok      = await get(yabanci, 'hic-yok');
    const uyeDegil = await get(yabanci, SID);

    expect(yok.status).toBe(uyeDegil.status);
    expect(yok.body).toEqual(uyeDegil.body);
  });

  it('bozuk çözüm değeri 0 olarak normalize edilir', async () => {
    permsByUser[sirasan._id] = NaN as unknown as number;

    const res = await get(sirasan);

    expect(res.body.permissions).toBe(0);
  });
});
