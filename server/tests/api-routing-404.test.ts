// server/tests/api-routing-404.test.ts
// Faz 10.13 — EŞLEŞMEYEN API YOLU DAVRANIŞI.
//
// TARİHSEL SEMPTOM: `GET /api/servers/:id` geçerli bir sunucu için beklenmedik
// 500 döndürdüğü rapor edilmişti.
//
// KAYNAK ENVANTERİ SONUCU: böyle bir uç HİÇ YOK.
//   - `routes/servers/core.ts` yalnız şunları tanımlar:
//       GET /            POST /              PATCH /:sid
//       POST /:sid/leave DELETE /:sid        POST /:sid/join
//       GET /:sid/members  PATCH /:sid/members/:uid/nickname
//   - `/api/servers`'a monte edilen DİĞER tüm routerlarda da tepe seviye
//     `GET /:sid` yoktur (kapsamlı arama: `.get('/:sid'|'/:serverId'|'/:id'`).
//   - `/servers/:sid`'e monte edilen TEK router `serverAssets`'tır ve yalnız
//     banner/icon POST+DELETE taşır — `GET /` tanımlamaz, bu yüzden
//     `/api/servers/<id>`'yi yakalamaz.
//   - İstemcinin bu uca birinci-taraf çağrısı YOKTUR; tüm istemci çağrıları
//     alt yollaradır (/join, /members, /search, /audit-log, /banner ...).
//
// SONUÇ: doğru davranış "rota yok → güvenli 404"tür. Bu süit o sözleşmeyi
// kilitler. UYDURMA `GET /:sid` ucu EKLENMEZ.
//
// KAPSAM NOTU: burada tüm uygulama değil, bu yolu yakalayabilecek İKİ router
// (`servers`, `serverAssets`) gerçek `notFoundHandler`/`errorHandler` ile
// monte edilir. Boru hattının bu yol için ilgili kısmı budur.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

// `servers/core.ts` dolaylı olarak birçok routerı çeker; her biri farklı bir
// limiter adı ister. Hız sınırlama bu süitte test edilen davranış DEĞİLDİR,
// bu yüzden her ad için geçiş middleware'i üreten bir Proxy kullanılır.
jest.mock('../middleware/rateLimit', () => ({
  limits: new Proxy({}, {
    get: () => () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));

jest.mock('../routes/discover', () => ({ invalidateMemberCount: jest.fn(async () => {}) }));

let db: MockDb;
const mockGetLiveVanityServer = jest.fn(async (slug: string) => db?.servers?.findOne({ vanityUrl: slug }));
jest.mock('../db/repositories/BoostRepository.js', () => ({ Boosts: { getLiveVanityServer: mockGetLiveVanityServer, mutateVanityAtomic: jest.fn() } }));
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/index', () => {
  const { createMockDb } = require('./helpers/mockDb');
  db = createMockDb();
  return db;
});

import request from 'supertest';
import express from 'express';
import serversRouter from '../routes/servers';
import serverAssetsRouter from '../routes/serverAssets';
import serverProfileRouter from '../routes/serverProfile';
import { notFoundHandler, errorHandler } from '../middleware/errorHandler';
import type { MockDb } from './helpers/mockDb';

let app: express.Express;

beforeEach(() => {
  const { createMockDb } = require('./helpers/mockDb');
  db = createMockDb();
  Object.assign(require('../db/loader'), db);
  Object.assign(require('../db/index'), db);
  mockGetLiveVanityServer.mockClear();
  mockGetLiveVanityServer.mockImplementation(async (slug: string) => db?.servers?.findOne({ vanityUrl: slug }));

  app = express();
  app.use(express.json());
  // Üretimdeki montaj sırası (app/setupRoutes.ts:89, 94, 163).
  //
  // serverProfileRouter KRİTİKTİR: `/api/servers`a da monte edilir (çünkü
  // `GET|PUT /:sid/slug` uçlarını taşır) ve içindeki herkese açık `GET /:slug`
  // HTML sayfası `/api/servers/<herhangi>`yi yakalayabilir. Bu router
  // mount EDİLMEDEN yazılan bir 404 testi ÜRETİMİ MODELLEMEZ — nitekim
  // gerçek runtime `GET /api/servers/<id>` için 500 gösterdi
  // (Servers.findOne({slug}) → var olmayan kolon).
  app.use('/api/servers', serversRouter);
  app.use('/api/servers/:sid', serverAssetsRouter);
  app.use('/api/servers', serverProfileRouter);
  // Herkese açık vanity yüzeyi (app/setupRoutes.ts: app.use('/s', …)).
  app.use('/s', serverProfileRouter);
  // Hata fırlatan bilinçli bir uç — errorHandler sızıntı testi için.
  app.get('/api/boom', () => { throw new Error('gizli-ic-detay: /srv/db/parola'); });
  app.use(notFoundHandler);
  app.use(errorHandler);
});

const SID = 'srv-does-not-exist';

describe('GET /api/servers/:id — rota TANIMLI DEĞİL', () => {
  it('pozitif kontrol: servers router GERÇEKTEN monte (list ucu auth ister)', async () => {
    // 401, yolun bir routera ULAŞTIĞINI kanıtlar. Bu olmadan aşağıdaki 404
    // "hiçbir şey monte edilmemiş" ile karışabilirdi.
    const res = await request(app).get('/api/servers');

    expect(res.status).toBe(401);
  });

  it('eşleşmeyen sunucu detayı 404 döner — 500 DEĞİL', async () => {
    const res = await request(app).get(`/api/servers/${SID}`);

    expect(res.status).toBe(404);
    expect(res.status).not.toBe(500);
  });

  it('yanıt JSON\'dur — SPA HTML sızıntısı YOK', async () => {
    const res = await request(app).get(`/api/servers/${SID}`);

    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.text).not.toMatch(/<!DOCTYPE|<html|<script/i);
    expect(typeof res.body.error).toBe('string');
  });

  it('kimlik doğrulanmış istek de 404 alır (davranış auth\'a bağlı değil)', async () => {
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ id: 'user-x', v: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });

    const res = await request(app).get(`/api/servers/${SID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it('bozuk/saldırgan sid biçimleri 500 tetiklemez', async () => {
    const paths = [
      '/api/servers/%00',
      '/api/servers/..%2f..%2fetc%2fpasswd',
      '/api/servers/' + 'a'.repeat(500),
      '/api/servers/%7B%22$ne%22:null%7D',
    ];

    for (const p of paths) {
      const res = await request(app).get(p);

      expect(res.status).toBeLessThan(500);
      expect(res.status).toBe(404);
    }
  });

  it('desteklenmeyen metotlar da güvenle 404 döner', async () => {
    for (const m of ['put', 'head'] as const) {
      const res = await request(app)[m](`/api/servers/${SID}`);

      expect(res.status).toBe(404);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// serverProfile — vanity yüzeyi. DB kolonu `vanityUrl`, yol adı `slug`.
// Önceden `Servers.findOne({ slug })` çağrılıyordu; `slug` KOLONU YOKTUR,
// bu yüzden hem `/s/:slug` hem `/api/servers/<id>` her istekte 500 veriyordu.
// ─────────────────────────────────────────────────────────────
describe('vanity profil sayfası (/s/:slug)', () => {
  beforeEach(async () => {
    await db.servers.insert({
      _id: 'srv-vanity', name: 'Vanity Sunucu', ownerId: 'user-x',
      vanityUrl: 'bridge-hq', createdAt: Date.now(),
    });
    await db.servers.insert({
      _id: 'srv-plain', name: 'Vanity Yok', ownerId: 'user-x', createdAt: Date.now(),
    });
  });

  it('GEÇERLİ vanityUrl profil sayfasını döndürür', async () => {
    const res = await request(app).get('/s/bridge-hq');

    expect(res.status).toBe(200);
    expect(res.text).toContain('Vanity Sunucu');
  });

  it('BİLİNMEYEN vanity 404 döner (500 değil)', async () => {
    const res = await request(app).get('/s/boyle-bir-sey-yok');

    expect(res.status).toBe(404);
  });

  it('vanityUrl\'i OLMAYAN sunucu eşleşmez', async () => {
    // Kolon yokken eskiden 500 gelirdi; artık düzgün 404.
    const res = await request(app).get('/s/srv-plain');

    expect(res.status).toBe(404);
  });

  it('UUID görünümlü ve bozuk değerler 500 tetiklemez', async () => {
    const values = [
      '550e8400-e29b-41d4-a716-446655440000',
      'null',
      'undefined',
      '%00',
      'a'.repeat(300),
      '..%2f..%2fetc',
    ];

    for (const v of values) {
      const res = await request(app).get(`/s/${v}`);

      expect(res.status).toBeLessThan(500);
      expect([400, 404]).toContain(res.status);
    }
  });

  it('API yüzeyinde HTML profil sayfası DEVREYE GİRMEZ', async () => {
    // Aynı router `/api/servers`a da monte; oradaki istek kanonik JSON 404
    // olmalı — HTML sayfası değil.
    const res = await request(app).get('/api/servers/bridge-hq');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.text).not.toContain('Vanity Sunucu');
  });
});

describe('eşleşmeyen API yanıtı iç detay sızdırmaz', () => {
  it('404 gövdesi yalnız yöntem+yol içerir; yığın izi YOK', async () => {
    const res = await request(app).get(`/api/servers/${SID}`);

    expect(res.body).toEqual({ error: expect.stringContaining('Not found') });
    expect(JSON.stringify(res.body)).not.toMatch(/at\s+\w+.*\(.*:\d+:\d+\)/);   // stack frame
    expect(JSON.stringify(res.body)).not.toMatch(/node_modules|[A-Za-z]:\\\\|\/srv\//);
  });

  it('gerçek 500 hatası iç detayı SIZDIRMAZ', async () => {
    const res = await request(app).get('/api/boom');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
    expect(res.text).not.toContain('gizli-ic-detay');
    expect(res.text).not.toContain('/srv/db/parola');
  });
});
