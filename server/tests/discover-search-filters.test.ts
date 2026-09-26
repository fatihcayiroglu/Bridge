// server/tests/discover-search-filters.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// /api/discover — ARAMA, ETIKET, KATEGORI VE ONE CIKARILANLAR
// ════════════════════════════════════════════════════════════════════════════
// Kesfet listesi Bridge'in TEK acik (public) yuzeyidir: burada gorunen her
// sunucu, hesabi olan herkese gorunur. Bu yuzden iki sey ayni anda dogru
// olmalidir.
//
// 1. FILTRELER GERCEKTEN FILTRELER. Arama adi, aciklamayi VE etiketleri
//    tarar; etiket filtresi TAM eslesme ister (aksi hâlde "oyun" araması
//    "oyunculuk" etiketini de cekerdi); kategori yalnizca TANINAN bir
//    kategori icin uygulanir.
//
// 2. HAYALET SUNUCU LISTELENMEZ. `discoverable=1` birakilmis ama uyesi
//    kalmamis kayitlar listede gorunmemelidir — yeni kullaniciyi bos bir
//    sunucuya yollamak, urunun ilk izlenimini bozar.
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

// Kesfet listesi UYE SAYISINI ve VITRINI onbellege alir. Onbellek gercek ve
// dogru bir davranistir, ama bu paket FILTRELERI olcer: paylasilan bir
// onbellek, bir senaryonun sonucunu digerine tasiyip olculen seyi
// belirsizlestirirdi. Bu yuzden burada onbellek her zaman ISKALAR.
jest.mock('../lib/redisAdapter', () => ({
  cache: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => undefined),
    del: jest.fn(async () => undefined),
  },
}));

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware } from '../middleware/auth';
import discoverRouter from '../routes/discover';

const db = require('../db/loader');
const jwt = require('jsonwebtoken');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/discover', authMiddleware, discoverRouter);
  return app;
}
const tok = (uid: string) => jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });

let app: ReturnType<typeof buildApp>;
let userId: string;
let token: string;

/** Uyeli, kesfedilebilir bir sunucu ekler. */
async function seedServer(name: string, extra: Record<string, unknown> = {}, members = 3): Promise<string> {
  const sid = uuidv4();
  const ownerId = uuidv4();
  await db.users.insert({ _id: ownerId, username: `o-${sid.slice(0, 6)}`, displayName: 'O', tokenVersion: 0 });
  await db.servers.insert({
    _id: sid, name, ownerId, discoverable: 1, createdAt: Date.now(), ...extra,
  });
  for (let i = 0; i < members; i += 1) {
    await db.members.insert({ _id: uuidv4(), userId: uuidv4(), serverId: sid, joinedAt: Date.now() });
  }
  return sid;
}

const names = (body: unknown) => (body as Array<{ name: string }>).map(s => s.name).sort();

beforeEach(async () => {
  db._reset?.();
  app = buildApp();
  userId = uuidv4();
  token = tok(userId);
  await db.users.insert({ _id: userId, username: 'u', displayName: 'U', tokenVersion: 0 });
});

describe('free-text search spans name, description and tags', () => {
  beforeEach(async () => {
    await seedServer('Oyun Kulubu', { description: 'Her aksam bulusuyoruz', tags: JSON.stringify(['fps', 'strateji']) });
    await seedServer('Kitap Sohbeti', { description: 'Oyun disi her sey', tags: JSON.stringify(['edebiyat']) });
    await seedServer('Muzik Odasi', { description: 'Caniyoruz', tags: JSON.stringify(['oyun-muzikleri']) });
  });

  it('matches on the server name', async () => {
    const res = await request(app).get('/api/discover?q=kulubu').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(names(res.body)).toEqual(['Oyun Kulubu']);
  });

  it('matches on the description as well as the name', async () => {
    const res = await request(app).get('/api/discover?q=oyun').set('Authorization', `Bearer ${token}`);
    // Ad, aciklama ve etiket ayni sorguyla taranir.
    expect(names(res.body)).toEqual(['Kitap Sohbeti', 'Muzik Odasi', 'Oyun Kulubu']);
  });

  it('matches on a tag substring', async () => {
    const res = await request(app).get('/api/discover?q=strat').set('Authorization', `Bearer ${token}`);
    expect(names(res.body)).toEqual(['Oyun Kulubu']);
  });

  it('is case-insensitive', async () => {
    const res = await request(app).get('/api/discover?q=KULUBU').set('Authorization', `Bearer ${token}`);
    expect(names(res.body)).toEqual(['Oyun Kulubu']);
  });

  it('returns an empty list rather than everything for a query nobody matches', async () => {
    const res = await request(app).get('/api/discover?q=zzzz-yok').set('Authorization', `Bearer ${token}`);
    expect(res.body).toEqual([]);
  });

  it('ignores a whitespace-only query instead of filtering everything away', async () => {
    const res = await request(app).get('/api/discover?q=%20%20').set('Authorization', `Bearer ${token}`);
    expect(names(res.body)).toHaveLength(3);
  });
});

describe('tag filtering demands an exact tag', () => {
  beforeEach(async () => {
    await seedServer('FPS Evi', { tags: JSON.stringify(['fps']) });
    await seedServer('FPS Turnuva', { tags: JSON.stringify(['fps-turnuva']) });
  });

  it('returns only the exact tag holder', async () => {
    const res = await request(app).get('/api/discover?tag=fps').set('Authorization', `Bearer ${token}`);
    // Alt dize eslesmesi olsaydi `fps-turnuva` da gelirdi.
    expect(names(res.body)).toEqual(['FPS Evi']);
  });

  it('is case-insensitive on the tag', async () => {
    const res = await request(app).get('/api/discover?tag=FPS').set('Authorization', `Bearer ${token}`);
    expect(names(res.body)).toEqual(['FPS Evi']);
  });

  it('returns nothing for a tag nobody carries', async () => {
    const res = await request(app).get('/api/discover?tag=yok').set('Authorization', `Bearer ${token}`);
    expect(res.body).toEqual([]);
  });
});

describe('category filtering applies only for a known category', () => {
  beforeEach(async () => {
    await seedServer('Oyuncular', { category: 'gaming' });
    await seedServer('Kodcular', { category: 'technology' });
    await seedServer('Kategorisiz', {});
  });

  it('filters to the requested category', async () => {
    const res = await request(app).get('/api/discover?category=gaming').set('Authorization', `Bearer ${token}`);
    expect(names(res.body)).toEqual(['Oyuncular']);
  });

  it('treats a server with no category as "other"', async () => {
    const res = await request(app).get('/api/discover?category=other').set('Authorization', `Bearer ${token}`);
    expect(names(res.body)).toEqual(['Kategorisiz']);
  });

  it('ignores an unrecognised category rather than emptying the list', async () => {
    const res = await request(app).get('/api/discover?category=uydurma').set('Authorization', `Bearer ${token}`);
    // Tanınmayan kategori bir FILTRE degildir; liste olduğu gibi doner.
    expect(names(res.body)).toHaveLength(3);
  });
});

describe('empty servers never reach the discover list', () => {
  it('hides a discoverable server that has no members', async () => {
    await seedServer('Dolu', {}, 2);
    await seedServer('Hayalet', {}, 0);

    const res = await request(app).get('/api/discover').set('Authorization', `Bearer ${token}`);
    expect(names(res.body)).toEqual(['Dolu']);
  });

  it('falls back to popular servers when nothing is explicitly discoverable', async () => {
    // Hicbir sunucu isaretlenmemis: liste bos kalmaz, uyesi olanlar gosterilir.
    const sid = uuidv4();
    const ownerId = uuidv4();
    await db.users.insert({ _id: ownerId, username: 'fb', displayName: 'FB', tokenVersion: 0 });
    await db.servers.insert({ _id: sid, name: 'Kalabalik', ownerId, createdAt: Date.now() });
    for (let i = 0; i < 4; i += 1) {
      await db.members.insert({ _id: uuidv4(), userId: uuidv4(), serverId: sid, joinedAt: Date.now() });
    }
    const lonely = uuidv4();
    await db.servers.insert({ _id: lonely, name: 'Tek Kisilik', ownerId, createdAt: Date.now() });
    await db.members.insert({ _id: uuidv4(), userId: uuidv4(), serverId: lonely, joinedAt: Date.now() });

    const res = await request(app).get('/api/discover').set('Authorization', `Bearer ${token}`);
    // Tek uyeli sunucu geri dususte de gosterilmez.
    expect(names(res.body)).toEqual(['Kalabalik']);
  });
});

describe('featured servers are ordered by when they were featured', () => {
  it('lists featured servers newest-first', async () => {
    await seedServer('Eski Vitrin', { featured: true, featuredAt: 1_000 });
    await seedServer('Yeni Vitrin', { featured: true, featuredAt: 9_000 });
    await seedServer('Vitrinsiz', {});

    const res = await request(app).get('/api/discover/featured').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect((res.body as Array<{ name: string }>).map(s => s.name)).toEqual(['Yeni Vitrin', 'Eski Vitrin']);
  });

  it('returns an empty list when nothing is featured', async () => {
    await seedServer('Sıradan', {});
    const res = await request(app).get('/api/discover/featured').set('Authorization', `Bearer ${token}`);
    expect(res.body).toEqual([]);
  });
});
