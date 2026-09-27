// server/tests/serverTemplates-normalization-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// SUNUCU ŞABLONLARI — SATIR NORMALİZASYONU, KISMİ GÜNCELLEME VE SINIRLAMA
// ════════════════════════════════════════════════════════════════════════════
//
// Şablonlar KAYNAK yaratan bir yüzeydir: tek bir "uygula" isteği onlarca kanal
// açar. Ölçülmemiş dallar üç sınıfa ayrılır ve üçü de gerçek arıza üretir:
//
//   · SEYREK/BOZUK SATIR — depodan gelen satırın alanları eksik ya da yanlış
//     türde olabilir (eski şema, elle yazılmış kayıt, kısmi göç). Liste ucu
//     "undefined" göstermemeli, çökmemelidir.
//   · KISMİ GÜNCELLEME — `PUT` yalnız GÖNDERİLEN alanları değiştirir.
//     Gönderilmeyen bir alan sessizce sıfırlanırsa kullanıcı şablonunu
//     kaybeder.
//   · SINIRLAMA — kategori/kanal yapısı hem YAZARKEN hem UYGULARKEN
//     sınırlanır. İkinci katman, sınırlama eklenmeden önce yazılmış eski
//     satırlar için tek korumadır.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
const db = require('../db/loader');
const jwt = require('jsonwebtoken');
import { requireDoc } from './helpers/mockDb';

let templatesRouter: express.Router;

function buildApp(router: express.Router) {
  const app = express();
  app.use(express.json());
  app.use('/api/server-templates', router);
  return app;
}

const tok = (uid: string, v = 0) => jwt.sign({ id: uid, v }, process.env.JWT_SECRET as string, { expiresIn: '1h' });

let app: express.Express;
let userId: string;
let otherId: string;
let userToken: string;
let otherToken: string;

const category = (over: Record<string, unknown> = {}) => ({
  name: 'Genel',
  channels: [{ name: 'sohbet', type: 'text', topic: 'konu' }],
  ...over,
});

beforeEach(async () => {
  db._reset?.();
  jest.isolateModules(() => { templatesRouter = require('../routes/serverTemplates'); });
  app = buildApp(templatesRouter);
  userId = uuidv4();
  otherId = uuidv4();
  userToken = tok(userId);
  otherToken = tok(otherId);
  await db.users.insert({ _id: userId, username: 'alice', displayName: 'Alice', tokenVersion: 0 });
  await db.users.insert({ _id: otherId, username: 'bob', displayName: 'Bob', tokenVersion: 0 });
});

async function createTemplate(body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await request(app).post('/api/server-templates')
    .set('Authorization', `Bearer ${userToken}`)
    .send({ name: 'Şablon', categories: [category()], ...body });
  expect(res.status).toBe(201);
  return res.body;
}

describe('depo satırı normalizasyonu', () => {
  it('alanları eksik satır güvenli varsayılanlarla sunulur', async () => {
    await db.serverTemplates.insert({ _id: 'tpl-eksik' });

    const res = await request(app).get('/api/server-templates/tpl-eksik')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 'tpl-eksik', name: '', icon: '🌐', description: '', createdBy: '',
      tags: [], categories: [],
    });
    expect(typeof res.body.createdAt).toBe('number');
    expect(JSON.stringify(res.body)).not.toContain('undefined');
  });

  it('yanlış türdeki alanlar da güvenli varsayılana düşer', async () => {
    await db.serverTemplates.insert({
      _id: 'tpl-tur', name: 42, icon: null, description: {}, createdBy: 7,
      tags: { a: 1 }, categories: 99, createdAt: 'dün',
    });

    const res = await request(app).get('/api/server-templates/tpl-tur')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.body).toMatchObject({ icon: '🌐', tags: [], categories: [] });
    expect(typeof res.body.createdAt).toBe('number');
  });

  it('bozuk JSON metinleri boş listeye çözülür', async () => {
    await db.serverTemplates.insert({
      _id: 'tpl-bozuk', name: 'Bozuk', createdBy: userId,
      tags: '{bozuk', categories: '{bozuk', createdAt: 1,
    });

    const res = await request(app).get('/api/server-templates/tpl-bozuk')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.body.tags).toEqual([]);
    expect(res.body.categories).toEqual([]);
  });

  it('JSON metni dizi değilse de boş listeye çözülür', async () => {
    await db.serverTemplates.insert({
      _id: 'tpl-nesne', name: 'Nesne', createdBy: userId,
      tags: JSON.stringify({ a: 1 }), categories: JSON.stringify({ b: 2 }), createdAt: 1,
    });

    const res = await request(app).get('/api/server-templates/tpl-nesne')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.body.tags).toEqual([]);
    expect(res.body.categories).toEqual([]);
  });

  it('liste ucu kategori ayrıntısını taşımaz, detay ucu taşır', async () => {
    const created = await createTemplate();

    const list = await request(app).get('/api/server-templates').set('Authorization', `Bearer ${userToken}`);
    const row = (list.body.templates ?? list.body).find((t: { id: string }) => t.id === created.id);
    expect(row.categories).toBeUndefined();

    const detail = await request(app).get(`/api/server-templates/${created.id}`)
      .set('Authorization', `Bearer ${userToken}`);
    expect(detail.body.categories).toHaveLength(1);
  });

  it('olmayan şablon 404 verir', async () => {
    const res = await request(app).get('/api/server-templates/yok-boyle')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(404);
  });
});

describe('oluşturma doğrulaması ve sınırlama', () => {
  it('nesne olmayan gövde boş kabul edilir', async () => {
    const res = await request(app).post('/api/server-templates')
      .set('Authorization', `Bearer ${userToken}`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(['dizi']));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Şablon adı gerekli');
  });

  it('tür hataları açık mesajlarla reddedilir', async () => {
    const base = { name: 'X', categories: [category()] };

    expect((await request(app).post('/api/server-templates').set('Authorization', `Bearer ${userToken}`)
      .send({ ...base, icon: 5 })).body.error).toBe('icon and description must be strings');
    expect((await request(app).post('/api/server-templates').set('Authorization', `Bearer ${userToken}`)
      .send({ ...base, description: {} })).body.error).toBe('icon and description must be strings');
    expect((await request(app).post('/api/server-templates').set('Authorization', `Bearer ${userToken}`)
      .send({ ...base, tags: 'etiket' })).body.error).toBe('tags must be a string array');
    expect((await request(app).post('/api/server-templates').set('Authorization', `Bearer ${userToken}`)
      .send({ ...base, tags: [1] })).body.error).toBe('tags must be a string array');
    expect((await request(app).post('/api/server-templates').set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'X', categories: [] })).body.error).toBe('En az bir kategori gerekli');
  });

  it('uzun alanlar kırpılır ve etiket sayısı sınırlanır', async () => {
    const created = await createTemplate({
      name: 'a'.repeat(120), icon: 'i'.repeat(30), description: 'd'.repeat(400),
      tags: Array.from({ length: 20 }, (_, i) => `t${i}`),
    });

    expect(created.name).toHaveLength(80);
    expect(created.icon).toHaveLength(10);
    expect(created.description).toHaveLength(300);
    expect(created.tags).toHaveLength(10);
  });

  it('kategori ve kanal yapısı kanonik sözleşmeye uyarlanarak SAKLANIR', async () => {
    const created = await createTemplate({
      categories: [
        'metin-kategori',
        null,
        { name: '   ' },
        {
          name: `${'K'.repeat(50)}`,
          channels: [
            null,
            'metin-kanal',
            { name: '  Genel Sohbet!  ', type: 'holografik', topic: 'x'.repeat(200) },
            { name: '   ' },
            { name: 'ses', type: 'voice' },
          ],
        },
      ],
    });

    const cats = created.categories as Array<{ name: string; channels: Array<Record<string, string>> }>;
    expect(cats).toHaveLength(1);
    expect(cats[0]!.name).toHaveLength(32);
    expect(cats[0]!.channels).toEqual([
      { name: 'genel-sohbet-', type: 'text', topic: 'x'.repeat(100) },
      { name: 'ses', type: 'voice', topic: '' },
    ]);
  });

  it('kategori sayısı ve toplam kanal sayısı tavana sabitlenir', async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      name: `kat-${i}`,
      channels: Array.from({ length: 20 }, (_, j) => ({ name: `kanal-${i}-${j}` })),
    }));

    const created = await createTemplate({ categories: many });

    const cats = created.categories as Array<{ channels: unknown[] }>;
    expect(cats.length).toBeLessThanOrEqual(50);
    const total = cats.reduce((sum, c) => sum + c.channels.length, 0);
    expect(total).toBeLessThanOrEqual(500);
  });
});

describe('kısmi güncelleme', () => {
  it('gönderilmeyen alanlar korunur', async () => {
    const created = await createTemplate({ name: 'İlk', icon: '🚀', description: 'açıklama', tags: ['a'] });

    const res = await request(app).put(`/api/server-templates/${created.id}`)
      .set('Authorization', `Bearer ${userToken}`).send({ name: 'İkinci' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'İkinci', icon: '🚀', description: 'açıklama', tags: ['a'] });
    expect((res.body.categories as unknown[]).length).toBe(1);
  });

  it('her alan tek tek güncellenebilir', async () => {
    const created = await createTemplate();

    const icon = await request(app).put(`/api/server-templates/${created.id}`)
      .set('Authorization', `Bearer ${userToken}`).send({ icon: '🎯🎯🎯🎯🎯🎯' });
    // Kirpma UTF-16 kod birimiyle yapilir: 10 birim = 5 emoji.
    expect(icon.body.icon).toHaveLength(10);

    const description = await request(app).put(`/api/server-templates/${created.id}`)
      .set('Authorization', `Bearer ${userToken}`).send({ description: 'd'.repeat(400) });
    expect(description.body.description).toHaveLength(300);

    const tags = await request(app).put(`/api/server-templates/${created.id}`)
      .set('Authorization', `Bearer ${userToken}`).send({ tags: Array.from({ length: 15 }, (_, i) => `t${i}`) });
    expect(tags.body.tags).toHaveLength(10);

    const categories = await request(app).put(`/api/server-templates/${created.id}`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ categories: [{ name: 'Yeni', channels: [{ name: 'YENİ KANAL' }] }] });
    expect(categories.body.categories).toEqual([{ name: 'Yeni', channels: [{ name: 'yeni--kanal', type: 'text', topic: '' }] }]);
  });

  it('geçersiz alan türleri güncellemeyi düşürür', async () => {
    const created = await createTemplate({ name: 'Korunan' });

    expect((await request(app).put(`/api/server-templates/${created.id}`)
      .set('Authorization', `Bearer ${userToken}`).send({ name: '   ' })).body.error).toBe('name must be a non-empty string');
    expect((await request(app).put(`/api/server-templates/${created.id}`)
      .set('Authorization', `Bearer ${userToken}`).send({ icon: 5 })).body.error).toBe('icon must be a string');
    expect((await request(app).put(`/api/server-templates/${created.id}`)
      .set('Authorization', `Bearer ${userToken}`).send({ description: [] })).body.error).toBe('description must be a string');
    expect((await request(app).put(`/api/server-templates/${created.id}`)
      .set('Authorization', `Bearer ${userToken}`).send({ tags: [1] })).body.error).toBe('tags must be a string array');
    expect((await request(app).put(`/api/server-templates/${created.id}`)
      .set('Authorization', `Bearer ${userToken}`).send({ categories: 'hepsi' })).body.error).toBe('categories must be an array');

    const detail = await request(app).get(`/api/server-templates/${created.id}`)
      .set('Authorization', `Bearer ${userToken}`);
    expect(detail.body.name).toBe('Korunan');
  });

  it('nesne olmayan gövde hiçbir alanı değiştirmez', async () => {
    const created = await createTemplate({ name: 'Sabit' });

    const res = await request(app).put(`/api/server-templates/${created.id}`)
      .set('Authorization', `Bearer ${userToken}`)
      .set('Content-Type', 'application/json').send(JSON.stringify(['dizi']));

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Sabit');
  });

  it('sahibi olmayan güncelleyemez ve silemez', async () => {
    const created = await createTemplate();

    const update = await request(app).put(`/api/server-templates/${created.id}`)
      .set('Authorization', `Bearer ${otherToken}`).send({ name: 'Ele geçirildi' });
    expect(update.status).toBe(403);

    const remove = await request(app).delete(`/api/server-templates/${created.id}`)
      .set('Authorization', `Bearer ${otherToken}`);
    expect(remove.status).toBe(403);

    const detail = await request(app).get(`/api/server-templates/${created.id}`)
      .set('Authorization', `Bearer ${userToken}`);
    expect(detail.body.name).toBe('Şablon');
  });

  it('olmayan şablon güncellenemez ve silinemez', async () => {
    expect((await request(app).put('/api/server-templates/yok')
      .set('Authorization', `Bearer ${userToken}`).send({ name: 'x' })).status).toBe(404);
    expect((await request(app).delete('/api/server-templates/yok')
      .set('Authorization', `Bearer ${userToken}`)).status).toBe(404);
  });

  it('sahibi kendi şablonunu siler', async () => {
    const created = await createTemplate();

    const res = await request(app).delete(`/api/server-templates/${created.id}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(await db.serverTemplates.findOne({ _id: created.id })).toBeFalsy();
  });
});

describe('uygulama sırasında ikinci savunma katmanı', () => {
  it('sınırlama öncesi yazılmış aşırı satır uygulanırken de sınırlanır', async () => {
    const huge = Array.from({ length: 80 }, (_, i) => ({
      name: `kat-${i}`,
      channels: Array.from({ length: 20 }, (_, j) => ({ name: `kanal-${i}-${j}`, type: 'holografik' })),
    }));
    await db.serverTemplates.insert({
      _id: 'tpl-eski', name: 'Eski', icon: '🌐', description: '', createdBy: userId,
      tags: '[]', categories: JSON.stringify(huge), createdAt: 1,
    });

    const res = await request(app).post('/api/server-templates/tpl-eski/apply')
      .set('Authorization', `Bearer ${userToken}`).send({ name: 'Yeni Sunucu' });

    expect(res.status).toBe(200);
    const channels = await db.channels.find({ serverId: res.body.server?._id ?? res.body._id });
    expect(channels.length).toBeLessThanOrEqual(500);
    // Taninmayan tip kanonik varsayilana cevrilir.
    expect(channels.every((c: { type: string }) => c.type !== 'holografik')).toBe(true);
  });

  it('sunucu adı boşsa uygulama reddedilir', async () => {
    await db.serverTemplates.insert({
      _id: 'tpl-adsiz', name: '   ', icon: '🌐', description: '', createdBy: userId,
      tags: '[]', categories: JSON.stringify([category()]), createdAt: 1,
    });

    const res = await request(app).post('/api/server-templates/tpl-adsiz/apply')
      .set('Authorization', `Bearer ${userToken}`).send({ name: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Sunucu adı gerekli');
  });

  it('gövdede ad yoksa şablon adı kullanılır', async () => {
    const created = await createTemplate({ name: 'Şablon Adı' });

    const res = await request(app).post(`/api/server-templates/${created.id}/apply`)
      .set('Authorization', `Bearer ${userToken}`).send({});

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('Şablon Adı');
  });

  it('olmayan şablon uygulanamaz', async () => {
    const res = await request(app).post('/api/server-templates/yok/apply')
      .set('Authorization', `Bearer ${userToken}`).send({ name: 'X' });

    expect(res.status).toBe(404);
  });
});
