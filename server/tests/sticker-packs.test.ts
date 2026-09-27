// server/tests/sticker-packs.test.ts
// routes/sticker-packs.ts — GERÇEK rota sözleşmesi ve yetkilendirme.
//
// ════════════════════════════════════════════════════════════════════════════
// FAZ 12 — STICKER API COVERAGE GAP KAPATMA
// ════════════════════════════════════════════════════════════════════════════
//
// NEDEN VAR: `routes/sticker-packs.ts` (GET/POST/DELETE/PATCH) üretimde CANLI
// ve `app/setupRoutes.ts:167` ile `/servers` altına mount ediliyor; buna karşın
// hiçbir testi yoktu (kapsam 0). Bu dosya GERÇEK router'ı Express'e bağlar ve
// supertest ile gerçek istekler atar; yalnız DB ve izin sınırları mock'lanır.
//
// KAPSANAN CANLI GÜVENCELER:
//   • kimlik doğrulama (authMiddleware) — token yoksa 401
//   • okuma için VIEW_CHANNELS, yazma/silme/güncelleme için MANAGE_SERVER
//   • sunucu kapsamı: bir sunucunun paketleri diğerine sızmaz
//   • POST doğrulama: sunucu var mı (404), ad zorunlu (400), dosya zorunlu (400)
//   • DELETE: bilinmeyen paket 404, başarılı silme 204
//   • PATCH: bilinmeyen paket/sticker 404, ad/tag güncelleme ve tag sınırlama
//
// ── KALICILIK (migrations_pg/021) ──────────────────────────────────────────
// Paketler ARTIK PostgreSQL'de tutulur. Önceki sürümde `_stickerPacks` adlı
// modül-içi bir Map kullanılıyordu: durum süreç başına yaşıyor, yeniden
// başlatmada kayboluyor ve çok süreçli çalışmada ayrışıyordu
// (STICKER_PACK_STORAGE_IN_MEMORY). Bu kayıt KAPANDI.
//
// Yukarıdaki 23 sözleşme geçiş sırasında DEĞİŞTİRİLMEDİ — genel API'nin
// aynı kaldığının kanıtıdır. Dosyanın sonundaki "KALICILIK SÖZLEŞMESİ" bloğu
// geçişin ürettiği YENİ garantileri korur.

// ── GERCEK PNG BAYTLARI ─────────────────────────────────────────────────────
// Bu dosya eskiden sahte bir metin yuku ("img") yukluyordu. Inceleme sirasinda
// yukleme sahiplerine IMZA/SIHIRLI-BAYT dogrulamasi eklendi
// (lib/uploadFileSafety.ts:57 -> image/png icin 0x89 'P' 'N' 'G'), dolayisiyla
// o yuk artik DOGRU sekilde 400 ile reddediliyor ve bu suitteki 23 test
// dusuyordu.
//
// Cozum imzayi gevsetmek DEGIL, fixture'i GERCEKCI yapmaktir: asagidaki 1x1
// saydam PNG gecerli bir dosyadir. Imza korumasi yururlukte kalir; dosyanin
// sonundaki negatif test onu ACIKCA olcer.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV       = 'test';

// Yüklemeler İZOLE bir geçici dizine yazılır. Aksi hâlde her POST testi
// depo içindeki `server/uploads/stickers` dizinine kalıcı dosya bırakır.
// `STICKER_UPLOAD_DIR` route modülünün YÜKLENME anında okunduğu için
// (routes/sticker-packs.ts:82) bu atama router `require` edilmeden ÖNCE
// çalışmalıdır — router bu yüzden aşağıda `import` ile değil `require` ile
// alınır (import bildirimleri dosyanın başına taşınırdı).
const STICKER_TEST_DIR = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'bridge-stickers-'),
);
process.env['STICKER_UPLOAD_DIR'] = STICKER_TEST_DIR;

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../lib/permissions', () => ({
  resolvePermissions: jest.fn(),
  hasPermission:      jest.fn(),
  PERMS: { VIEW_CHANNELS: 1, MANAGE_SERVER: 8, ADMINISTRATOR: 1 << 30 },
}));

// Hız sınırlayıcı Redis destekli (middleware/rateLimit.ts:107); test ortamında
// bağlantı beklemesi istekleri askıda bırakıyor. Sınırlama bu dosyanın öznesi
// değildir — geçişli ara katmanla değiştirilir.
jest.mock('../middleware/rateLimit', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  // limits.<x> KANONİK olarak FABRİKADIR: limits.x() middleware döndürür.
      return { limits: new Proxy({}, { get: () => () => pass }) };
});

// ── TRANSACTION SEAM (sürücü seviyesinde test ikizi) ───────────────────────
// Oluşturma yolu ATOMİK olmak zorunda olduğu için ham SQL + withTransaction
// kullanır: `PgCollection._query` her çağrıda pool'dan KENDİ bağlantısını alır
// (pgCollection.ts:255), dolayısıyla withTransaction'ın BEGIN'ine katılamaz.
//
// Bu dosya zaten `db/loader`'ın tamamını mock'lar; transaction istemcisini de
// AYNI seviyede mock'lamak tutarlıdır. İkiz, repository'nin INSERT'lerini
// konumsal parametrelerle mockDb'ye yazar; böylece 23 mevcut sözleşme gerçek
// route + gerçek repository kodunu çalıştırmaya devam eder.
//
// SINIR: bu ikiz SQL'i DOĞRULAMAZ ve ROLLBACK uygulamaz.
// Gerçek atomiklik/geri alma kanıtı `scripts/verify-sticker-persistence.ts`
// betiğidir (gerçek pool + gerçek transaction) — atomiklik için yetkili
// kaynak odur; bu ikiz değil.
jest.mock('../db/postgres/transaction', () => {
  let seqCounter = 0;
  return {
    withTransaction: async (fn: (client: unknown) => Promise<unknown>) => {
      const database = require('../db/loader');
      const client = {
        query: async (sql: string, params: unknown[] = []) => {
          if (/INSERT INTO sticker_packs/i.test(sql)) {
            await database.stickerPacks.insert({
              _id: params[0], serverId: params[1], name: params[2],
              description: params[3], authorId: params[4], createdAt: params[5],
              seq: ++seqCounter,   // BIGSERIAL karşılığı: monoton artan
            });
          } else if (/INSERT INTO sticker_pack_items/i.test(sql)) {
            await database.stickerPackItems.insert({
              _id: params[0], packId: params[1], name: params[2], url: params[3],
              tags: JSON.parse(String(params[4] ?? '[]')),
              width: params[5], height: params[6], position: params[7],
              createdAt: params[8],
            });
          }
          return { rows: [], rowCount: 1 };
        },
      };
      return fn(client);
    },
  };
});

// NOT: `../db/repositories` MOCK'LANMAZ. Gerçek depolar mock'lanmış
// `db/loader` üzerinden çalışır; böylece authMiddleware'in ihtiyaç duyduğu
// `Users.findById` de mevcut kalır (yalnız `Servers` mock'lansaydı kimlik
// doğrulama 500 "Auth check failed" verirdi).

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
const stickerRouter = require('../routes/sticker-packs');  // require: env atamasindan SONRA yuklenmeli
const jwt = require('jsonwebtoken');
const perms = require('../lib/permissions');
const db = require('../db/loader');
import { requireDoc } from './helpers/mockDb';

/**
 * Üretimdeki mount ile BİREBİR aynı (app/setupRoutes.ts:167):
 *   mountApi('/servers/:serverId/sticker-packs', stickerPacksRouter)
 * `:serverId` mount yolundan gelir ve router'ın `mergeParams: true` ayarıyla
 * handler'lara aktarılır. Faz 12'de düzeltilen yönlendirme hatası tam olarak
 * buydu: eski mount `/servers` idi, `:serverId` hiç dolmuyordu.
 */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers/:serverId/sticker-packs', stickerRouter);
  return app;
}
function tok(uid: string, v = 0): string {
  return jwt.sign({ id: uid, v }, process.env.JWT_SECRET as string, { expiresIn: '1h' });
}

/** İzin sonucunu tek yerden kontrol et. */
function grant(flags: number[]): void {
  perms.resolvePermissions.mockResolvedValue(1);
  perms.hasPermission.mockImplementation((_p: number, flag: number) => flags.includes(flag));
}

const VIEW_CHANNELS = 1;
const MANAGE_SERVER = 8;

let app: express.Express;
let userId: string;
let serverId: string;
let token: string;

beforeEach(async () => {
  jest.clearAllMocks();
  db._reset?.();
  app = buildApp();
  userId = uuidv4();
  serverId = uuidv4();
  token = tok(userId);

  // authMiddleware tokenVersion doğrular (middleware/auth.ts:331-361) —
  // kullanıcı kaydı olmadan her istek 500 "Auth check failed" döner.
  await db.users.insert({ _id: userId, username: 'tester', displayName: 'Tester', tokenVersion: 0 });
  await db.servers.insert({ _id: serverId, name: 'TestServer', ownerId: userId });
  await db.members.insert({ userId, serverId, roles: [] });

  grant([VIEW_CHANNELS, MANAGE_SERVER]);
});

afterAll(() => {
  // Bu paketin urettigi TUM yukleme artefaktlarini kaldir (yalniz kendi
  // gecici dizini — depo icindeki uploads/ dizinine hic dokunulmaz).
  require('fs').rmSync(STICKER_TEST_DIR, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════════════════════
// Kimlik doğrulama
// ════════════════════════════════════════════════════════════════════════════
describe('sticker-packs — kimlik doğrulama', () => {
  it('token olmadan listeleme reddedilir', async () => {
    const res = await request(app).get(`/api/servers/${serverId}/sticker-packs`);

    expect(res.status).toBe(401);
  });

  it('token olmadan silme reddedilir', async () => {
    const res = await request(app).delete(`/api/servers/${serverId}/sticker-packs/pack-1`);

    expect(res.status).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET — okuma izni
// ════════════════════════════════════════════════════════════════════════════
describe('GET /sticker-packs', () => {
  it('VIEW_CHANNELS izni olan üye listeyi alır', async () => {
    const res = await request(app)
      .get(`/api/servers/${serverId}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GÜVENLİK: VIEW_CHANNELS izni yoksa 403', async () => {
    grant([MANAGE_SERVER]); // görüntüleme izni YOK
    const res = await request(app)
      .get(`/api/servers/${serverId}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it('izin çözümlemesi istenen sunucu kapsamıyla yapılır', async () => {
    await request(app)
      .get(`/api/servers/${serverId}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`);

    expect(perms.resolvePermissions).toHaveBeenCalledWith(userId, serverId);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST — oluşturma yetkisi ve doğrulama
// ════════════════════════════════════════════════════════════════════════════
describe('POST /sticker-packs', () => {
  it('GÜVENLİK: MANAGE_SERVER izni yoksa 403', async () => {
    grant([VIEW_CHANNELS]);
    const res = await request(app)
      .post(`/api/servers/${serverId}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`)
      .field('name', 'Paketim')
      .attach('sticker', PNG_1X1, 'a.png');

    expect(res.status).toBe(403);
  });

  it('sunucu yoksa 404', async () => {
    const unknownServer = uuidv4();   // db'ye eklenmedi → Servers.findById null
    const res = await request(app)
      .post(`/api/servers/${unknownServer}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`)
      .field('name', 'Paketim')
      .attach('sticker', PNG_1X1, 'a.png');

    expect(res.status).toBe(404);
  });

  it('paket adı boşsa 400', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`)
      .field('name', '   ')
      .attach('sticker', PNG_1X1, 'a.png');

    expect(res.status).toBe(400);
  });

  it('hiç dosya yoksa 400', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`)
      .field('name', 'Paketim');

    expect(res.status).toBe(400);
  });

  it('geçerli istek 201 ve paket döner', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`)
      .field('name', 'Paketim')
      .field('description', 'açıklama')
      .attach('sticker', PNG_1X1, 'kedi.png');

    expect(res.status).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({
      serverId, name: 'Paketim', description: 'açıklama', authorId: userId,
    }));
    expect(res.body.stickers).toHaveLength(1);
    expect(res.body.stickers[0].name).toBe('kedi');   // uzantı düşürülür
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Sunucu kapsamı — sızıntı olmamalı
// ════════════════════════════════════════════════════════════════════════════
describe('sunucu kapsamı', () => {
  it('REGRESYON: belgelenen yol erişilebilir ve gerçek serverId taşınır', async () => {
    // Yönlendirme hatasında bu istek 404 dönüyordu ve resolvePermissions
    // hiç çağrılmıyordu (serverId boş kalıyordu).
    const res = await request(app)
      .get(`/api/servers/${serverId}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(perms.resolvePermissions).toHaveBeenCalledWith(userId, serverId);
  });

  it('GÜVENLİK: başka sunucunun paketi SİLİNEMEZ (kapsam dışı 404)', async () => {
    const created = await request(app)
      .post(`/api/servers/${serverId}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`)
      .field('name', 'A-Sunucusu')
      .attach('sticker', PNG_1X1, 'a.png');
    expect(created.status).toBe(201);

    const otherServer = uuidv4();
    const del = await request(app)
      .delete(`/api/servers/${otherServer}/sticker-packs/${created.body._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(del.status).toBe(404);   // kapsam dışı — silinemez

    // Orijinal paket hâlâ yerinde.
    const list = await request(app)
      .get(`/api/servers/${serverId}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`);
    expect(list.body.find((p: { _id: string }) => p._id === created.body._id)).toBeDefined();
  });

  it('GÜVENLİK: başka sunucudan sticker GÜNCELLENEMEZ', async () => {
    const created = await request(app)
      .post(`/api/servers/${serverId}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`)
      .field('name', 'A-Sunucusu')
      .attach('sticker', PNG_1X1, 'a.png');

    const otherServer = uuidv4();
    const patch = await request(app)
      .patch(`/api/servers/${otherServer}/sticker-packs/${created.body._id}/stickers/${created.body.stickers[0].id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'ele-gecirildi' });

    expect(patch.status).toBe(404);
  });

  it('GÜVENLİK: bir sunucunun paketi başka sunucuda GÖRÜNMEZ', async () => {
    const otherServer = uuidv4();
    await request(app)
      .post(`/api/servers/${serverId}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`)
      .field('name', 'Yalnız-A')
      .attach('sticker', PNG_1X1, 'a.png');

    const res = await request(app)
      .get(`/api/servers/${otherServer}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DELETE
// ════════════════════════════════════════════════════════════════════════════
describe('DELETE /sticker-packs/:packId', () => {
  it('GÜVENLİK: MANAGE_SERVER yoksa 403', async () => {
    grant([VIEW_CHANNELS]);
    const res = await request(app)
      .delete(`/api/servers/${serverId}/sticker-packs/any`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it('bilinmeyen paket 404', async () => {
    const res = await request(app)
      .delete(`/api/servers/${serverId}/sticker-packs/yok`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it('var olan paket silinir (204) ve listeden düşer', async () => {
    const created = await request(app)
      .post(`/api/servers/${serverId}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`)
      .field('name', 'Silinecek')
      .attach('sticker', PNG_1X1, 'a.png');

    const del = await request(app)
      .delete(`/api/servers/${serverId}/sticker-packs/${created.body._id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(204);

    const list = await request(app)
      .get(`/api/servers/${serverId}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`);
    expect(list.body.find((p: { _id: string }) => p._id === created.body._id)).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH
// ════════════════════════════════════════════════════════════════════════════
describe('PATCH /sticker-packs/:packId/stickers/:stickerId', () => {
  async function createPack(): Promise<{ packId: string; stickerId: string }> {
    const res = await request(app)
      .post(`/api/servers/${serverId}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`)
      .field('name', 'Paket')
      .attach('sticker', PNG_1X1, 'orijinal.png');
    return { packId: res.body._id, stickerId: res.body.stickers[0].id };
  }

  it('GÜVENLİK: MANAGE_SERVER yoksa 403', async () => {
    const { packId, stickerId } = await createPack();
    grant([VIEW_CHANNELS]);

    const res = await request(app)
      .patch(`/api/servers/${serverId}/sticker-packs/${packId}/stickers/${stickerId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'yeni' });

    expect(res.status).toBe(403);
  });

  it('bilinmeyen paket 404', async () => {
    const res = await request(app)
      .patch(`/api/servers/${serverId}/sticker-packs/yok/stickers/yok`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'x' });

    expect(res.status).toBe(404);
  });

  it('bilinmeyen sticker 404', async () => {
    const { packId } = await createPack();

    const res = await request(app)
      .patch(`/api/servers/${serverId}/sticker-packs/${packId}/stickers/yok`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'x' });

    expect(res.status).toBe(404);
  });

  it('ad güncellenir', async () => {
    const { packId, stickerId } = await createPack();

    const res = await request(app)
      .patch(`/api/servers/${serverId}/sticker-packs/${packId}/stickers/${stickerId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '  yeni-ad  ' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('yeni-ad');
  });

  it('etiketler en fazla 10 taneye sınırlanır', async () => {
    const { packId, stickerId } = await createPack();

    const res = await request(app)
      .patch(`/api/servers/${serverId}/sticker-packs/${packId}/stickers/${stickerId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tags: Array.from({ length: 25 }, (_, i) => `t${i}`) });

    expect(res.body.tags).toHaveLength(10);
  });

  it('etiket uzunluğu 32 karakterle sınırlanır', async () => {
    const { packId, stickerId } = await createPack();

    const res = await request(app)
      .patch(`/api/servers/${serverId}/sticker-packs/${packId}/stickers/${stickerId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tags: ['x'.repeat(50)] });

    expect(res.body.tags[0]).toHaveLength(32);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// KALICILIK SÖZLEŞMESİ — migrations_pg/021
// ════════════════════════════════════════════════════════════════════════════
//
// Bu blok, Map'ten PostgreSQL'e geçişin ürettiği YENİ garantileri korur.
// Atomiklik ve yeniden başlatma dayanıklılığı burada DEĞİL, gerçek PostgreSQL
// betiğinde kanıtlanır (scripts/verify-sticker-persistence.ts) — mockDb
// ROLLBACK uygulamaz ve süreç yeniden başlatmayı taklit edemez.

/** Verilen dosya adlarıyla bir paket oluşturur ve yanıt gövdesini döndürür. */
async function createPackWith(
  files: string[],
  packName = 'Paket',
  sid: string = serverId,
): Promise<Record<string, any>> {
  let req = request(app)
    .post(`/api/servers/${sid}/sticker-packs`)
    .set('Authorization', `Bearer ${token}`)
    .field('name', packName);
  for (const f of files) req = req.attach('sticker', PNG_1X1, f);
  const res = await req;
  expect(res.status).toBe(201);
  return res.body;
}

/** Sunucunun paketlerini genel API üzerinden okur. */
async function listPacks(sid: string = serverId): Promise<Record<string, any>[]> {
  const res = await request(app)
    .get(`/api/servers/${sid}/sticker-packs`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body;
}

describe('kalıcılık — doğruluk kaynağı veritabanıdır', () => {
  it('A: paket ve öğeler VERİTABANI satırları olarak yazılır (modül belleği değil)', async () => {
    const pack = await createPackWith(['a.png'], 'Kalıcı');

    const packRow  = await db.stickerPacks.findOne({ _id: pack._id });
    const itemRows = await db.stickerPackItems.find({ packId: pack._id });

    expect(packRow).not.toBeNull();
    expect(packRow.serverId).toBe(serverId);
    expect(itemRows).toHaveLength(1);
  });

  it('A2: TAZE route örneği önceki örneğin yazdığı paketi görür', async () => {
    // Eski uygulamada durum route modülünün İÇİNDEydi; modülü yeniden yüklemek
    // tüm paketleri siliyordu. Artık route durumsuzdur — aynı db paylaşılınca
    // taze bir router örneği aynı veriyi görür.
    const pack = await createPackWith(['a.png'], 'Modulden-Bagimsiz');
    const sharedDb    = require('../db/loader');
    const sharedPerms = require('../lib/permissions');

    jest.resetModules();
    jest.doMock('../db/loader', () => sharedDb);
    jest.doMock('../lib/permissions', () => sharedPerms);
    jest.doMock('../middleware/rateLimit', () => {
      const pass = (_q: unknown, _s: unknown, next: () => void) => next();
      // limits.<x> KANONİK olarak FABRİKADIR: limits.x() middleware döndürür.
      return { limits: new Proxy({}, { get: () => () => pass }) };
    });
    const freshRouter = require('../routes/sticker-packs');

    const freshApp = express();
    freshApp.use(express.json());
    freshApp.use('/api/servers/:serverId/sticker-packs', freshRouter);

    const res = await request(freshApp)
      .get(`/api/servers/${serverId}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.find((p: { _id: string }) => p._id === pack._id)).toBeDefined();
  });
});

describe('kalıcılık — genel gövde şekli korunur', () => {
  it('B: listelenen paket POST ile AYNI genel şekle sahiptir', async () => {
    const created = await createPackWith(['kedi.png'], 'Sekil');

    const listed = (await listPacks()).find(p => p._id === created._id)!;

    expect(Object.keys(listed).sort()).toEqual(Object.keys(created).sort());
    expect(listed).toEqual(created);
  });

  it('C: createdAt SAYIdır, string değil', async () => {
    const created = await createPackWith(['a.png'], 'Zaman');

    const listed = (await listPacks()).find(p => p._id === created._id)!;

    expect(typeof created.createdAt).toBe('number');
    expect(typeof listed.createdAt).toBe('number');   // BIGINT → Number()
    expect(listed.createdAt).toBe(created.createdAt);
  });

  it('D: genel sticker anahtarı `id`dir, `_id` DEĞİL', async () => {
    const created = await createPackWith(['a.png'], 'Kimlik');

    const sticker = (await listPacks()).find(p => p._id === created._id)!.stickers[0];

    expect(typeof sticker.id).toBe('string');
    expect(sticker.id.length).toBeGreaterThan(0);
    expect(sticker).not.toHaveProperty('_id');
  });

  it('E: DB-ÖZEL alanlar (seq/position) API yanıtına SIZMAZ', async () => {
    const created = await createPackWith(['a.png', 'b.png'], 'Sizinti');

    const pack = (await listPacks()).find(p => p._id === created._id)!;

    expect(pack).not.toHaveProperty('seq');
    for (const s of pack.stickers) {
      expect(Object.keys(s).sort()).toEqual(
        ['height', 'id', 'name', 'packId', 'tags', 'url', 'width'],
      );
    }
    // Satırda gerçekten var — yalnızca yayınlanmıyor.
    const row = await db.stickerPackItems.findOne({ packId: created._id });
    expect(row.position).toBeDefined();
  });
});

describe('kalıcılık — belirlenimci sıralama', () => {
  it('F: paketler EKLEME sırasını korur (aynı milisaniyede bile)', async () => {
    // createdAt tek başına yeterli değildir; sıra dahili `seq` ile gelir.
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const first  = await createPackWith(['a.png'], 'Birinci');
    const second = await createPackWith(['b.png'], 'Ikinci');
    const third  = await createPackWith(['c.png'], 'Ucuncu');
    now.mockRestore();

    expect(first.createdAt).toBe(second.createdAt);   // gerçekten aynı ms

    const packs = await listPacks();
    expect(packs.map(p => p.name)).toEqual(['Birinci', 'Ikinci', 'Ucuncu']);
    expect(packs.map(p => p._id)).toEqual([first._id, second._id, third._id]);
  });

  it('G: sticker’lar YÜKLEME sırasını korur', async () => {
    const created = await createPackWith(['1.png', '2.png', '3.png', '4.png'], 'Sira');

    const pack = (await listPacks()).find(p => p._id === created._id)!;

    expect(pack.stickers.map((s: { name: string }) => s.name)).toEqual(['1', '2', '3', '4']);
    // Listeleme sırası POST yanıtıyla birebir aynı.
    expect(pack.stickers.map((s: { id: string }) => s.id))
      .toEqual(created.stickers.map((s: { id: string }) => s.id));
  });

  it('G2: tekrarlanan okumalar AYNI sırayı verir', async () => {
    await createPackWith(['a.png'], 'A');
    await createPackWith(['b.png'], 'B');

    const first  = (await listPacks()).map(p => p._id);
    const second = (await listPacks()).map(p => p._id);

    expect(first).toEqual(second);
  });
});

describe('kalıcılık — çocuk satır temizliği', () => {
  it('H: paket silinince ÖĞE SATIRLARI da gider', async () => {
    const created = await createPackWith(['a.png', 'b.png'], 'Silinecek');
    expect(await db.stickerPackItems.find({ packId: created._id })).toHaveLength(2);

    await request(app)
      .delete(`/api/servers/${serverId}/sticker-packs/${created._id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    expect(await db.stickerPacks.findOne({ _id: created._id })).toBeNull();
    expect(await db.stickerPackItems.find({ packId: created._id })).toHaveLength(0);
  });

  it('L: sunucu silme temizliği YALNIZ o sunucunun paketlerini kaldırır', async () => {
    const mine = await createPackWith(['a.png'], 'Benim');
    const otherServer = uuidv4();
    await db.servers.insert({ _id: otherServer, name: 'Diger', ownerId: userId });
    await db.members.insert({ userId, serverId: otherServer, roles: [] });
    const theirs = await createPackWith(['b.png'], 'Onlarin', otherServer);

    // routes/servers/core.ts silme bloğunun çağırdığı GERÇEK repository yolu.
    const { ServerAssets } = require('../db/repositories');
    await ServerAssets.deleteStickerPacksByServer(serverId);

    expect(await db.stickerPacks.findOne({ _id: mine._id })).toBeNull();
    expect(await db.stickerPackItems.find({ packId: mine._id })).toHaveLength(0);
    // Diğer sunucu ETKİLENMEZ.
    expect(await db.stickerPacks.findOne({ _id: theirs._id })).not.toBeNull();
    expect(await db.stickerPackItems.find({ packId: theirs._id })).toHaveLength(1);
  });
});

describe('kalıcılık — sunucular arası yalıtım (satır düzeyi)', () => {
  it('I: A sunucusunun paketi B sunucusunun listesinde GÖRÜNMEZ', async () => {
    const mine = await createPackWith(['a.png'], 'Yalniz-A');
    const otherServer = uuidv4();

    expect(await listPacks(otherServer)).toEqual([]);
    // Satır hâlâ duruyor — yalnızca kapsam dışı.
    expect(await db.stickerPacks.findOne({ _id: mine._id })).not.toBeNull();
  });

  it('J: B sunucusundan A sunucusunun sticker’ı GÜNCELLENEMEZ (satır değişmez)', async () => {
    const mine = await createPackWith(['a.png'], 'A-Paket');
    const stickerId = mine.stickers[0].id;
    const otherServer = uuidv4();

    const res = await request(app)
      .patch(`/api/servers/${otherServer}/sticker-packs/${mine._id}/stickers/${stickerId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'ele-gecirildi' });

    expect(res.status).toBe(404);
    const row = await db.stickerPackItems.findOne({ _id: stickerId });
    expect(row.name).toBe('a');   // DEĞİŞMEDİ
  });

  it('K: B sunucusundan A sunucusunun paketi SİLİNEMEZ (satırlar durur)', async () => {
    const mine = await createPackWith(['a.png'], 'A-Paket');
    const otherServer = uuidv4();

    const res = await request(app)
      .delete(`/api/servers/${otherServer}/sticker-packs/${mine._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(await db.stickerPacks.findOne({ _id: mine._id })).not.toBeNull();
    expect(await db.stickerPackItems.find({ packId: mine._id })).toHaveLength(1);
  });
});

describe('kalıcılık — BIGINT serileştirme (gerçek pg davranışı)', () => {
  it('C2: DB createdAt STRING dönse bile API SAYI yayınlar', async () => {
    // Gerçek PostgreSQL BIGINT'i STRING olarak döndürür — global tip
    // ayrıştırıcı yoktur (scripts/verify-sticker-persistence.ts bunu
    // deneysel olarak doğruladı: "ham createdAt tipi: string").
    // mockDb sayı sakladığı için bu durumu ancak satırı elle string
    // yazarak canlandırabiliriz; aksi hâlde Number() silinse bile
    // testler yeşil kalırdı.
    const packId = uuidv4();
    await db.stickerPacks.insert({
      _id: packId, serverId, name: 'Bigint', description: '',
      authorId: userId, createdAt: '1700000000000', seq: 1,
    });
    await db.stickerPackItems.insert({
      _id: uuidv4(), packId, name: 'a', url: '/uploads/stickers/a.png',
      tags: [], width: '160', height: '160', position: 0, createdAt: '1700000000000',
    });

    const res = await request(app)
      .get(`/api/servers/${serverId}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`);
    const pack = res.body.find((p: { _id: string }) => p._id === packId);

    expect(typeof pack.createdAt).toBe('number');
    expect(pack.createdAt).toBe(1_700_000_000_000);
    // width/height de tamsayı olarak yayınlanmalı.
    expect(typeof pack.stickers[0].width).toBe('number');
    expect(pack.stickers[0].width).toBe(160);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// İÇERİK İMZASI — uzantı DEĞİL, BAYTLAR karar verir
// ════════════════════════════════════════════════════════════════════════════
// Bu koruma bu suite'te yalnızca KAZAYLA ölçülüyordu: fixture geçersiz baytlar
// yolladığı için 23 test 400 alıyor ve "başarısız" sayılıyordu. Fixture
// gerçekçi hâle getirildikten sonra koruma AÇIKÇA ölçülmelidir, yoksa imza
// kontrolü sessizce kaldırılsa hiçbir test düşmezdi.
describe('sticker yükleme — içerik imzası zorunlu', () => {
  it('PNG uzantılı ama PNG OLMAYAN baytlar reddedilir', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`)
      .field('name', 'Sahte')
      .attach('sticker', Buffer.from('bu bir PNG degil'), 'kedi.png');

    expect(res.status).toBe(400);
  });

  it('HTML/script gövdesi .png adıyla gizlenemez', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`)
      .field('name', 'XSS')
      .attach('sticker', Buffer.from('<script>alert(1)</script>'), 'x.png');

    expect(res.status).toBe(400);
  });

  it('GEÇERLİ PNG kabul edilir (yanlış pozitif kontrolü)', async () => {
    // Ayrım: yukarıdaki iki iddia yalnızca "her yükleme reddediliyor" diye
    // de geçebilirdi. Bu test korumanın MEŞRU dosyayı geçirdiğini kanıtlar.
    const res = await request(app)
      .post(`/api/servers/${serverId}/sticker-packs`)
      .set('Authorization', `Bearer ${token}`)
      .field('name', 'Gercek')
      .attach('sticker', PNG_1X1, 'gercek.png');

    expect(res.status).toBe(201);
  });
});
