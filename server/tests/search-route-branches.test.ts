process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV = 'test';

import express from 'express';
import request from 'supertest';

const members = {
  findByUser: jest.fn(),
  findWhere: jest.fn(),
  findOne: jest.fn(),
  findByServer: jest.fn(),
};
const channels = {
  findWhere: jest.fn(),
};
const users = {
  findWhere: jest.fn(),
  findByIds: jest.fn(),
};
const messages = {
  hasFtsSearch: jest.fn(),
  ftsSearch: jest.fn(),
  hasUnifiedSearch: jest.fn(),
  unifiedSearch: jest.fn(),
  hasSearchContext: jest.fn(),
  searchContext: jest.fn(),
};
const getCachedPerms = jest.fn();

jest.mock('../db/repositories', () => ({
  Members: members,
  Channels: channels,
  Users: users,
  Messages: messages,
}));

jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { id: req.headers['x-user-id'] || 'u1', username: 'tester' };
    next();
  },
}));

jest.mock('../middleware/rateLimit', () => ({
  limits: {
    search: () => (_req: any, _res: any, next: any) => next(),
    searchContext: () => (_req: any, _res: any, next: any) => next(),
  },
}));

jest.mock('../lib/permCache', () => ({ getCachedPerms: (...args: any[]) => getCachedPerms(...args) }));

// Use the real permission bit constants/hasPermission logic; only the resolver is irrelevant
// because getCachedPerms is mocked at the cache boundary.
import searchRouter from '../routes/search';

const app = express();
app.use(express.json());
app.use('/api/search', searchRouter);
app.use((err: any, _req: any, res: any, _next: any) => res.status(err?.status || 500).json({ error: err?.message || 'error' }));

const VIEW_CHANNELS = 1 << 0;

function visibleSetup() {
  members.findByUser.mockResolvedValue([{ serverId: 's1' }]);
  channels.findWhere.mockImplementation(async (where: any) => {
    if (where?.serverId?.$in) {
      return [
        { _id: 'c1', serverId: 's1', name: 'general' },
        { _id: 'c2', serverId: 's1', name: 'announcements' },
      ];
    }
    if (where?._id?.$in) {
      const ids = where._id.$in;
      return [
        { _id: 'c1', serverId: 's1', name: 'general' },
        { _id: 'c2', serverId: 's1', name: 'announcements' },
      ].filter(c => ids.includes(c._id));
    }
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
  users.findWhere.mockResolvedValue([]);
  members.findOne.mockResolvedValue({ userId: 'u1', serverId: 's1' });
  members.findByServer.mockResolvedValue([]);
  users.findByIds.mockResolvedValue([]);
}

beforeEach(() => {
  jest.clearAllMocks();
  visibleSetup();
});

describe('search route branch behavior', () => {
  test('rejects ambiguous and overlong search text before repository work', async () => {
    let res = await request(app).get('/api/search').query({ q: ['hello', 'world'] });
    expect(res.status).toBe(400);
    res = await request(app).get('/api/search').query({ q: 'x'.repeat(201) });
    expect(res.status).toBe(400);
    res = await request(app).get('/api/search/unified').query({ q: ['hello', 'world'] });
    expect(res.status).toBe(400);
    expect(messages.ftsSearch).not.toHaveBeenCalled();
    expect(messages.unifiedSearch).not.toHaveBeenCalled();
  });
  test('server filter rejects a server the caller does not belong to', async () => {
    const res = await request(app).get('/api/search?q=hello&serverId=s2');
    expect(res.status).toBe(403);
    expect(messages.ftsSearch).not.toHaveBeenCalled();
  });

  test('no memberships returns an empty result without touching search', async () => {
    members.findByUser.mockResolvedValue([]);
    const res = await request(app).get('/api/search?q=hello');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ messages: [], channels: [], members: [], hasMore: false });
    expect(messages.ftsSearch).not.toHaveBeenCalled();
  });

  test('missing FTS backend returns 503 instead of pretending there are no results', async () => {
    messages.hasFtsSearch.mockReturnValue(false);
    const res = await request(app).get('/api/search?q=hello&type=messages');
    expect(res.status).toBe(503);
  });

  test('permission lookup failure is fail-closed and duplicate channel ids are checked once', async () => {
    channels.findWhere.mockImplementation(async (where: any) => {
      if (where?.serverId?.$in) return [
        { _id: 'c1', serverId: 's1', name: 'general' },
        { _id: 'c1', serverId: 's1', name: 'duplicate' },
      ];
      return [];
    });
    getCachedPerms.mockRejectedValue(new Error('permission backend down'));
    messages.ftsSearch.mockResolvedValue([{ _id: 'm1', channelId: 'c1', content: 'hello' }]);

    const res = await request(app).get('/api/search?q=hello&type=messages');
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(getCachedPerms).toHaveBeenCalledTimes(1);
    expect(messages.ftsSearch).toHaveBeenCalledWith('hello', ['s1'], 500, []);
  });

  test('from:id, before, after and URL override modifiers narrow messages', async () => {
    const rows = [
      { _id: 'm1', channelId: 'c1', userId: 'abcdefghijk', username: 'alpha', displayName: 'Alpha', content: 'hello', createdAt: 1000 },
      { _id: 'm2', channelId: 'c1', userId: 'abcdefghijk', username: 'alpha', displayName: 'Alpha', content: 'hello', createdAt: 2000 },
      { _id: 'm3', channelId: 'c1', userId: 'other-user-123', username: 'beta', displayName: 'Beta', content: 'hello', createdAt: 1500 },
    ];
    messages.ftsSearch.mockResolvedValue(rows);

    const res = await request(app)
      .get('/api/search?q=hello%20from:ignored-user%20before:bad&from=abcdefghijk&after=1970-01-01T00:00:01.200Z&before=1970-01-01T00:00:02.500Z&type=messages');

    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: any) => m._id)).toEqual(['m2']);
  });

  test('from:name matches username/displayName case-insensitively', async () => {
    messages.ftsSearch.mockResolvedValue([
      { _id: 'm1', channelId: 'c1', username: 'Other', displayName: 'Alpha Person', content: 'hello' },
      { _id: 'm2', channelId: 'c1', username: 'BetaPerson', displayName: 'Other', content: 'hello' },
      { _id: 'm3', channelId: 'c1', username: 'Gamma', displayName: 'Gamma', content: 'hello' },
    ]);
    const res = await request(app).get('/api/search?q=hello%20from:person&type=messages');
    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: any) => m._id)).toEqual(['m1', 'm2']);
  });

  test('invalid before/after timestamps do not accidentally remove messages', async () => {
    messages.ftsSearch.mockResolvedValue([{ _id: 'm1', channelId: 'c1', content: 'hello', createdAt: 1000 }]);
    const res = await request(app).get('/api/search?q=hello%20before:not-a-date%20after:still-bad&type=messages');
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
  });

  test('has:file accepts file type and parsed attachment arrays, including malformed JSON fallback', async () => {
    messages.ftsSearch.mockResolvedValue([
      { _id: 'file', channelId: 'c1', type: 'file', attachments: null, content: 'hello' },
      { _id: 'array', channelId: 'c1', type: 'normal', attachments: [{ url: '/a' }], content: 'hello' },
      { _id: 'json', channelId: 'c1', type: 'normal', attachments: '[{"url":"/b"}]', content: 'hello' },
      { _id: 'bad', channelId: 'c1', type: 'normal', attachments: '{bad', content: 'hello' },
    ]);
    const res = await request(app).get('/api/search?q=hello%20has:file&type=messages');
    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: any) => m._id)).toEqual(['file', 'array', 'json']);
  });

  test('has:image accepts MIME and image attachment extension', async () => {
    messages.ftsSearch.mockResolvedValue([
      { _id: 'mime', channelId: 'c1', fileType: 'image/png', attachments: null, content: 'hello' },
      { _id: 'name', channelId: 'c1', fileType: 'application/octet-stream', attachments: '[{"name":"photo.WEBP"}]', content: 'hello' },
      { _id: 'url', channelId: 'c1', fileType: '', attachments: [{ url: '/x/a.jpg' }], content: 'hello' },
      { _id: 'no', channelId: 'c1', fileType: 'text/plain', attachments: [{ name: 'a.txt' }], content: 'hello' },
    ]);
    const res = await request(app).get('/api/search?q=hello%20has:image&type=messages');
    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: any) => m._id)).toEqual(['mime', 'name', 'url']);
  });

  test('has:link only returns messages containing HTTP(S) links', async () => {
    messages.ftsSearch.mockResolvedValue([
      { _id: 'yes1', channelId: 'c1', content: 'hello https://example.test/x' },
      { _id: 'yes2', channelId: 'c1', content: 'hello HTTP://EXAMPLE.TEST' },
      { _id: 'no', channelId: 'c1', content: 'hello example.test' },
    ]);
    const res = await request(app).get('/api/search?q=hello%20has:link&type=messages');
    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: any) => m._id)).toEqual(['yes1', 'yes2']);
  });

  test('in:#channel narrows to a matching visible channel; unknown channel does not invent results', async () => {
    messages.ftsSearch.mockResolvedValue([
      { _id: 'c1m', channelId: 'c1', content: 'hello' },
      { _id: 'c2m', channelId: 'c2', content: 'hello' },
    ]);
    const narrowed = await request(app).get('/api/search?q=hello%20in:%23general&type=messages');
    expect(narrowed.body.messages.map((m: any) => m._id)).toEqual(['c1m']);

    // KANONIK: bilinmeyen bir kanal adi aramayi GENISLETMEZ. Filtre yok
    // sayilsaydi kullanici, istemedigi kanallarin sonuclarini "in:#missing"
    // sorgusunun cevabi sanirdi. Daralma sifira gider (routes/search.ts:313).
    const unknown = await request(app).get('/api/search?q=hello%20in:%23missing&type=messages');
    expect(unknown.body.messages).toEqual([]);
  });

  test('pagination clamps limit, applies offset, sets hasMore and escapes/highlights snippets', async () => {
    const long = `${'x'.repeat(60)} <tag> needle & \"quote\" ${'y'.repeat(220)}`;
    messages.ftsSearch.mockResolvedValue([
      { _id: 'm1', channelId: 'c1', content: long, _score: 9 },
      { _id: 'm2', channelId: 'c1', content: 'needle second' },
      { _id: 'm3', channelId: 'c1', content: 'needle third' },
    ]);
    const res = await request(app).get('/api/search?q=needle&type=messages&limit=1&offset=1');
    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: any) => m._id)).toEqual(['m2']);
    expect(res.body.hasMore).toBe(true);

    const first = await request(app).get('/api/search?q=needle&type=messages&limit=1&offset=0');
    expect(first.status).toBe(200);
    expect(first.body.messages).toHaveLength(1);
    expect(first.body.messages[0].highlight).toContain('<mark>needle</mark>');
    expect(first.body.messages[0].highlight).toContain('&lt;tag&gt;');
    expect(first.body.messages[0].highlight).toContain('&amp;');
    expect(first.body.messages[0].highlight).toContain('&quot;quote&quot;');
    expect(first.body.messages[0].highlight.startsWith('...')).toBe(true);
    expect(first.body.messages[0].highlight.endsWith('...')).toBe(true);

    for (const query of ['limit=-3', 'limit=1.5', 'limit=10oops', 'offset=-10', 'offset=2.5', 'offset=10oops']) {
      expect((await request(app).get(`/api/search?q=needle&type=messages&${query}`)).status).toBe(400);
    }
  });

  test('channels are visibility-filtered and prefix matches sort before infix matches', async () => {
    channels.findWhere.mockImplementation(async (where: any) => {
      if (where?.serverId?.$in) return [
        { _id: 'c1', serverId: 's1', name: 'general-chat' },
        { _id: 'c2', serverId: 's1', name: 'chat-general' },
      ];
      return [];
    });
    getCachedPerms.mockImplementation(async (_u: string, _s: string, _r: any, c: string) => c === 'c2' ? VIEW_CHANNELS : VIEW_CHANNELS);
    const res = await request(app).get('/api/search?q=general&type=channels');
    expect(res.status).toBe(200);
    expect(res.body.channels.map((c: any) => c.name)).toEqual(['general-chat', 'chat-general']);
  });

  test('user search builds a deduplicated member scope, sanitizes and caps at 15', async () => {
    members.findWhere.mockResolvedValue([{ userId: 'x' }, { userId: 'x' }, { userId: 'y' }]);
    users.findWhere.mockResolvedValue(Array.from({ length: 20 }, (_, i) => ({
      _id: `u${i}`, username: `user${i}`, displayName: `User ${i}`, passwordHash: 'secret', tokenVersion: 3,
    })));
    const res = await request(app).get('/api/search?q=user&type=users');
    expect(res.status).toBe(200);
    expect(users.findWhere).toHaveBeenCalledWith(expect.objectContaining({ _id: { $in: ['x', 'y'] } }));
    expect(res.body.members).toHaveLength(15);
    expect(res.body.members[0].passwordHash).toBeUndefined();
  });
});

describe('unified search exact channel scope', () => {
  test('channelId scopes by exact visible id even when another visible channel has the same name', async () => {
    channels.findWhere.mockImplementation(async (where: any) => {
      if (where?.serverId?.$in) {
        return [
          { _id: 'c1', serverId: 's1', name: 'general' },
          { _id: 'c2', serverId: 's1', name: 'general' },
        ];
      }
      if (where?._id?.$in) {
        const ids = where._id.$in;
        return [
          { _id: 'c1', serverId: 's1', name: 'general' },
          { _id: 'c2', serverId: 's1', name: 'general' },
        ].filter(c => ids.includes(c._id));
      }
      return [];
    });
    messages.unifiedSearch.mockResolvedValue([
      { _id: 'm1', _source: 'channel', channelId: 'c1', serverId: 's1', content: 'hello' },
      { _id: 'm2', _source: 'channel', channelId: 'c2', serverId: 's1', content: 'hello' },
      { _id: 'dm1', _source: 'dm', dmId: 'd1', content: 'hello' },
    ]);

    const res = await request(app).get('/api/search/unified?q=hello&channelId=c1');
    expect(res.status).toBe(200);
    expect(res.body.results.map((row: any) => row._id)).toEqual(['m1']);
    expect(messages.unifiedSearch).toHaveBeenCalledWith(
      'hello',
      expect.objectContaining({ channelIds: ['c1'] }),
      200,
    );
  });

  test('non-visible exact channel scope is empty without repository search or existence disclosure', async () => {
    messages.unifiedSearch.mockClear();
    const res = await request(app).get('/api/search/unified?q=hello&channelId=not-visible');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [], hasMore: false });
    expect(messages.unifiedSearch).not.toHaveBeenCalled();
  });

  test('ambiguous or overlong exact channel scope is rejected before repository search', async () => {
    let res = await request(app).get('/api/search/unified').query({ q: 'hello', channelId: ['c1', 'c2'] });
    expect(res.status).toBe(400);
    res = await request(app).get('/api/search/unified').query({ q: 'hello', channelId: 'x'.repeat(129) });
    expect(res.status).toBe(400);
    expect(messages.unifiedSearch).not.toHaveBeenCalled();
  });
});

describe('unified search filtering branches', () => {
  const baseRows = [
    { _id: 'ch', _source: 'channel', channelId: 'c1', serverId: 's1', userId: 'u2', username: 'Alice', displayName: 'Alice A', content: 'hello https://x.test', fileType: 'image/png', fileUrl: '/f' },
    { _id: 'dm', _source: 'dm', userId: 'u3', username: 'Bob', displayName: 'Bob B', content: 'hello plain', type: 'file', fileUrl: '/dm' },
  ];

  beforeEach(() => messages.unifiedSearch.mockResolvedValue(baseRows));

  test('mixed source allowlist keeps valid sources and ignores invalid tokens', async () => {
    const res = await request(app).get('/api/search/unified?q=hello&sources=dm,bogus');
    expect(res.status).toBe(200);
    expect(messages.unifiedSearch).toHaveBeenCalledWith('hello', expect.objectContaining({ sources: ['dm'] }), 200);
  });

  test('URL from/has/in modifiers override inline modifiers and narrow results', async () => {
    const res = await request(app).get('/api/search/unified?q=hello%20from:Bob%20has:file%20in:%23nope&from=Alice&has=image&in=general');
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: any) => r._id)).toEqual(['ch']);
  });

  test('unified from matches userId exactly as well as username/displayName', async () => {
    const byId = await request(app).get('/api/search/unified?q=hello%20from:u3');
    expect(byId.body.results.map((r: any) => r._id)).toEqual(['dm']);

    const byName = await request(app).get('/api/search/unified?q=hello%20from:bob');
    expect(byName.body.results.map((r: any) => r._id)).toEqual(['dm']);
  });

  test('unified has:file/link/image and unknown kind behavior are deterministic', async () => {
    const image = await request(app).get('/api/search/unified?q=hello%20has:image');
    expect(image.body.results.map((r: any) => r._id)).toEqual(['ch']);
    const link = await request(app).get('/api/search/unified?q=hello%20has:link');
    expect(link.body.results.map((r: any) => r._id)).toEqual(['ch']);
    const file = await request(app).get('/api/search/unified?q=hello%20has:file');
    expect(file.body.results.map((r: any) => r._id)).toEqual(['ch', 'dm']);
    const unknown = await request(app).get('/api/search/unified?q=hello%20has:weird');
    expect(unknown.body.results.map((r: any) => r._id)).toEqual(['ch', 'dm']);
  });

  test('unified in filter compares channel names and leaves DMs out', async () => {
    const res = await request(app).get('/api/search/unified?q=hello%20in:%23general');
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: any) => r._id)).toEqual(['ch']);
  });

  test('unified rejects malformed limit values instead of coercing them', async () => {
    for (const limit of ['-1', '1.5', '10oops', '9007199254740992']) {
      expect((await request(app).get(`/api/search/unified?q=hello&limit=${limit}`)).status).toBe(400);
    }
  });

  test('unified pagination hasMore is computed after authorization and filtering', async () => {
    messages.unifiedSearch.mockResolvedValue([
      ...baseRows,
      { _id: 'dm2', _source: 'dm', userId: 'u4', username: 'C', content: 'hello' },
    ]);
    const res = await request(app).get('/api/search/unified?q=hello&limit=2');
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.hasMore).toBe(true);
  });
});

describe('search context and member search branches', () => {
  test('context and member search reject non-scalar or overlong identifiers and text', async () => {
    expect((await request(app).get('/api/search/context').query({ id: ['m1', 'm2'], source: 'channel' })).status).toBe(400);
    expect((await request(app).get('/api/search/context').query({ id: 'x'.repeat(129), source: 'channel' })).status).toBe(400);
    expect((await request(app).get('/api/search/servers/s1/members/search').query({ q: ['ali', 'bob'] })).status).toBe(400);
    expect((await request(app).get('/api/search/servers/s1/members/search').query({ q: 'x'.repeat(201) })).status).toBe(400);
    expect(messages.searchContext).not.toHaveBeenCalled();
    expect(users.findByIds).not.toHaveBeenCalled();
  });

  test('context validates id/source/backend/not-found', async () => {
    expect((await request(app).get('/api/search/context?source=channel')).status).toBe(400);
    expect((await request(app).get('/api/search/context?id=m1&source=bad')).status).toBe(400);

    messages.hasSearchContext.mockReturnValue(false);
    expect((await request(app).get('/api/search/context?id=m1&source=channel')).status).toBe(503);

    messages.hasSearchContext.mockReturnValue(true);
    messages.searchContext.mockResolvedValue(null);
    expect((await request(app).get('/api/search/context?id=m1&source=channel')).status).toBe(404);
  });

  test('channel context requires canonical channel+server and current visibility', async () => {
    messages.searchContext.mockResolvedValue({ channelId: '', serverId: '', messages: [] });
    expect((await request(app).get('/api/search/context?id=m1&source=channel')).status).toBe(404);

    messages.searchContext.mockResolvedValue({ channelId: 'c1', serverId: 's1', messages: [{ _id: 'm1' }] });
    getCachedPerms.mockResolvedValue(0);
    expect((await request(app).get('/api/search/context?id=m1&source=channel')).status).toBe(404);

    getCachedPerms.mockResolvedValue(VIEW_CHANNELS);
    const ok = await request(app).get('/api/search/context?id=m1&source=thread&radius=4');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ source: 'thread', channelId: 'c1', messages: [{ _id: 'm1' }] });
    expect(messages.searchContext).toHaveBeenCalledWith('m1', 'thread', { userId: 'u1', serverIds: ['s1'] }, 4);
  });

  test('DM context does not require channel permission', async () => {
    messages.searchContext.mockResolvedValue({ channelId: null, serverId: null, messages: [{ _id: 'dm1' }] });
    getCachedPerms.mockRejectedValue(new Error('should not be called'));
    const res = await request(app).get('/api/search/context?id=dm1&source=dm');
    expect(res.status).toBe(200);
    expect(getCachedPerms).not.toHaveBeenCalled();
  });

  test('member search handles empty query, non-member and caps sanitized results at eight', async () => {
    const empty = await request(app).get('/api/search/servers/s1/members/search?q=');
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);

    members.findOne.mockResolvedValue(null);
    expect((await request(app).get('/api/search/servers/s1/members/search?q=ali')).status).toBe(403);

    members.findOne.mockResolvedValue({ userId: 'u1', serverId: 's1' });
    members.findByServer.mockResolvedValue(Array.from({ length: 12 }, (_, i) => ({ userId: `u${i}` })));
    users.findByIds.mockResolvedValue(Array.from({ length: 12 }, (_, i) => ({
      _id: `u${i}`,
      username: i % 2 ? `other${i}` : `alice${i}`,
      displayName: i % 2 ? `Alice Display ${i}` : `Other ${i}`,
      passwordHash: 'secret',
    })));
    const res = await request(app).get('/api/search/servers/s1/members/search?q=ALICE');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(8);
    expect(res.body.every((u: any) => u.passwordHash === undefined)).toBe(true);
  });

  test('member search revalidates membership before returning another users data', async () => {
    members.findOne
      .mockResolvedValueOnce({ userId: 'u1', serverId: 's1' })
      .mockResolvedValueOnce(null);
    members.findByServer.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
    users.findByIds.mockResolvedValue([
      { _id: 'u1', username: 'alice', displayName: 'Alice' },
      { _id: 'u2', username: 'alicia', displayName: 'Alicia' },
    ]);
    const res = await request(app).get('/api/search/servers/s1/members/search?q=ali');
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('Alicia');
  });
});
