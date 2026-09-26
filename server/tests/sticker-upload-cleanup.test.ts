// server/tests/sticker-upload-cleanup.test.ts
// POST /sticker-packs — yüklenen dosyaların başarısızlıkta temizlenmesi.
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN AYRI DOSYA
// ════════════════════════════════════════════════════════════════════════════
// `STICKER_UPLOAD_DIR` route modülünün YÜKLENME anında okunur
// (routes/sticker-packs.ts:82). ESM import'ları modül gövdesinin üstüne
// taşındığı için, ana test dosyasında env'i değiştirmek geç kalırdı.
// Burada env ÖNCE ayarlanır, router SONRA `require` edilir; böylece testler
// izole bir geçici dizine yazar ve depo içindeki `uploads/stickers` dizinine
// hiç dokunulmaz.
//
// ── DÜZELTİLEN GERÇEK SORUN ────────────────────────────────────────────────
// Multer dosyaları handler doğrulaması TAMAMLANMADAN diske yazar. Eskiden
// yalnız 403 yolu temizlik yapıyordu; 404 (sunucu yok), 400 (ad boş) ve 500
// yolları dosyaları sahipsiz bırakıyordu. Kalıcılık geldiğinde bu uyumsuzluk
// kalıcı çöp hâline gelirdi.

import fs   from 'fs';
import os   from 'os';
import path from 'path';

const TEST_UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-sticker-'));
process.env['STICKER_UPLOAD_DIR'] = TEST_UPLOAD_DIR;
process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV       = 'test';

// Referans-güvenli temizlik `db._pool` üzerinden sorgulanır; havuz stub'u
// açıkça istenir (bkz. helpers/mockDb.ts).
// ── GERCEK PNG BAYTLARI ─────────────────────────────────────────────────────
// Yukleme sahiplerine sihirli-bayt dogrulamasi eklendikten sonra
// (lib/uploadFileSafety.ts -> image/png icin 0x89 'P' 'N' 'G') sahte metin yuk
// DOGRU sekilde 400 ile reddediliyor. Fixture gercekci yapilir; koruma
// gevsetilmez.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb({ withPgPool: true }));
jest.mock('../lib/permissions', () => ({
  resolvePermissions: jest.fn(),
  hasPermission:      jest.fn(),
  PERMS: { VIEW_CHANNELS: 1, MANAGE_SERVER: 8, ADMINISTRATOR: 1 << 30 },
}));
jest.mock('../middleware/rateLimit', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  // limits.<x> KANONİK olarak FABRİKADIR.
  return { limits: new Proxy({}, { get: () => () => pass }) };
});

// Ana dosyadaki ikizle aynı gerekçe: PgCollection withTransaction'a katılamaz.
jest.mock('../db/postgres/transaction', () => ({
  withTransaction: async (fn: (client: unknown) => Promise<unknown>) => {
    const database = require('../db/loader');
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        if (/INSERT INTO sticker_packs/i.test(sql)) {
          await database.stickerPacks.insert({
            _id: params[0], serverId: params[1], name: params[2],
            description: params[3], authorId: params[4], createdAt: params[5], seq: 1,
          });
        } else if (/INSERT INTO sticker_pack_items/i.test(sql)) {
          await database.stickerPackItems.insert({
            _id: params[0], packId: params[1], name: params[2], url: params[3],
            tags: JSON.parse(String(params[4] ?? '[]')),
            width: params[5], height: params[6], position: params[7], createdAt: params[8],
          });
        }
        return { rows: [], rowCount: 1 };
      },
    };
    return fn(client);
  },
}));

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
const stickerRouter = require('../routes/sticker-packs');
const jwt   = require('jsonwebtoken');
const perms = require('../lib/permissions');
const db    = require('../db/loader');

const MANAGE_SERVER = 8;
const VIEW_CHANNELS = 1;

let app: express.Express;
let userId: string;
let serverId: string;
let token: string;

/** Yükleme dizinindeki dosya sayısı. */
function uploadCount(): number {
  return fs.existsSync(TEST_UPLOAD_DIR) ? fs.readdirSync(TEST_UPLOAD_DIR).length : 0;
}

beforeEach(async () => {
  jest.clearAllMocks();
  db._reset?.();
  for (const f of fs.readdirSync(TEST_UPLOAD_DIR)) {
    fs.unlinkSync(path.join(TEST_UPLOAD_DIR, f));
  }

  app = express();
  app.use(express.json());
  app.use('/api/servers/:serverId/sticker-packs', stickerRouter);

  userId   = uuidv4();
  serverId = uuidv4();
  token    = jwt.sign({ id: userId, v: 0 }, process.env.JWT_SECRET as string, { expiresIn: '1h' });

  await db.users.insert({ _id: userId, username: 'tester', displayName: 'Tester', tokenVersion: 0 });
  await db.servers.insert({ _id: serverId, name: 'TestServer', ownerId: userId });
  await db.members.insert({ userId, serverId, roles: [] });

  perms.resolvePermissions.mockResolvedValue(1);
  perms.hasPermission.mockImplementation(
    (_p: number, flag: number) => [VIEW_CHANNELS, MANAGE_SERVER].includes(flag),
  );
});

afterAll(() => {
  // Test artefaktlarını temizle — yalnız bu paketin geçici dizini.
  fs.rmSync(TEST_UPLOAD_DIR, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════════════════════
// O — başarılı oluşturma dosyaları KORUR
// ════════════════════════════════════════════════════════════════════════════
describe('POST — başarılı oluşturma', () => {
  it('O: yüklenen dosyalar diskte KALIR', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`)
      .field('name', 'Paketim')
      .attach('sticker', PNG_1X1, 'a.png')
      .attach('sticker', PNG_1X1, 'b.png');

    expect(res.status).toBe(201);
    expect(uploadCount()).toBe(2);
  });

  it('O2: kalıcı url gerçek dosya adına karşılık gelir', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`)
      .field('name', 'Paketim')
      .attach('sticker', PNG_1X1, 'a.png');

    const url: string = res.body.stickers[0].url;
    expect(fs.existsSync(path.join(TEST_UPLOAD_DIR, path.basename(url)))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// N — başarısız oluşturma YALNIZ kendi dosyalarını siler
// ════════════════════════════════════════════════════════════════════════════
describe('POST — başarısızlıkta dosya temizliği', () => {
  it('N1: izin reddinde (403) dosyalar silinir', async () => {
    perms.hasPermission.mockImplementation((_p: number, flag: number) => flag === VIEW_CHANNELS);

    const res = await request(app)
      .post(`/api/servers/${serverId}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`)
      .field('name', 'Paketim')
      .attach('sticker', PNG_1X1, 'a.png');

    expect(res.status).toBe(403);
    expect(uploadCount()).toBe(0);
  });

  it('N2: bilinmeyen sunucuda (404) dosyalar silinir', async () => {
    const res = await request(app)
      .post(`/api/servers/${uuidv4()}/sticker-packs`)   // db'de yok
      .set('Authorization', `Bearer ${token}`)
      .field('name', 'Paketim')
      .attach('sticker', PNG_1X1, 'a.png');

    expect(res.status).toBe(404);
    expect(uploadCount()).toBe(0);
  });

  it('N3: paket adı boşsa (400) dosyalar silinir', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`)
      .field('name', '   ')
      .attach('sticker', PNG_1X1, 'a.png');

    expect(res.status).toBe(400);
    expect(uploadCount()).toBe(0);
  });

  it('N4: kalıcılık hatasında (500) dosyalar silinir', async () => {
    const { ServerAssets } = require('../db/repositories');
    const spy = jest.spyOn(ServerAssets, 'createStickerPack')
      .mockRejectedValueOnce(new Error('db down'));

    const res = await request(app)
      .post(`/api/servers/${serverId}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`)
      .field('name', 'Paketim')
      .attach('sticker', PNG_1X1, 'a.png');

    expect(res.status).toBe(500);
    expect(uploadCount()).toBe(0);
    spy.mockRestore();
  });

  it('N5: temizlik YALNIZ bu isteğin dosyalarını siler', async () => {
    // Önce başarılı bir paket — dosyaları KALMALI.
    const ok = await request(app)
      .post(`/api/servers/${serverId}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`)
      .field('name', 'Kalici')
      .attach('sticker', PNG_1X1, 'kalici.png');
    expect(ok.status).toBe(201);
    expect(uploadCount()).toBe(1);

    // Sonra başarısız bir istek — yalnız KENDİ dosyasını silmeli.
    const bad = await request(app)
      .post(`/api/servers/${serverId}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`)
      .field('name', '   ')
      .attach('sticker', PNG_1X1, 'gecici.png');
    expect(bad.status).toBe(400);

    expect(uploadCount()).toBe(1);   // önceki paketin dosyası DURUYOR
    const survivor = path.basename(ok.body.stickers[0].url);
    expect(fs.existsSync(path.join(TEST_UPLOAD_DIR, survivor))).toBe(true);
  });

  it('N6: hata gövdesi dosya sistemi yolu SIZDIRMAZ', async () => {
    const res = await request(app)
      .post(`/api/servers/${uuidv4()}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`)
      .field('name', 'Paketim')
      .attach('sticker', PNG_1X1, 'a.png');

    const body = JSON.stringify(res.body);
    expect(body).not.toContain(TEST_UPLOAD_DIR);
    expect(body).not.toMatch(/[A-Za-z]:\\|\/tmp\/|\/var\//);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// M — MULTER SEVİYESİ HATALAR (handler HİÇ çalışmaz)
// ════════════════════════════════════════════════════════════════════════════
//
// ── DÜZELTİLEN GERÇEK SORUN ────────────────────────────────────────────────
// multer, rota gövdesinden ÖNCE hata verir: geçersiz format, dosya boyutu,
// dosya sayısı. O yolda rotadaki `catch` HİÇ çalışmadığı için:
//   1) hata status'suz olduğundan global errorHandler (errorHandler.ts:20)
//      onu 500 + "Internal server error"e çeviriyordu — kullanıcı kendi
//      düzeltebileceği bir hatayı sunucu hatası sanıyordu,
//   2) multer'ın o ana kadar YAZDIĞI dosyalar sahipsiz kalıyordu.
// Router seviyesindeki `uploadErrorHandler` ikisini de kapatır.
describe('POST — multer seviyesi hatalar 4xx döner ve dosya bırakmaz', () => {
  it('M1: geçersiz format 415 döner (500 DEĞİL) ve mesaj eyleme dönüktür', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`)
      .field('name', 'Paketim')
      .attach('sticker', PNG_1X1, { filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(415);
    expect(String(res.body.error)).toMatch(/PNG, WebP veya GIF/);
    expect(String(res.body.error)).not.toMatch(/Internal server error/i);
    expect(uploadCount()).toBe(0);
  });

  it('M2: 512 KB üstü dosya 413 döner ve dosya bırakmaz', async () => {
    const big = Buffer.alloc(512 * 1024 + 1, 0x61);

    const res = await request(app)
      .post(`/api/servers/${serverId}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`)
      .field('name', 'Paketim')
      .attach('sticker', big, { filename: 'buyuk.png', contentType: 'image/png' });

    expect(res.status).toBe(413);
    expect(uploadCount()).toBe(0);
  });

  it('M3: 50 dosya sınırı aşılırsa 400 döner ve dosya bırakmaz', async () => {
    let req = request(app)
      .post(`/api/servers/${serverId}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`)
      .field('name', 'Paketim');
    for (let i = 0; i < 51; i++) {
      req = req.attach('sticker', PNG_1X1, { filename: `s${i}.png`, contentType: 'image/png' });
    }

    const res = await req;

    expect(res.status).toBe(400);
    expect(uploadCount()).toBe(0);
  });

  it('M4: GÜVENLİK: multer hata gövdesi dosya sistemi yolu SIZDIRMAZ', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`)
      .field('name', 'Paketim')
      .attach('sticker', PNG_1X1, { filename: 'a.jpg', contentType: 'image/jpeg' });

    const body = JSON.stringify(res.body);
    expect(body).not.toContain(TEST_UPLOAD_DIR);
    expect(body).not.toMatch(/[A-Za-z]:\|\/tmp\/|\/var\//);
  });

  it('M5: geçerli dosyalar SINIR İÇİNDEyken 50 adet kabul edilir', async () => {
    let req = request(app)
      .post(`/api/servers/${serverId}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`)
      .field('name', 'Paketim');
    for (let i = 0; i < 50; i++) {
      req = req.attach('sticker', PNG_1X1, { filename: `s${i}.png`, contentType: 'image/png' });
    }

    const res = await req;

    expect(res.status).toBe(201);
    expect(res.body.stickers).toHaveLength(50);
    expect(uploadCount()).toBe(50);
  });
});
