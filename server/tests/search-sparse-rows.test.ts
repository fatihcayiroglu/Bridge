// server/tests/search-sparse-rows.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// routes/search.ts — EKSİK SÜTUNLU SATIRLARLA FİLTRELEME
// ════════════════════════════════════════════════════════════════════════════
// Arama satırları FTS görünümlerinden gelir; `username`, `displayName`,
// `content`, `fileType`, `name` ve `attachments` sütunları NULL olabilir
// (silinmiş kullanıcı, dosya-yalnız mesaj, sistem mesajı, boş kanal adı).
//
// Bu dosya, her filtrenin eksik sütunlarda ne yaptığını ölçer. Kritik olan iki
// şey vardır:
//   1. `undefined` bir alan asla `"undefined"` metnine dönüşüp EŞLEŞMEMELİDİR
//      (aksi hâlde `from:undefined` her satırı getirirdi).
//   2. Filtreler yalnızca DARALTIR: eksik sütun bir satırı sonuç kümesine
//      EKLEYEMEZ ve yetki elemesini atlatamaz.
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

jest.mock('../db/repositories', () => ({
  Members: members, Channels: channels, Users: users, Messages: messages,
}));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => { req.user = { id: 'u1', username: 'tester' }; next(); },
}));
jest.mock('../middleware/rateLimit', () => ({
  limits: {
    search: () => (_q: any, _s: any, n: any) => n(),
    searchContext: () => (_q: any, _s: any, n: any) => n(),
  },
}));
jest.mock('../lib/permCache', () => ({ getCachedPerms: (...args: any[]) => getCachedPerms(...args) }));

import searchRouter from '../routes/search';

const app = express();
app.use(express.json());
app.use('/api/search', searchRouter);
app.use((err: any, _q: any, res: any, _n: any) => res.status(err?.status || 500).json({ error: err?.message || 'error' }));

const VIEW_CHANNELS = 1 << 0;

/** İki kanallı bir sunucu; biri isimsiz satır olarak döner. */
function baseSetup(): void {
  members.findByUser.mockResolvedValue([{ serverId: 's1' }]);
  members.findWhere.mockResolvedValue([{ userId: 'u1' }]);
  users.findWhere.mockResolvedValue([]);
  channels.findWhere.mockImplementation(async (where: any) => {
    if (where?.serverId?.$in) return [{ _id: 'c1', serverId: 's1', name: 'general' }, { _id: 'c2', serverId: 's1' }];
    return [{ _id: 'c1', name: 'general' }];
  });
  getCachedPerms.mockResolvedValue(VIEW_CHANNELS);
  messages.hasFtsSearch.mockReturnValue(true);
  messages.ftsSearch.mockResolvedValue([]);
}

beforeEach(() => {
  jest.clearAllMocks();
  baseSetup();
});

describe('channel search over rows with a missing name column', () => {
  it('never lets a nameless channel match, crash the sort, or leak into results', async () => {
    const res = await request(app).get('/api/search?q=gen');
    expect(res.status).toBe(200);
    expect(res.body.channels).toEqual([expect.objectContaining({ _id: 'c1' })]);

    // Sıralayıcı, öneki eşleşen kanalı öne alır ve isimsiz satır bu sırayı
    // bozmadan elenir.
    channels.findWhere.mockImplementation(async (where: any) => (
      where?.serverId?.$in
        ? [{ _id: 'c3', serverId: 's1' }, { _id: 'c2', serverId: 's1', name: 'ungeneral' }, { _id: 'c1', serverId: 's1', name: 'general' }]
        : []
    ));
    const all = await request(app).get('/api/search?q=gen&type=channels');
    expect(all.status).toBe(200);
    expect(all.body.channels.map((c: { _id: string }) => c._id)).toEqual(['c1', 'c2']);
  });

  it('excludes a channel whose id column is absent because it can never be proven visible', async () => {
    channels.findWhere.mockImplementation(async (where: any) => (
      where?.serverId?.$in ? [{ serverId: 's1', name: 'general' }] : []
    ));
    const res = await request(app).get('/api/search?q=gen&type=channels');
    expect(res.body.channels).toEqual([]);
  });
});

describe('message modifiers over rows with missing columns', () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    _id: 'm1', channelId: 'c1', userId: 'u9', createdAt: 100, ...overrides,
  });

  it('matches from: against absent username/displayName without producing a text match', async () => {
    messages.ftsSearch.mockResolvedValue([
      row({ _id: 'named', username: 'Ayse', displayName: 'Ayşe K' }),
      row({ _id: 'sparse' }),
    ]);
    const res = await request(app).get('/api/search?q=hi&from=ays');
    expect(res.body.messages.map((m: { _id: string }) => m._id)).toEqual(['named']);

    // `from:undefined` eksik sütunlu satırları getirmemelidir.
    const hostile = await request(app).get('/api/search?q=hi&from=undefined');
    expect(hostile.body.messages).toEqual([]);
  });

  it('treats an id-shaped from: modifier as an exact user id, not a substring', async () => {
    messages.ftsSearch.mockResolvedValue([
      row({ _id: 'exact', userId: 'user-abcdef1234' }),
      row({ _id: 'other', userId: 'user-abcdef1234-extra' }),
    ]);
    const res = await request(app).get('/api/search?q=hi&from=user-abcdef1234');
    expect(res.body.messages.map((m: { _id: string }) => m._id)).toEqual(['exact']);
  });

  it('classifies has:image from either the file type or the attachment file name', async () => {
    messages.ftsSearch.mockResolvedValue([
      row({ _id: 'by-type', fileType: 'image/png' }),
      row({ _id: 'by-name', attachments: JSON.stringify([{ name: 'shot.WEBP' }]) }),
      row({ _id: 'by-url', attachments: JSON.stringify([{ url: '/u/a.gif' }]) }),
      row({ _id: 'nameless-att', attachments: JSON.stringify([{}]) }),
      row({ _id: 'sparse' }),
    ]);
    const res = await request(app).get('/api/search?q=hi&has=image');
    expect(res.body.messages.map((m: { _id: string }) => m._id)).toEqual(['by-type', 'by-name', 'by-url']);
  });

  it('classifies has:link and has:file without dereferencing absent content', async () => {
    messages.ftsSearch.mockResolvedValue([
      row({ _id: 'link', content: 'see HTTPS://bridge.test/x' }),
      row({ _id: 'plain', content: 'no url here' }),
      row({ _id: 'sparse' }),
    ]);
    expect((await request(app).get('/api/search?q=hi&has=link')).body.messages
      .map((m: { _id: string }) => m._id)).toEqual(['link']);

    messages.ftsSearch.mockResolvedValue([
      row({ _id: 'typed', type: 'file' }),
      row({ _id: 'attached', attachments: JSON.stringify([{ url: '/u/a.pdf' }]) }),
      row({ _id: 'bad-json', attachments: '{not json' }),
      row({ _id: 'sparse' }),
    ]);
    expect((await request(app).get('/api/search?q=hi&has=file')).body.messages
      .map((m: { _id: string }) => m._id)).toEqual(['typed', 'attached']);
  });

  it('resolves in: against a channel list that contains a nameless row', async () => {
    messages.ftsSearch.mockResolvedValue([row({ _id: 'in-c1' }), row({ _id: 'in-c2', channelId: 'c2' })]);
    const res = await request(app).get('/api/search?q=hi&in=%23general');
    expect(res.body.messages.map((m: { _id: string }) => m._id)).toEqual(['in-c1']);

    // Eşleşmeyen kanal adı sonucu SIFIRA daraltır; filtreyi yok sayıp tüm
    // sonuçları döndürmek aramayı GENİŞLETİRDİ (routes/search.ts:313).
    const unknown = await request(app).get('/api/search?q=hi&in=nope');
    expect(unknown.body.messages).toHaveLength(0);
  });

  it('drops a message whose channel id column is absent instead of trusting membership', async () => {
    messages.ftsSearch.mockResolvedValue([row({ _id: 'orphan', channelId: undefined })]);
    const res = await request(app).get('/api/search?q=hi');
    expect(res.body.messages).toEqual([]);
  });

  it('reports a null channel name when the enrichment lookup has no row for the channel', async () => {
    channels.findWhere.mockImplementation(async (where: any) => (
      where?.serverId?.$in ? [{ _id: 'c1', serverId: 's1', name: 'general' }] : []
    ));
    messages.ftsSearch.mockResolvedValue([row({ _id: 'm1', content: 'hello' })]);
    const res = await request(app).get('/api/search?q=hello&type=messages');
    expect(res.body.messages[0]).toEqual(expect.objectContaining({ channelName: null, score: null }));
  });
});

describe('highlight snippet boundaries', () => {
  const row = (content: unknown) => ({ _id: 'm1', channelId: 'c1', userId: 'u9', createdAt: 1, content });

  it('escapes markup, marks matches and never renders an undefined body', async () => {
    messages.ftsSearch.mockResolvedValue([row('<script>alert("x")</script> & hello')]);
    const res = await request(app).get('/api/search?q=hello');
    const highlight = res.body.messages[0].highlight as string;
    expect(highlight).toContain('&lt;script&gt;');
    expect(highlight).toContain('&amp;');
    expect(highlight).toContain('&quot;');
    expect(highlight).toContain('<mark>hello</mark>');
    expect(highlight).not.toContain('<script>');
  });

  it('returns a bounded plain prefix when the query carries no word longer than one character', async () => {
    const long = 'x'.repeat(300);
    messages.ftsSearch.mockResolvedValue([row(long)]);
    const res = await request(app).get('/api/search?q=a%20b');
    expect(res.body.messages[0].highlight).toBe('x'.repeat(120));
  });

  it('returns an empty highlight for a row with no content at all', async () => {
    messages.ftsSearch.mockResolvedValue([row(undefined)]);
    const res = await request(app).get('/api/search?q=hello');
    expect(res.body.messages[0].highlight).toBe('');
  });

  it('adds leading and trailing ellipses only when the snippet is a middle slice', async () => {
    const body = `${'a'.repeat(200)} needle ${'b'.repeat(200)}`;
    messages.ftsSearch.mockResolvedValue([row(body)]);
    const res = await request(app).get('/api/search?q=needle');
    const highlight = res.body.messages[0].highlight as string;
    expect(highlight.startsWith('...')).toBe(true);
    expect(highlight.endsWith('...')).toBe(true);
    expect(highlight).toContain('<mark>needle</mark>');
  });
});

describe('unified search filters over sparse rows', () => {
  beforeEach(() => {
    messages.hasUnifiedSearch.mockReturnValue(true);
    messages.hasSearchContext.mockReturnValue(true);
  });

  const row = (overrides: Record<string, unknown> = {}) => ({
    _id: 'r1', _source: 'channel', channelId: 'c1', userId: 'u9', createdAt: 5, ...overrides,
  });

  it('applies from:/in:/has: without dereferencing absent columns', async () => {
    messages.unifiedSearch.mockResolvedValue([
      row({ _id: 'named', username: 'Ayse' }),
      row({ _id: 'display', displayName: 'Ayse K' }),
      row({ _id: 'sparse' }),
    ]);
    const from = await request(app).get('/api/search/unified?q=hi&from=@ays');
    expect(from.body.results.map((r: { _id: string }) => r._id)).toEqual(['named', 'display']);

    messages.unifiedSearch.mockResolvedValue([row({ _id: 'in-c1' }), row({ _id: 'sparse', channelId: undefined })]);
    const inChannel = await request(app).get('/api/search/unified?q=hi&in=general');
    expect(inChannel.body.results.map((r: { _id: string }) => r._id)).toEqual(['in-c1']);

    messages.unifiedSearch.mockResolvedValue([
      row({ _id: 'link', content: 'http://a.test' }),
      row({ _id: 'image', fileType: 'image/webp' }),
      row({ _id: 'file', fileUrl: '/u/a.pdf' }),
      row({ _id: 'typed-file', type: 'file' }),
      row({ _id: 'sparse' }),
    ]);
    expect((await request(app).get('/api/search/unified?q=hi&has=link')).body.results
      .map((r: { _id: string }) => r._id)).toEqual(['link']);
    expect((await request(app).get('/api/search/unified?q=hi&has=IMAGE')).body.results
      .map((r: { _id: string }) => r._id)).toEqual(['image']);
    expect((await request(app).get('/api/search/unified?q=hi&has=file')).body.results
      .map((r: { _id: string }) => r._id)).toEqual(['file', 'typed-file']);
    // Tanınmayan tür DARALTMAZ.
    expect((await request(app).get('/api/search/unified?q=hi&has=voice')).body.results).toHaveLength(5);
  });

  it('keeps DM rows whose channel id is absent while still filtering channel rows', async () => {
    messages.unifiedSearch.mockResolvedValue([
      row({ _id: 'dm', _source: 'dm', channelId: undefined }),
      row({ _id: 'hidden-channel', channelId: 'c9' }),
      row({ _id: 'visible-channel' }),
    ]);
    const res = await request(app).get('/api/search/unified?q=hi');
    expect(res.body.results.map((r: { _id: string }) => r._id)).toEqual(['dm', 'visible-channel']);
    expect(res.body.results[0]).toEqual(expect.objectContaining({ source: 'dm', channelName: null }));
  });
});

describe('member search over sparse user rows', () => {
  it('matches on either name column and never matches an absent one', async () => {
    members.findOne.mockResolvedValue({ userId: 'u1', serverId: 's1' });
    members.findByServer.mockResolvedValue([{ userId: 'u2' }, { userId: 'u3' }, { userId: 'u4' }]);
    users.findByIds.mockResolvedValue([
      { _id: 'u2', username: 'ayse' },
      { _id: 'u3', displayName: 'Ayşe K' },
      { _id: 'u4' },
    ]);
    const res = await request(app).get('/api/search/servers/s1/members/search?q=ay');
    expect(res.status).toBe(200);
    expect(res.body.map((u: { _id: string }) => u._id)).toEqual(['u2', 'u3']);

    const empty = await request(app).get('/api/search/servers/s1/members/search?q=undefined');
    expect(empty.body).toEqual([]);
  });
});

describe('search context ownership', () => {
  it('refuses a context row that carries no channel or server identity', async () => {
    messages.hasSearchContext.mockReturnValue(true);
    messages.searchContext.mockResolvedValue({ channelId: '', serverId: 's1', messages: [] });
    expect((await request(app).get('/api/search/context?id=m1&source=channel')).status).toBe(404);

    messages.searchContext.mockResolvedValue({ channelId: 'c1', messages: [] });
    expect((await request(app).get('/api/search/context?id=m1&source=channel')).status).toBe(404);

    messages.searchContext.mockResolvedValue({ channelId: 'c1', serverId: 's1', messages: [{ _id: 'm1' }] });
    const ok = await request(app).get('/api/search/context?id=m1&source=channel');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ source: 'channel', channelId: 'c1', messages: [{ _id: 'm1' }] });
  });
});
