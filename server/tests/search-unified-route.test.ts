// server/tests/search-unified-route.test.ts
// FAZ SEARCH 2.0 — /api/search/unified UÇ NOKTASI.
//
// ════════════════════════════════════════════════════════════════════════════
// NE KORUNUYOR
// ════════════════════════════════════════════════════════════════════════════
// Birleşik arama iki FARKLI yetki modelini aynı sonuç kümesinde birleştirir:
//
//   • kanal / thread — SQL yalnızca sunucu ÜYELİĞİNE göre kapsar; kanal bazlı
//     VIEW_CHANNELS rotada uygulanır. Bu, `/api/search` ile aynı sözleşmedir
//     (bkz. search-channel-visibility.test.ts — kapatılan IDOR).
//   • DM / grup DM  — üyelik zaten SQL içinde zorunlu kılınmıştır.
//
// Bu ikilik iki yönde de bozulabilir ve İKİSİ DE ciddidir:
//   1. Kanal filtresi DM satırlarına da uygulanırsa (DM'in channelId'si
//      yoktur) kullanıcı KENDİ mesajlarını arayamaz — sessiz işlev kaybı.
//   2. Filtre kanal satırlarında atlanırsa kapatılan IDOR geri gelir.
// Her iki yön de burada kilitlenir.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

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
  verifyToken: (t: string) => { try { return require('jsonwebtoken').verify(t, 'test-jwt-secret-long-enough-32chars!!'); } catch { return null; } },
}));

import request from 'supertest';
import express from 'express';
const jwt = require('jsonwebtoken');

const MEMBER   = 'uye-1';
const SRV      = 'srv-A';
const PUBLIC_CH  = 'ch-acik';
const PRIVATE_CH = 'ch-gizli';
const VIEW_CHANNELS = 1 << 0;
const SECRET = 'kirmizidosya';

// Birleşik FTS taklidi: ÜRETİMDEKİ yetki bölüşümünü birebir yansıtır.
//   · kanal/thread → yalnızca sunucu kapsamı (kanal filtresi ROTADA)
//   · dm/gdm       → üyelik burada (SQL'de olduğu gibi) uygulanmış kabul edilir
const unifiedRows: Record<string, unknown>[] = [];
mockDb._unifiedSearch = (
  query: string,
  scope: { userId: string; serverIds: string[]; sources?: readonly string[] },
) => unifiedRows
  .filter(r => String(r.content ?? '').toLowerCase().includes(query.toLowerCase()))
  .filter(r => !scope.sources?.length || scope.sources.includes(String(r._source)))
  .filter(r => (r._source === 'channel' || r._source === 'thread')
    ? scope.serverIds.includes(String(r.serverId))
    : String(r._owner) === scope.userId);

import searchRouter from '../routes/search';

const app = express();
app.use(express.json());
app.use('/api/search', searchRouter);

const tok = (id: string) => jwt.sign({ id, username: id, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });

const unified = (user: string, q: string, extra = '') =>
  request(app).get(`/api/search/unified?q=${encodeURIComponent(q)}${extra}`)
    .set('Authorization', `Bearer ${tok(user)}`);

beforeAll(async () => {
  await mockDb.users.insert({ _id: MEMBER, username: MEMBER, displayName: 'Uye' });
  await mockDb.servers.insert({ _id: SRV, name: 'A', ownerId: 'sahip-A', createdAt: 1 });
  await mockDb.members.insert({ userId: MEMBER, serverId: SRV, roles: [], joinedAt: 1 });

  await mockDb.channels.insert({ _id: PUBLIC_CH,  serverId: SRV, name: 'genel-kanal', type: 'text', createdAt: 1 });
  await mockDb.channels.insert({ _id: PRIVATE_CH, serverId: SRV, name: 'gizli-oda',   type: 'text', createdAt: 1 });

  // GİZLİ kanal: @everyone için VIEW_CHANNELS açıkça REDDEDİLİR.
  await mockDb.channelOverrides.insert({
    _id: 'ovr-1', channelId: PRIVATE_CH, targetType: 'everyone', targetId: SRV,
    allow: 0, deny: VIEW_CHANNELS, position: 0,
  });

  unifiedRows.push(
    { _id: 'm-acik',   _source: 'channel', _score: 3, channelId: PUBLIC_CH,  serverId: SRV, content: `acik ${SECRET} mesaji`,  createdAt: 1000 },
    { _id: 'm-gizli',  _source: 'channel', _score: 4, channelId: PRIVATE_CH, serverId: SRV, content: `GIZLI ${SECRET} sifre`,  createdAt: 2000 },
    { _id: 't-acik',   _source: 'thread',  _score: 2, channelId: PUBLIC_CH,  serverId: SRV, threadId: 'th-1', content: `yanit ${SECRET}`, createdAt: 1500 },
    { _id: 't-gizli',  _source: 'thread',  _score: 5, channelId: PRIVATE_CH, serverId: SRV, threadId: 'th-2', content: `GIZLIYANIT ${SECRET}`, createdAt: 1600 },
    { _id: 'd-benim',  _source: 'dm',      _score: 1, dmId: 'dm-1',  _owner: MEMBER, content: `dm ${SECRET} icerik`, createdAt: 1700 },
    { _id: 'g-benim',  _source: 'gdm',     _score: 1, dmId: 'grp-1', _owner: MEMBER, content: `grup ${SECRET} icerik`, createdAt: 1800 },
  );
});

// ════════════════════════════════════════════════════════════════════════════
describe('/api/search/unified — kapsam', () => {
  it('POZİTİF KONTROL: dört kaynak da tek yanıtta döner', async () => {
    const res = await unified(MEMBER, SECRET);

    expect(res.status).toBe(200);
    const ids = (res.body.results as Array<{ _id: string }>).map(r => r._id);
    expect(ids).toEqual(expect.arrayContaining(['m-acik', 't-acik', 'd-benim', 'g-benim']));
  });

  it('DM ve grup DM satırları KANAL filtresine takılıp KAYBOLMAZ', async () => {
    // Bu satırların channelId'si yoktur; kanal filtresi ayrım yapmazsa
    // kullanıcı kendi konuşmalarını hiç arayamaz.
    const res = await unified(MEMBER, SECRET);

    const sources = (res.body.results as Array<{ source: string }>).map(r => r.source);
    expect(sources).toContain('dm');
    expect(sources).toContain('gdm');
  });

  it('her satır kaynağını bildirir', async () => {
    const res = await unified(MEMBER, SECRET);

    for (const row of res.body.results as Array<{ source: string }>)
      expect(['channel', 'dm', 'thread', 'gdm']).toContain(row.source);
  });

  it('kanal adı yalnızca kanal satırlarına eklenir', async () => {
    const res = await unified(MEMBER, SECRET);
    const rows = res.body.results as Array<{ _id: string; channelName: string | null }>;

    expect(rows.find(r => r._id === 'm-acik')!.channelName).toBe('genel-kanal');
    expect(rows.find(r => r._id === 'd-benim')!.channelName).toBeNull();
  });

  it('kaynak filtresi uygulanabilir', async () => {
    const res = await unified(MEMBER, SECRET, '&sources=dm');

    const sources = (res.body.results as Array<{ source: string }>).map(r => r.source);
    expect(new Set(sources)).toEqual(new Set(['dm']));
  });

  it('geçersiz kaynak 400 ile reddedilir (allowlist)', async () => {
    const res = await unified(MEMBER, SECRET, '&sources=users;drop');

    expect(res.status).toBe(400);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('/api/search/unified — kanal görünürlüğü (VIEW_CHANNELS)', () => {
  it('GÜVENLİK: VIEW_CHANNELS reddedilen kanalın MESAJI dönmez', async () => {
    const res = await unified(MEMBER, SECRET);

    const ids = (res.body.results as Array<{ _id: string }>).map(r => r._id);
    expect(ids).not.toContain('m-gizli');
  });

  it('GÜVENLİK: aynı filtre THREAD yanıtlarına da uygulanır', async () => {
    // Thread yanıtları kanala aittir; kanal görünmüyorsa yanıt da görünmez.
    // Bu unutulursa kapatılan IDOR thread üzerinden geri açılır.
    const res = await unified(MEMBER, SECRET);

    const ids = (res.body.results as Array<{ _id: string }>).map(r => r._id);
    expect(ids).not.toContain('t-gizli');
  });

  it('GÜVENLİK: gizli içerik PARÇACIKTA da sızmaz', async () => {
    const res = await unified(MEMBER, SECRET);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('GIZLI');
    expect(body).not.toContain('sifre');
    expect(body).not.toContain(PRIVATE_CH);
  });

  it('sayfalama sayıları gizli sonuçları SAYMAZ', async () => {
    const res = await unified(MEMBER, SECRET, '&limit=2');

    expect((res.body.results as unknown[]).length).toBe(2);
    expect(JSON.stringify(res.body)).not.toContain('GIZLI');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('/api/search/unified — girdi sınırları', () => {
  it('kimliksiz istek 401', async () => {
    const res = await request(app).get('/api/search/unified?q=merhaba');
    expect(res.status).toBe(401);
  });

  it('çok kısa sorgu sonuç aramaz', async () => {
    const res = await unified(MEMBER, 'a');
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it('backend yoksa 503 — sessiz BOŞ sonuç değil', async () => {
    // Boş dizi dönmek "hiç eşleşme yok" ile "arama çalışmıyor"u aynı
    // gösterirdi; kullanıcı da istemci de bunu ayırt edemezdi.
    const saved = mockDb._unifiedSearch;
    delete mockDb._unifiedSearch;
    try {
      const res = await unified(MEMBER, SECRET);
      expect(res.status).toBe(503);
    } finally {
      mockDb._unifiedSearch = saved;
    }
  });
});
