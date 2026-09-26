// server/tests/search-channel-visibility.test.ts
// FAZ D / SEARCH — KANAL GÖRÜNÜRLÜĞÜ (VIEW_CHANNELS) IDOR REGRESYONLARI.
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK AÇIK
// ════════════════════════════════════════════════════════════════════════════
// `/api/search` sonuçları YALNIZCA sunucu ÜYELİĞİNE göre kapsanıyordu:
//     Messages.ftsSearch(term, serverIds, 500)
//     Channels.findWhere({ serverId: { $in: serverIds } })
// Oysa ürünün kanonik sözleşmesi kanal başına görünürlüktür: mesaj geçmişi
// `routes/messages.ts` içinde `resolvePermissions(user, serverId, channelId)`
// + VIEW_CHANNELS ile korunur ve C2 kanal başına allow/deny override'ları
// eklemiştir.
//
// Sonuç: VIEW_CHANNELS'i REDDEDİLMİŞ bir sunucu ÜYESİ, arama üzerinden
// göremediği kanalın MESAJ İÇERİĞİNİ, vurgulanmış PARÇACIĞINI ve kanal ADINI
// elde edebiliyordu. Sunucu üyeliği kanal erişimi KANITLAMAZ (C2 dersi).
//
// Bu paket sınırı DAVRANIŞLA kilitler ve her negatif iddianın yanında
// gerçekten oraya ULAŞILDIĞINI gösteren POZİTİF KONTROL bulundurur.

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

// FTS taklidi: sunucu kapsamı uygular (üretimdeki gibi), kanal kapsamı
// UYGULAMAZ — kanal filtresinin rotada olduğunu kanıtlamak için şart.
const store: Record<string, Record<string, unknown>> = {};
let lastFtsAllowedChannels: string[] | undefined;
mockDb._ftsSearch = (query: string, serverIds: string[], limit = 20, allowedChannelIds?: string[]) => {
  lastFtsAllowedChannels = allowedChannelIds ? [...allowedChannelIds] : undefined;
  return Object.values(store)
    .filter((m) => serverIds.includes(String(m.serverId)) &&
                   (!allowedChannelIds || allowedChannelIds.includes(String(m.channelId))) &&
                   String(m.content ?? '').toLowerCase().includes(query.toLowerCase()))
    .slice(0, limit);
};

const origInsert = mockDb.messages.insert.bind(mockDb.messages);
mockDb.messages.insert = async (doc: Record<string, unknown>) => {
  const r = await origInsert(doc);
  store[String(r._id)] = r;
  return r;
};

import searchRouter from '../routes/search';

const app = express();
app.use(express.json());
app.use('/api/search', searchRouter);
app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(err.status || 500).json({ error: err.message }));

const tok = (id: string) => jwt.sign({ id, username: id, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });

const MEMBER   = 'uye-1';
const OUTSIDER = 'yabanci-1';
const SRV_A    = 'srv-A';
const SRV_B    = 'srv-B';

const PUBLIC_CH  = 'ch-acik';
const PRIVATE_CH = 'ch-gizli';
const OTHER_CH   = 'ch-baska-sunucu';

const VIEW_CHANNELS = 1 << 0;
const SECRET = 'kirmizidosya';   // her iki kanalda da geçen arama terimi

beforeAll(async () => {
  await mockDb.users.insert({ _id: MEMBER,   username: MEMBER,   displayName: 'Uye' });
  await mockDb.users.insert({ _id: OUTSIDER, username: OUTSIDER, displayName: 'Yabanci' });

  // Sahip BAŞKASI: üye, sahip kısayolu değil GERÇEK üyelik yolundan geçer.
  await mockDb.servers.insert({ _id: SRV_A, name: 'A', ownerId: 'sahip-A', createdAt: 1 });
  await mockDb.servers.insert({ _id: SRV_B, name: 'B', ownerId: 'sahip-B', createdAt: 1 });

  // roles JSONB'dir → GERÇEK dizi (üretim şekli).
  await mockDb.members.insert({ userId: MEMBER,   serverId: SRV_A, roles: [], joinedAt: 1 });
  await mockDb.members.insert({ userId: OUTSIDER, serverId: SRV_B, roles: [], joinedAt: 1 });

  await mockDb.channels.insert({ _id: PUBLIC_CH,  serverId: SRV_A, name: 'genel-kanal',  type: 'text', createdAt: 1 });
  await mockDb.channels.insert({ _id: PRIVATE_CH, serverId: SRV_A, name: 'gizli-oda',    type: 'text', createdAt: 1 });
  await mockDb.channels.insert({ _id: OTHER_CH,   serverId: SRV_B, name: 'baska-sunucu', type: 'text', createdAt: 1 });

  // GİZLİ kanal: @everyone için VIEW_CHANNELS açıkça REDDEDİLİR.
  await mockDb.channelOverrides.insert({
    _id: 'ovr-1', channelId: PRIVATE_CH, targetType: 'everyone', targetId: SRV_A,
    allow: 0, deny: VIEW_CHANNELS, position: 0,
  });

  await mockDb.messages.insert({ _id: 'm-acik',  channelId: PUBLIC_CH,  serverId: SRV_A, userId: MEMBER, displayName: 'U', content: `acik ${SECRET} mesaji`,  type: 'normal', reactions: {}, createdAt: 1000 });
  await mockDb.messages.insert({ _id: 'm-gizli', channelId: PRIVATE_CH, serverId: SRV_A, userId: MEMBER, displayName: 'U', content: `GIZLI ${SECRET} sifre`,  type: 'normal', reactions: {}, createdAt: 2000 });
  await mockDb.messages.insert({ _id: 'm-b',     channelId: OTHER_CH,   serverId: SRV_B, userId: OUTSIDER, displayName: 'Y', content: `B ${SECRET} icerik`,  type: 'normal', reactions: {}, createdAt: 3000 });
});

const search = (user: string, q: string, extra = '') =>
  request(app).get(`/api/search?q=${encodeURIComponent(q)}${extra}`).set('Authorization', `Bearer ${tok(user)}`);

// ════════════════════════════════════════════════════════════════════════════
describe('SEARCH — kanal görünürlüğü (VIEW_CHANNELS)', () => {
  it('POZİTİF KONTROL: görünür kanaldaki eşleşme DÖNER', async () => {
    const res = await search(MEMBER, SECRET);

    expect(res.status).toBe(200);
    const ids = (res.body.messages as Array<{ _id: string }>).map(m => m._id);
    expect(ids).toContain('m-acik');
  });

  it('[RANKING PRIVACY] FTS backend gizli kanalı ranking/LIMIT öncesi allowlist dışında görür', async () => {
    const res = await search(MEMBER, SECRET);

    expect(res.status).toBe(200);
    expect(lastFtsAllowedChannels).toContain(PUBLIC_CH);
    expect(lastFtsAllowedChannels).not.toContain(PRIVATE_CH);
    expect(lastFtsAllowedChannels).not.toContain(OTHER_CH);
  });

  it('GÜVENLİK: VIEW_CHANNELS reddedilen kanalın MESAJI dönmez', async () => {
    const res = await search(MEMBER, SECRET);

    const ids = (res.body.messages as Array<{ _id: string }>).map(m => m._id);
    expect(ids).not.toContain('m-gizli');
  });

  it('GÜVENLİK: gizli içerik PARÇACIKTA (highlight) da sızmaz', async () => {
    const res = await search(MEMBER, SECRET);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('GIZLI');
    expect(body).not.toContain('sifre');
  });

  it('GÜVENLİK: gizli kanalın ADI kanal aramasında dönmez', async () => {
    const res = await search(MEMBER, 'gizli-oda');

    const names = (res.body.channels as Array<{ name: string }>).map(c => c.name);
    expect(names).not.toContain('gizli-oda');
    expect(JSON.stringify(res.body)).not.toContain('gizli-oda');
  });

  it('POZİTİF KONTROL: görünür kanalın ADI DÖNER', async () => {
    const res = await search(MEMBER, 'genel-kanal');

    const names = (res.body.channels as Array<{ name: string }>).map(c => c.name);
    expect(names).toContain('genel-kanal');
  });

  it('GÜVENLİK: gizli kanal kimliği hiçbir alanda sızmaz', async () => {
    const res = await search(MEMBER, SECRET);

    expect(JSON.stringify(res.body)).not.toContain(PRIVATE_CH);
  });

  it('sayfalama sayıları gizli sonuçları SAYMAZ', async () => {
    // `hasMore`/offset gizli içeriği sayarsa varlığını ele verirdi.
    const res = await search(MEMBER, SECRET, '&limit=1');

    expect(res.body.messages.length).toBeLessThanOrEqual(1);
    expect(JSON.stringify(res.body)).not.toContain('GIZLI');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('SEARCH — çapraz sunucu izolasyonu', () => {
  it('GÜVENLİK: üye olunmayan sunucunun mesajı dönmez', async () => {
    const res = await search(MEMBER, SECRET);

    const ids = (res.body.messages as Array<{ _id: string }>).map(m => m._id);
    expect(ids).not.toContain('m-b');
    expect(JSON.stringify(res.body)).not.toContain('B ' + SECRET);
  });

  it('GÜVENLİK: yabancı serverId filtresi 403 ile reddedilir', async () => {
    const res = await search(MEMBER, SECRET, `&serverId=${SRV_B}`);

    expect(res.status).toBe(403);
  });

  it('POZİTİF KONTROL: kendi sunucusu serverId filtresiyle çalışır', async () => {
    const res = await search(MEMBER, SECRET, `&serverId=${SRV_A}`);

    expect(res.status).toBe(200);
    expect((res.body.messages as unknown[]).length).toBeGreaterThan(0);
  });

  it('GÜVENLİK: diğer sunucunun üyesi A’nın içeriğini göremez', async () => {
    const res = await search(OUTSIDER, SECRET);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('GIZLI');
    expect(body).not.toContain('acik ');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('SEARCH — girdi sınırları ve fail-closed davranış', () => {
  it('kimliksiz istek 401', async () => {
    const res = await request(app).get('/api/search?q=deneme');

    expect(res.status).toBe(401);
  });

  it('çok kısa sorgu boş sonuç döner (pahalı FTS tetiklenmez)', async () => {
    const res = await search(MEMBER, 'a');

    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(res.body.channels).toEqual([]);
  });

  it('limit üst sınırı uygulanır (50)', async () => {
    const res = await search(MEMBER, SECRET, '&limit=9999');

    expect(res.status).toBe(200);
    expect((res.body.messages as unknown[]).length).toBeLessThanOrEqual(50);
  });

  it('negatif offset açıkça reddedilir', async () => {
    const res = await search(MEMBER, SECRET, '&offset=-5');

    expect(res.status).toBe(400);
  });

  it('bozuk serverId sonuç sızdırmaz', async () => {
    const res = await search(MEMBER, SECRET, '&serverId=' + encodeURIComponent("' OR 1=1 --"));

    expect(res.status).toBe(403);
  });

  it('bozuk `in:` modifier aramayı GENİŞLETMEZ; boş sonuç döner', async () => {
    const res = await search(MEMBER, SECRET, '&in=' + encodeURIComponent('#yok-boyle-kanal'));

    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain('GIZLI');
  });

  it('tam channelId görünür kanala yapısal olarak kilitlenir ve FTS allowlist de daralır', async () => {
    const res = await search(MEMBER, SECRET, `&channelId=${PUBLIC_CH}&type=messages`);

    expect(res.status).toBe(200);
    expect((res.body.messages as Array<{ _id: string }>).map(m => m._id)).toEqual(['m-acik']);
    expect(lastFtsAllowedChannels).toEqual([PUBLIC_CH]);
  });

  it('tam channelId gizli/bilinmeyen kanal varlığını sızdırmadan boş döner', async () => {
    const hidden = await search(MEMBER, SECRET, `&channelId=${PRIVATE_CH}&type=messages`);
    const missing = await search(MEMBER, SECRET, '&channelId=ch-yok&type=messages');

    expect(hidden.status).toBe(200);
    expect(missing.status).toBe(200);
    expect(hidden.body).toEqual({ messages: [], channels: [], members: [], hasMore: false });
    expect(missing.body).toEqual(hidden.body);
  });

  it('aşırı uzun channelId açıkça reddedilir', async () => {
    const res = await search(MEMBER, SECRET, '&channelId=' + 'x'.repeat(129));
    expect(res.status).toBe(400);
  });
});
