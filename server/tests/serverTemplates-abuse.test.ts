// server/tests/serverTemplates-abuse.test.ts
// FAZ D / SUNUCU ŞABLONLARI — KAYNAK SINIRLARI VE SAHİPLİK.
//
// ════════════════════════════════════════════════════════════════════════════
// DÜZELTİLEN GERÇEK SORUN
// ════════════════════════════════════════════════════════════════════════════
// Şablonun `name`/`icon`/`description`/`tags` alanları sınırlıydı, ama GERÇEK
// KAYNAK YARATAN `categories` alanı HİÇ sınırlanmıyordu: ham hâliyle
// saklanıyor ve `/:id/apply` onu dolaşarak kanal başına satır açıyordu.
// Kimliği doğrulanmış herhangi bir kullanıcı tek POST ile devasa bir şablon
// oluşturup tek POST ile uygulayarak sınırsız kaynak tüketimi tetikleyebilirdi.
// Ayrıca uygulama yolu kanonik kanal sözleşmesini (tip beyaz listesi, ad/topic
// sınırları — routes/servers/channels.ts) tamamen atlıyordu.
//
// Kanal üst sınırı UYDURULMADI: ürünün kanonik değeriyle aynıdır
// (`MAX_CHANNELS_PER_SERVER`, varsayılan 500 — routes/servers/channels.ts).

process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV       = 'test';

import { createMockDb } from './helpers/mockDb';
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
  limits: { write: () => (_req: unknown, _res: unknown, next: () => void) => next() },
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import request from 'supertest';
import express from 'express';
const jwt = require('jsonwebtoken');

import templatesRouter from '../routes/serverTemplates';

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/server-templates', templatesRouter);

const tok = (id: string) => jwt.sign({ id, username: id, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });

const OWNER   = 'sahip-1';
const OTHER   = 'baskasi-1';
const CAP     = 500;   // MAX_CHANNELS_PER_SERVER varsayılanı

const create = (user: string, body: unknown) =>
  request(app).post('/api/server-templates').set('Authorization', `Bearer ${tok(user)}`).send(body as object);

const apply = (user: string, id: string, body: unknown = {}) =>
  request(app).post(`/api/server-templates/${id}/apply`).set('Authorization', `Bearer ${tok(user)}`).send(body as object);

/** Verilen sayıda kanal içeren tek kategori üretir. */
function bigCategory(channelCount: number) {
  return [{
    name: 'kategori',
    channels: Array.from({ length: channelCount }, (_, i) => ({ name: `kanal-${i}`, type: 'text', topic: '' })),
  }];
}

describe('D — şablon kategori/kanal sınırları', () => {
  it('POZİTİF KONTROL: makul şablon oluşturulur ve kanalları korunur', async () => {
    const res = await create(OWNER, {
      name: 'Normal Sablon',
      categories: [{ name: 'genel', channels: [{ name: 'sohbet', type: 'text', topic: 'merhaba' }] }],
    });

    expect(res.status).toBe(201);
    const cats = res.body.categories as Array<{ channels: Array<{ name: string; type: string }> }>;
    expect(cats[0].channels[0].name).toBe('sohbet');
    expect(cats[0].channels[0].type).toBe('text');
  });

  it('GÜVENLİK: kanal sayısı kanonik üst sınırla KIRPILIR', async () => {
    const res = await create(OWNER, { name: 'Devasa', categories: bigCategory(5000) });

    expect(res.status).toBe(201);
    const cats = res.body.categories as Array<{ channels: unknown[] }>;
    const total = cats.reduce((n, c) => n + c.channels.length, 0);
    expect(total).toBeLessThanOrEqual(CAP);
  });

  it('GÜVENLİK: devasa şablon UYGULANDIĞINDA da sınır aşılmaz', async () => {
    const made = await create(OWNER, { name: 'Devasa2', categories: bigCategory(5000) });
    const id = made.body.id as string;

    const res = await apply(OWNER, id, { name: 'Sunucum' });

    expect(res.status).toBe(200);
    const serverId = res.body.server._id as string;
    const chans = await mockDb.channels.find({ serverId });
    expect(chans.length).toBeLessThanOrEqual(CAP);
  });

  it('GÜVENLİK: kategori sayısı sınırlanır', async () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ name: `kat-${i}`, channels: [] }));

    const res = await create(OWNER, { name: 'CokKategori', categories: many });

    expect(res.status).toBe(201);
    expect((res.body.categories as unknown[]).length).toBeLessThanOrEqual(50);
  });

  it('GÜVENLİK: geçersiz kanal tipi kanonik `text`e düşürülür', async () => {
    const res = await create(OWNER, {
      name: 'KotuTip',
      categories: [{ name: 'k', channels: [{ name: 'a', type: 'admin-backdoor' }] }],
    });

    const cats = res.body.categories as Array<{ channels: Array<{ type: string }> }>;
    expect(cats[0].channels[0].type).toBe('text');
  });

  it('GÜVENLİK: kanal adı kanonik biçime normalize edilir', async () => {
    const res = await create(OWNER, {
      name: 'KotuAd',
      categories: [{ name: 'k', channels: [{ name: '  ÇOK KÖTÜ <script> Ad!! ' + 'x'.repeat(200) }] }],
    });

    const name = (res.body.categories as Array<{ channels: Array<{ name: string }> }>)[0].channels[0].name;
    expect(name.length).toBeLessThanOrEqual(32);
    expect(name).toMatch(/^[a-z0-9\-_]+$/);
    expect(name).not.toContain('<');
  });

  it('GÜVENLİK: topic uzunluğu sınırlanır', async () => {
    const res = await create(OWNER, {
      name: 'UzunTopic',
      categories: [{ name: 'k', channels: [{ name: 'a', topic: 'y'.repeat(5000) }] }],
    });

    const topic = (res.body.categories as Array<{ channels: Array<{ topic: string }> }>)[0].channels[0].topic;
    expect(topic.length).toBeLessThanOrEqual(100);
  });

  it('bozuk kategori yapısı çökertmez, elenir', async () => {
    const res = await create(OWNER, {
      name: 'Bozuk',
      categories: [null, 'dize', 42, { channels: [] }, { name: 'ok', channels: 'dizi-degil' }],
    });

    expect(res.status).toBe(201);
    const cats = res.body.categories as Array<{ name: string; channels: unknown[] }>;
    expect(cats.every(c => typeof c.name === 'string' && Array.isArray(c.channels))).toBe(true);
  });

  it('kategorisiz şablon reddedilir', async () => {
    const res = await create(OWNER, { name: 'Bos', categories: [] });

    expect(res.status).toBe(400);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SAVUNMA KATMANI — ESKİ (SINIRLAMA ÖNCESİ) SATIRLAR
  // ══════════════════════════════════════════════════════════════════════════
  //
  // Yazma anındaki sınırlama, API üzerinden oluşturulan her şablonu zaten
  // kırpar. Ancak sınırlama EKLENMEDEN ÖNCE yazılmış satırlar (veya doğrudan
  // veritabanına yazılan satırlar) hâlâ devasa olabilir. Bu testler şablonu
  // API'yi ATLAYARAK doğrudan DB'ye koyar ve uygulama anındaki kırpmanın
  // gerçekten yük taşıdığını kanıtlar.
  describe('eski/doğrudan-DB satırları uygulama anında kırpılır', () => {
    const LEGACY_ID = 'eski-devasa-sablon';

    beforeAll(async () => {
      await mockDb.serverTemplates.insert({
        _id:         LEGACY_ID,
        name:        'Eski Devasa',
        icon:        '🗿',
        description: 'sinirlama oncesi yazilmis',
        tags:        JSON.stringify([]),
        // Sınırlanmamış ham yapı — tam olarak eski davranış.
        categories:  JSON.stringify(bigCategory(4000)),
        createdBy:   OWNER,
        createdAt:   Date.now(),
        updatedAt:   null,
      });
    });

    it('GÜVENLİK: eski devasa satır UYGULANIRKEN kanal sınırı aşılmaz', async () => {
      const res = await apply(OWNER, LEGACY_ID, { name: 'Eskiden Kurulan' });

      expect(res.status).toBe(200);
      const serverId = res.body.server._id as string;
      const chans = await mockDb.channels.find({ serverId });
      expect(chans.length).toBeGreaterThan(0);          // pozitif kontrol
      expect(chans.length).toBeLessThanOrEqual(CAP);
    });

    it('GÜVENLİK: eski satırdaki geçersiz tip/ad uygulama anında düzeltilir', async () => {
      await mockDb.serverTemplates.insert({
        _id:         'eski-kotu-alanlar',
        name:        'Eski Kotu',
        icon:        '🗿',
        description: '',
        tags:        JSON.stringify([]),
        categories:  JSON.stringify([{
          name: 'k',
          channels: [{ name: '  BÜYÜK <b>Ad</b>  ', type: 'super-admin', topic: 'z'.repeat(4000) }],
        }]),
        createdBy:   OWNER,
        createdAt:   Date.now(),
        updatedAt:   null,
      });

      const res = await apply(OWNER, 'eski-kotu-alanlar', { name: 'Kotu Alanlar' });

      expect(res.status).toBe(200);
      const serverId = res.body.server._id as string;
      const chans = await mockDb.channels.find({ serverId });
      expect(chans.length).toBe(1);
      expect(String(chans[0].name)).toMatch(/^[a-z0-9\-_]+$/);
      expect(String(chans[0].name).length).toBeLessThanOrEqual(32);
      expect(String(chans[0].type)).toBe('text');
      expect(String(chans[0].topic).length).toBeLessThanOrEqual(100);
    });
  });
});

describe('D — şablon sahipliği', () => {
  let templateId: string;

  beforeAll(async () => {
    const made = await create(OWNER, {
      name: 'Sahipli', categories: [{ name: 'k', channels: [{ name: 'a' }] }],
    });
    templateId = made.body.id as string;
  });

  it('POZİTİF KONTROL: sahip kendi şablonunu güncelleyebilir', async () => {
    const res = await request(app)
      .put(`/api/server-templates/${templateId}`)
      .set('Authorization', `Bearer ${tok(OWNER)}`)
      .send({ name: 'Yeni Ad' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Yeni Ad');
  });

  it('GÜVENLİK: başkası şablonu GÜNCELLEYEMEZ', async () => {
    const res = await request(app)
      .put(`/api/server-templates/${templateId}`)
      .set('Authorization', `Bearer ${tok(OTHER)}`)
      .send({ name: 'Ele Gecirildi' });

    expect(res.status).toBe(403);
  });

  it('GÜVENLİK: başkası şablonu SİLEMEZ', async () => {
    const res = await request(app)
      .delete(`/api/server-templates/${templateId}`)
      .set('Authorization', `Bearer ${tok(OTHER)}`);

    expect(res.status).toBe(403);
  });

  it('GÜVENLİK: kimliksiz istek reddedilir', async () => {
    const res = await request(app).get('/api/server-templates');

    expect(res.status).toBe(401);
  });

  it('GÜVENLİK: uygulanan sunucunun sahibi ÇAĞIRANDIR', async () => {
    const res = await apply(OTHER, templateId, { name: 'Digerinin Sunucusu' });

    expect(res.status).toBe(200);
    expect(res.body.server.ownerId).toBe(OTHER);
  });

  it('var olmayan şablon 404', async () => {
    const res = await apply(OWNER, 'yok-boyle-sablon');

    expect(res.status).toBe(404);
  });
});
