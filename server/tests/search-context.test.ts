// server/tests/search-context.test.ts
//
// ARAMA BAĞLAM ÖNİZLEMESİ — YETKİ SINIRI VE İÇERİK SÖZLEŞMESİ
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BU PAKET VAR
// ════════════════════════════════════════════════════════════════════════════
// `/api/search/context`, aramanın kendisinden DAHA FAZLA içerik döndürür:
// kullanıcının sorgusuyla EŞLEŞMEYEN komşu mesajlar. Yani arama sınırını
// doğrulamak YETMEZ — bağlam ayrı bir sızıntı yüzeyidir.
//
// Kilitlenen sınırlar:
//   · sunucu üyeliği olsa bile VIEW_CHANNELS reddedilmiş kanalın bağlamı
//     ALINAMAZ (C2 dersi: sunucu üyeliği kanal erişimi kanıtlamaz)
//   · başkasının DM'inin bağlamı ALINAMAZ
//   · var olmayan mesaj ile yetkisiz mesaj AYNI yanıtı üretir (varlık sızmaz)
//   · `source` bir allowlist'tir
//   · yanıt DÜZ METİNDİR — sunucu HTML üretmez
//
// Her negatif iddianın yanında, o yola GERÇEKTEN ulaşıldığını gösteren bir
// POZİTİF KONTROL vardır; aksi halde test "her şey 404" diye de geçerdi.

//
// ── SAHTE KATMAN NEREDE DURUYOR ─────────────────────────────────────────
// `_searchContext` taklidi SQL katmanının yaptığını yapar: DM/grup DM
// üyeliğini uygular, kanal/thread için YALNIZCA sunucu üyeliğini uygular.
// Kanal bazlı VIEW_CHANNELS'i BİLEREK uygulamaz — o denetimin ROTADA
// olduğunu kanıtlamak için şart.

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

const VIEW_CHANNELS = 1 << 0;

const MEMBER   = 'uye-1';
const OUTSIDER = 'yabanci-1';
const SRV_A    = 'srv-A';
const SRV_B    = 'srv-B';
const PUBLIC_CH  = 'ch-acik';
const PRIVATE_CH = 'ch-gizli';

// ── Bellek içi mesaj deposu (dört kaynak) ────────────────────────────────
interface Row {
  _id: string; userId: string; displayName: string; content: string; createdAt: number;
  channelId?: string; serverId?: string; threadId?: string; dmId?: string; groupId?: string;
}

const channelRows: Row[] = [
  { _id: 'c1', channelId: PUBLIC_CH, serverId: SRV_A, userId: MEMBER, displayName: 'U', content: 'once bunu konustuk', createdAt: 1000 },
  { _id: 'c2', channelId: PUBLIC_CH, serverId: SRV_A, userId: MEMBER, displayName: 'U', content: 'ISABET burada',      createdAt: 2000 },
  { _id: 'c3', channelId: PUBLIC_CH, serverId: SRV_A, userId: MEMBER, displayName: 'U', content: 'sonra bunu dedik',   createdAt: 3000 },
  { _id: 'c4', channelId: PUBLIC_CH, serverId: SRV_A, userId: MEMBER, displayName: 'U', content: 'en son bu',          createdAt: 4000 },
  { _id: 'p1', channelId: PRIVATE_CH, serverId: SRV_A, userId: MEMBER, displayName: 'U', content: 'gizli oncesi',      createdAt: 1500 },
  { _id: 'p2', channelId: PRIVATE_CH, serverId: SRV_A, userId: MEMBER, displayName: 'U', content: 'GIZLI ISABET',      createdAt: 2500 },
  { _id: 'p3', channelId: PRIVATE_CH, serverId: SRV_A, userId: MEMBER, displayName: 'U', content: 'gizli sonrasi',     createdAt: 3500 },
];

const dmRows: Row[] = [
  { _id: 'd1', dmId: 'dm-ab', userId: MEMBER,   displayName: 'U', content: 'dm oncesi',  createdAt: 1000 },
  { _id: 'd2', dmId: 'dm-ab', userId: OUTSIDER, displayName: 'Y', content: 'dm ISABET',  createdAt: 2000 },
  { _id: 'd3', dmId: 'dm-ab', userId: MEMBER,   displayName: 'U', content: 'dm sonrasi', createdAt: 3000 },
  // MEMBER'in katılımcı OLMADIĞI bir konuşma.
  { _id: 'x1', dmId: 'dm-xy', userId: 'baska-1', displayName: 'B', content: 'ozel oncesi',  createdAt: 1000 },
  { _id: 'x2', dmId: 'dm-xy', userId: 'baska-2', displayName: 'C', content: 'ozel ISABET',  createdAt: 2000 },
  { _id: 'x3', dmId: 'dm-xy', userId: 'baska-1', displayName: 'B', content: 'ozel sonrasi', createdAt: 3000 },
];

const DM_PARTICIPANTS: Record<string, string[]> = {
  'dm-ab': [MEMBER, OUTSIDER],
  'dm-xy': ['baska-1', 'baska-2'],
};

/**
 * SQL katmanının taklidi. Uyguladığı yetkiler ÜRETİMDEKİYLE aynı:
 *   · dm  → katılımcılık
 *   · channel → SUNUCU üyeliği (kanal düzeyi BİLEREK uygulanmaz)
 */
mockDb._searchContext = async (
  messageId: string,
  source: string,
  scope: { userId: string; serverIds: string[] },
  radius: number,
) => {
  const r = Math.min(5, Math.max(1, radius || 2));

  if (source === 'dm') {
    const anchor = dmRows.find(x => x._id === messageId);
    if (!anchor) return null;
    if (!DM_PARTICIPANTS[anchor.dmId!]?.includes(scope.userId)) return null;   // SQL içi yetki
    const all = dmRows.filter(x => x.dmId === anchor.dmId).sort((a, b) => a.createdAt - b.createdAt);
    return { messages: windowAround(all, anchor, r), channelId: null, serverId: null };
  }

  if (source === 'channel') {
    const anchor = channelRows.find(x => x._id === messageId);
    if (!anchor) return null;
    if (!scope.serverIds.includes(anchor.serverId!)) return null;              // SQL içi yetki
    const all = channelRows.filter(x => x.channelId === anchor.channelId).sort((a, b) => a.createdAt - b.createdAt);
    return { messages: windowAround(all, anchor, r), channelId: anchor.channelId!, serverId: anchor.serverId! };
  }

  return null;
};

function windowAround(all: Row[], anchor: Row, r: number) {
  const i = all.findIndex(x => x._id === anchor._id);
  return all.slice(Math.max(0, i - r), i + r + 1).map(x => ({
    _id: x._id, userId: x.userId, displayName: x.displayName,
    content: x.content, createdAt: x.createdAt, isAnchor: x._id === anchor._id,
  }));
}

import searchRouter from '../routes/search';

const app = express();
app.use(express.json());
app.use('/api/search', searchRouter);
app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(err.status || 500).json({ error: err.message }));

const tok = (id: string) => jwt.sign({ id, username: id, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });

const ctx = (user: string, qs: string) =>
  request(app).get(`/api/search/context?${qs}`).set('Authorization', `Bearer ${tok(user)}`);

beforeAll(async () => {
  await mockDb.users.insert({ _id: MEMBER,   username: MEMBER,   displayName: 'Uye' });
  await mockDb.users.insert({ _id: OUTSIDER, username: OUTSIDER, displayName: 'Yabanci' });

  await mockDb.servers.insert({ _id: SRV_A, name: 'A', ownerId: 'sahip-A', createdAt: 1 });
  await mockDb.servers.insert({ _id: SRV_B, name: 'B', ownerId: 'sahip-B', createdAt: 1 });

  await mockDb.members.insert({ userId: MEMBER,   serverId: SRV_A, roles: [], joinedAt: 1 });
  await mockDb.members.insert({ userId: OUTSIDER, serverId: SRV_B, roles: [], joinedAt: 1 });

  await mockDb.channels.insert({ _id: PUBLIC_CH,  serverId: SRV_A, name: 'genel-kanal', type: 'text', createdAt: 1 });
  await mockDb.channels.insert({ _id: PRIVATE_CH, serverId: SRV_A, name: 'gizli-oda',   type: 'text', createdAt: 1 });

  // GİZLİ kanal: @everyone için VIEW_CHANNELS açıkça REDDEDİLİR.
  await mockDb.channelOverrides.insert({
    _id: 'ovr-ctx', channelId: PRIVATE_CH, targetType: 'everyone', targetId: SRV_A,
    allow: 0, deny: VIEW_CHANNELS, position: 0,
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('bağlam — çalışıyor (POZİTİF KONTROL)', () => {
  it('görünür kanaldaki isabetin çevresi döner', async () => {
    const res = await ctx(MEMBER, 'id=c2&source=channel&radius=1');

    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: { _id: string }) => m._id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('çapa işaretlidir ve YALNIZCA biridir', async () => {
    const res = await ctx(MEMBER, 'id=c2&source=channel&radius=2');
    const anchors = res.body.messages.filter((m: { isAnchor: boolean }) => m.isAnchor);

    expect(anchors).toHaveLength(1);
    expect(anchors[0]._id).toBe('c2');
  });

  it('mesajlar ZAMAN SIRASINDA döner', async () => {
    const res = await ctx(MEMBER, 'id=c3&source=channel&radius=2');
    const times = res.body.messages.map((m: { createdAt: number }) => m.createdAt);

    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('kendi DM konuşmasının bağlamı döner', async () => {
    const res = await ctx(MEMBER, 'id=d2&source=dm&radius=1');

    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: { _id: string }) => m._id)).toEqual(['d1', 'd2', 'd3']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('bağlam — yetki sınırı', () => {
  it('VIEW_CHANNELS REDDEDİLMİŞ kanalın bağlamı ALINAMAZ', async () => {
    // Kullanıcı sunucunun ÜYESİ; SQL katmanı satırı döndürür. Rotanın kanal
    // düzeyi denetimi olmasaydı gizli konuşma buradan sızardı.
    const res = await ctx(MEMBER, 'id=p2&source=channel&radius=2');

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('GIZLI');
  });

  it('gizli kanalın KOMŞU mesajları da sızmaz', async () => {
    const res = await ctx(MEMBER, 'id=p2&source=channel&radius=5');
    const body = JSON.stringify(res.body);

    for (const leak of ['gizli oncesi', 'gizli sonrasi', 'p1', 'p3']) {
      expect(body).not.toContain(leak);
    }
  });

  it('BAŞKASININ DM bağlamı ALINAMAZ', async () => {
    const res = await ctx(MEMBER, 'id=x2&source=dm&radius=2');

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('ozel');
  });

  it('sunucunun ÜYESİ OLMAYAN kullanıcı bağlam alamaz', async () => {
    // OUTSIDER yalnızca SRV_B üyesidir.
    const res = await ctx(OUTSIDER, 'id=c2&source=channel&radius=2');

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('ISABET');
  });

  it('kimliksiz istek reddedilir', async () => {
    const res = await request(app).get('/api/search/context?id=c2&source=channel');
    expect(res.status).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('bağlam — varlık sızdırmaz', () => {
  it('YOK OLAN mesaj ile YETKİSİZ mesaj AYNI yanıtı verir', async () => {
    const yok      = await ctx(MEMBER, 'id=boyle-bir-mesaj-yok&source=channel');
    const yetkisiz = await ctx(MEMBER, 'id=p2&source=channel');

    expect(yok.status).toBe(yetkisiz.status);
    expect(yok.body).toEqual(yetkisiz.body);
  });

  it('yetkisiz DM ile olmayan DM AYNI yanıtı verir', async () => {
    const yok      = await ctx(MEMBER, 'id=yok-dm&source=dm');
    const yetkisiz = await ctx(MEMBER, 'id=x2&source=dm');

    expect(yok.status).toBe(yetkisiz.status);
    expect(yok.body).toEqual(yetkisiz.body);
  });
});

// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
describe('bağlam — girdi sözleşmesi', () => {
  it('kaynak bir ALLOWLIST\'tir', async () => {
    for (const bad of ['messages', 'users', '../admin', 'CHANNEL', '']) {
      const res = await ctx(MEMBER, `id=c2&source=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
    }
  });

  it('mesaj kimliği zorunludur', async () => {
    const res = await ctx(MEMBER, 'source=channel');
    expect(res.status).toBe(400);
  });

  it('yarıçap ÜST SINIRA kelepçelenir', async () => {
    // İstemci sınırsız pencere isteyerek kanalın tamamını çekemez.
    const res = await ctx(MEMBER, 'id=c2&source=channel&radius=9999');

    expect(res.status).toBe(200);
    expect(res.body.messages.length).toBeLessThanOrEqual(11);   // 5 önce + çapa + 5 sonra
  });

  it('bozuk yarıçap strict 400 ile reddedilir', async () => {
    for (const bad of ['abc', '-3', '0', '1.5', '10oops', '9007199254740992']) {
      const res = await ctx(MEMBER, `id=c2&source=channel&radius=${bad}`);
      expect(res.status).toBe(400);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('bağlam — içerik DÜZ METİNDİR', () => {
  it('sunucu HTML üretmez', async () => {
    const res = await ctx(MEMBER, 'id=c2&source=channel&radius=2');
    const body = JSON.stringify(res.body);

    // Vurgulama istemcinin işidir; sunucu işaretleme döndürseydi bu yanıt
    // bir `innerHTML` yolunda XSS taşıyıcısı olurdu.
    expect(body).not.toMatch(/<mark|<b>|<span|<em/i);
  });

  it('yalnızca sözleşmedeki alanlar döner', async () => {
    const res = await ctx(MEMBER, 'id=c2&source=channel&radius=1');

    for (const m of res.body.messages) {
      expect(Object.keys(m).sort()).toEqual(
        ['_id', 'content', 'createdAt', 'displayName', 'isAnchor', 'userId'],
      );
    }
  });
});
