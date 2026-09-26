// server/tests/search-modifier-filters-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ARAMA SÜZGEÇLERİ — `from:` `in:` `has:` `before:` `after:` VE KANAL KAPSAMI
// ════════════════════════════════════════════════════════════════════════════
//
// Arama süzgeçlerinin TEK yönlü olması bir GÜVENLİK sözleşmesidir: yetki
// elemesi süzgeçlerden ÖNCE yapılır ve hiçbir süzgeç sonuç kümesine satır
// EKLEYEMEZ. Ölçülmemiş dallar tam olarak bu sözleşmenin kenarlarıdır:
//
//   · TARİH SÜZGECİ — geçersiz bir tarih (`before:yarın`) sonucu DARALTMAMALI,
//     ama geçerli bir tarih kesin olarak daraltmalıdır. Yanlış tarafa düşen
//     bir dal, "before" verildiğinde tüm sonuçları silerdi.
//   · KANAL KAPSAMI — `channelId` verildiğinde ad tabanlı `in:` YOK SAYILIR;
//     iki farklı kanalın aynı adı taşıyabildiği düşünülürse bu ayrım kritik.
//   · GÖRÜNMEYEN KANAL — kullanıcının göremediği bir kanal kimliği verilirse
//     depo katmanına HİÇ gidilmez ve varlık bilgisi sızmaz.
//   · SIRALAMA — kanal sonuçları ada göre kararlı sıralanır.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV = 'test';

import express from 'express';
import request from 'supertest';

const members = { findByUser: jest.fn(), findWhere: jest.fn(), findOne: jest.fn(), findByServer: jest.fn() };
const channels = { findWhere: jest.fn() };
const users = { findWhere: jest.fn(), findByIds: jest.fn() };
const messages = {
  hasFtsSearch: jest.fn(), ftsSearch: jest.fn(),
  hasUnifiedSearch: jest.fn(), unifiedSearch: jest.fn(),
  hasSearchContext: jest.fn(), searchContext: jest.fn(),
};
const getCachedPerms = jest.fn();

jest.mock('../db/repositories', () => ({ Members: members, Channels: channels, Users: users, Messages: messages }));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => { req.user = { id: 'u1', username: 'tester' }; next(); },
}));
jest.mock('../middleware/rateLimit', () => ({
  limits: new Proxy({}, { get: () => () => (_q: any, _s: any, n: any) => n() }),
}));
jest.mock('../lib/permCache', () => ({ getCachedPerms: (...args: any[]) => getCachedPerms(...args) }));

import searchRouter from '../routes/search';

const app = express();
app.use(express.json());
app.use('/api/search', searchRouter);
app.use((err: any, _q: any, res: any, _n: any) => res.status(err?.status || 500).json({ error: err?.message || 'error' }));

const VIEW_CHANNELS = 1 << 0;

const CHANNELS = [
  { _id: 'c1', serverId: 's1', name: 'general' },
  { _id: 'c2', serverId: 's1', name: 'general' },   // AYNI ad, farkli kimlik
  { _id: 'c3', serverId: 's1', name: 'duyurular' },
];

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: `m-${Math.random().toString(36).slice(2, 8)}`,
    _source: 'channel', channelId: 'c1', serverId: 's1',
    userId: 'u9', username: 'ada', displayName: 'Ada Lovelace',
    content: 'merhaba dünya', createdAt: 1_000,
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  members.findByUser.mockResolvedValue([{ serverId: 's1' }]);
  channels.findWhere.mockImplementation(async (where: any) => {
    if (where?.serverId?.$in) return CHANNELS;
    if (where?._id?.$in) return CHANNELS.filter(c => where._id.$in.includes(c._id));
    return [];
  });
  getCachedPerms.mockResolvedValue(VIEW_CHANNELS);
  messages.hasFtsSearch.mockReturnValue(true);
  messages.ftsSearch.mockResolvedValue([]);
  messages.hasUnifiedSearch.mockReturnValue(true);
  messages.unifiedSearch.mockResolvedValue([]);
  messages.hasSearchContext.mockReturnValue(true);
  messages.searchContext.mockResolvedValue(null);
  members.findWhere.mockResolvedValue([]);
  members.findOne.mockResolvedValue({ userId: 'u1', serverId: 's1' });
  members.findByServer.mockResolvedValue([]);
  users.findWhere.mockResolvedValue([]);
  users.findByIds.mockResolvedValue([]);
});

const unified = (query: Record<string, unknown>) => request(app).get('/api/search/unified').query(query);
const ids = (body: { results?: Array<{ _id: string }> }): string[] => (body.results ?? []).map(r => r._id);

describe('tarih süzgeçleri', () => {
  beforeEach(() => {
    messages.unifiedSearch.mockResolvedValue([
      row({ _id: 'eski', createdAt: Date.parse('2026-01-01T00:00:00Z') }),
      row({ _id: 'orta', createdAt: Date.parse('2026-06-01T00:00:00Z') }),
      row({ _id: 'yeni', createdAt: Date.parse('2026-09-01T00:00:00Z') }),
    ]);
  });

  it('`before` yalnız daha eski satırları bırakır', async () => {
    const res = await unified({ q: 'merhaba', before: '2026-05-01' });
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual(['eski']);
  });

  it('`after` yalnız daha yeni satırları bırakır', async () => {
    const res = await unified({ q: 'merhaba', after: '2026-05-01' });
    expect(ids(res.body)).toEqual(['orta', 'yeni']);
  });

  it('ikisi birlikte aralık oluşturur', async () => {
    const res = await unified({ q: 'merhaba', after: '2026-03-01', before: '2026-08-01' });
    expect(ids(res.body)).toEqual(['orta']);
  });

  it('çözümlenemeyen tarih sonucu DARALTMAZ', async () => {
    const res = await unified({ q: 'merhaba', before: 'yarın', after: 'gecen-hafta' });
    // Gecersiz tarih sessizce yok sayilir; tum sonuclar korunur.
    expect(ids(res.body)).toEqual(['eski', 'orta', 'yeni']);
  });

  it('zaman damgası olmayan satır sıfır kabul edilir', async () => {
    messages.unifiedSearch.mockResolvedValue([row({ _id: 'damgasiz', createdAt: undefined })]);

    const before = await unified({ q: 'merhaba', before: '2026-05-01' });
    expect(ids(before.body)).toEqual(['damgasiz']);

    const after = await unified({ q: 'merhaba', after: '2026-05-01' });
    expect(ids(after.body)).toEqual([]);
  });
});

describe('kanal kapsamı ve `in:` süzgeci', () => {
  beforeEach(() => {
    messages.unifiedSearch.mockResolvedValue([
      row({ _id: 'c1-satiri', channelId: 'c1' }),
      row({ _id: 'c2-satiri', channelId: 'c2' }),
      row({ _id: 'c3-satiri', channelId: 'c3' }),
    ]);
  });

  it('`in:` ada göre süzer ve aynı adı taşıyan iki kanalı da kapsar', async () => {
    const res = await unified({ q: 'merhaba', in: '#general' });
    expect(ids(res.body)).toEqual(['c1-satiri', 'c2-satiri']);
  });

  it('kanal kimliği verildiğinde ad tabanlı `in:` yok sayılır', async () => {
    const res = await unified({ q: 'merhaba', channelId: 'c3', in: '#general' });
    expect(ids(res.body)).toEqual(['c3-satiri']);
    expect(messages.unifiedSearch.mock.calls[0]![1]).toMatchObject({ channelIds: ['c3'] });
  });

  it('kanal kimliği bilinmeyen ada işaret ederse boş küme kalır', async () => {
    const res = await unified({ q: 'merhaba', in: '#olmayan-kanal' });
    expect(ids(res.body)).toEqual([]);
  });

  it('görünmeyen kanal kimliği depo katmanına hiç gitmez', async () => {
    const res = await unified({ q: 'merhaba', channelId: 'gizli-kanal' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [], hasMore: false });
    expect(messages.unifiedSearch).not.toHaveBeenCalled();
  });

  it('kanal adı çözülemeyen satır ad süzgecine takılır, kimlik süzgecine değil', async () => {
    messages.unifiedSearch.mockResolvedValue([row({ _id: 'dm-satiri', _source: 'dm', channelId: undefined })]);

    const byName = await unified({ q: 'merhaba', in: '#general' });
    expect(ids(byName.body)).toEqual([]);

    const byId = await unified({ q: 'merhaba', channelId: 'c1' });
    // Kanal kimligi olmayan DM satiri yapisal kapsamin disinda kalir.
    expect(ids(byId.body)).toEqual([]);
  });
});

describe('`from:` ve `has:` süzgeçleri', () => {
  it('`from:` kimliğe, kullanıcı adına ve görünen ada göre eşleşir', async () => {
    messages.unifiedSearch.mockResolvedValue([
      row({ _id: 'kimlik', userId: 'kullanici-kimligi-12345' }),
      row({ _id: 'kullanici-adi', userId: 'u9', username: 'grace', displayName: 'Grace Hopper' }),
      row({ _id: 'baska', userId: 'u8', username: 'linus', displayName: 'Linus' }),
    ]);

    expect(ids((await unified({ q: 'merhaba', from: 'kullanici-kimligi-12345' })).body)).toEqual(['kimlik']);
    expect(ids((await unified({ q: 'merhaba', from: '@grace' })).body)).toEqual(['kullanici-adi']);
    expect(ids((await unified({ q: 'merhaba', from: 'hopper' })).body)).toEqual(['kullanici-adi']);
  });

  it('`has:` bağlantı, görsel ve dosya türlerini ayırır; tanınmayan tür daraltmaz', async () => {
    messages.unifiedSearch.mockResolvedValue([
      row({ _id: 'baglanti', content: 'bak: https://bridge.test/x' }),
      row({ _id: 'gorsel', fileType: 'image/png', content: 'ek' }),
      row({ _id: 'dosya', fileUrl: '/uploads/a.pdf', content: 'ek' }),
      row({ _id: 'dosya-turu', type: 'file', content: 'ek' }),
      row({ _id: 'duz', content: 'yalnız metin' }),
    ]);

    expect(ids((await unified({ q: 'merhaba', has: 'LINK' })).body)).toEqual(['baglanti']);
    expect(ids((await unified({ q: 'merhaba', has: 'image' })).body)).toEqual(['gorsel']);
    expect(ids((await unified({ q: 'merhaba', has: 'file' })).body).sort()).toEqual(['dosya', 'dosya-turu']);
    expect(ids((await unified({ q: 'merhaba', has: 'bilinmeyen' })).body)).toHaveLength(5);
  });

  it('süzgeçler yalnız daraltır: hiçbiri yeni satır ekleyemez', async () => {
    messages.unifiedSearch.mockResolvedValue([row({ _id: 'tek' })]);

    const filtered = await unified({ q: 'merhaba', from: 'ada', has: 'link', in: '#general', before: '2030-01-01' });

    expect(ids(filtered.body).length).toBeLessThanOrEqual(1);
  });
});

describe('kanal listesi sıralaması ve kapsamı', () => {
  it('kanal sonuçları ada göre kararlı sıralanır', async () => {
    messages.ftsSearch.mockResolvedValue([]);

    const res = await request(app).get('/api/search').query({ q: 'gen', type: 'channels' });

    expect(res.status).toBe(200);
    const names = (res.body.channels ?? []).map((c: { name: string }) => c.name);
    expect(names).toEqual([...names].sort());
  });

  it('tam kanal kapsamı verildiğinde yalnız o kanal listelenir', async () => {
    const res = await request(app).get('/api/search').query({ q: 'gen', type: 'channels', channelId: 'c2' });

    expect((res.body.channels ?? []).map((c: { _id: string }) => c._id)).toEqual(['c2']);
  });

  it('görünmeyen kanal kapsamı klasik aramada da boş sonuç verir', async () => {
    const res = await request(app).get('/api/search').query({ q: 'gen', channelId: 'gizli' });

    expect(res.body).toEqual({ messages: [], channels: [], members: [], hasMore: false });
    expect(messages.ftsSearch).not.toHaveBeenCalled();
  });
});

describe('bağlam ucu görünürlüğü', () => {
  it('kanal/thread bağlamında kimlik eksikse 404 döner', async () => {
    messages.searchContext.mockResolvedValue({ channelId: '', serverId: '', messages: [] });

    const res = await request(app).get('/api/search/context').query({ id: 'm1', source: 'channel' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Bağlam bulunamadı.');
  });

  it('görünmeyen kanalın bağlamı 404 ile kapatılır', async () => {
    messages.searchContext.mockResolvedValue({ channelId: 'c1', serverId: 's1', messages: [{ _id: 'm1' }] });
    getCachedPerms.mockResolvedValue(0);

    const res = await request(app).get('/api/search/context').query({ id: 'm1', source: 'channel' });

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('m1');
  });

  it('görünen kanalın bağlamı döndürülür', async () => {
    messages.searchContext.mockResolvedValue({ channelId: 'c1', serverId: 's1', messages: [{ _id: 'm1' }] });

    const res = await request(app).get('/api/search/context').query({ id: 'm1', source: 'channel' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'channel', channelId: 'c1' });
  });
});

describe('sunucu üyesi araması', () => {
  it('boş sorgu depo katmanına gitmeden boş liste döner', async () => {
    const res = await request(app).get('/api/search/servers/s1/members/search').query({ q: '   ' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(members.findByServer).not.toHaveBeenCalled();
  });

  it('üye olmayan arama yapamaz', async () => {
    members.findOne.mockResolvedValue(null);

    const res = await request(app).get('/api/search/servers/s1/members/search').query({ q: 'ada' });

    expect(res.status).toBe(403);
  });

  it('arama sırasında üyelik düşerse sonuç serileştirilmez', async () => {
    members.findByServer.mockResolvedValue([{ userId: 'u9' }]);
    users.findByIds.mockResolvedValue([{ _id: 'u9', username: 'ada', displayName: 'Ada Lovelace' }]);
    members.findOne.mockResolvedValueOnce({ userId: 'u1', serverId: 's1' }).mockResolvedValueOnce(null);

    const res = await request(app).get('/api/search/servers/s1/members/search').query({ q: 'ada' });

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('Ada Lovelace');
  });

  it('adı ya da kullanıcı adı eşleşen üyeler döner, eşleşmeyen elenir', async () => {
    members.findByServer.mockResolvedValue([{ userId: 'u9' }, { userId: 'u8' }, { userId: 'u7' }]);
    users.findByIds.mockResolvedValue([
      { _id: 'u9', username: 'ada', displayName: 'Ada Lovelace' },
      { _id: 'u8', username: 'grace', displayName: 'Grace Hopper' },
      { _id: 'u7', username: 'linus' },
    ]);

    const res = await request(app).get('/api/search/servers/s1/members/search').query({ q: 'a' });

    expect(res.status).toBe(200);
    expect(res.body.map((u: { username: string }) => u.username)).toEqual(['ada', 'grace']);
  });
});
