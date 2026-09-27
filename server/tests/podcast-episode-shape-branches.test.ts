// server/tests/podcast-episode-shape-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// PODCAST BÖLÜMLERİ — SIRALAMA, YAYIN BAYRAĞI VE BESLEME KAÇIŞI
// ════════════════════════════════════════════════════════════════════════════
//
// Kardeş dosyalar kayıt yaşam döngüsünü ve küme sahipliğini ölçer. Bu
// tamamlayıcı takım YAYINLANAN çıktıyı ölçer:
//
//   · SIRALAMA. Bölüm listesi ve RSS/JSON beslemesi yayın tarihine göre
//     sıralanır. Tarihi olmayan bir bölüm sıralamayı BOZMAMALIDIR: `undefined`
//     karşılaştırması sırayı kararsız yapar ve okuyucular bölümleri karışık
//     görür.
//   · YAYIN BAYRAĞI kesin bir boolean sözleşmesidir. Belirsiz bir değer
//     sessizce "yayınla" anlamına GELMEZ; istek reddedilir.
//   · BESLEME KAÇIŞI. RSS bir XML belgesidir ve bölüm başlıkları kullanıcı
//     içeriğidir. `]]>` dizisi CDATA'yı kapatıp beslemeye rastgele biçim
//     enjekte etmeye izin verirdi.

'use strict';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'podcast-shape-test-secretxxxxxxx';
process.env.RECORDINGS_DIR = '/tmp/bridge-podcast-shape-tests';
process.env.INSTANCE_ID = 'node-A';

import fs from 'fs';

const mockResolvePermissions = jest.fn();
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    const id = req.headers['x-test-user'];
    if (!id) return res.status(401).json({ error: 'Unauthorized' });
    req.user = { id: String(id), username: String(id) };
    return next();
  },
  verifyToken: (token: string) => (token ? { id: token } : null),
}));
jest.mock('../lib/permissions', () => ({
  PERMS: { MANAGE_CHANNELS: 1, MANAGE_SERVER: 2 },
  hasPermission: (p: number, b: number) => (p & b) !== 0,
  resolvePermissions: (...args: unknown[]) => mockResolvePermissions(...args),
}));
jest.mock('../lib/uploadReferenceSafety', () => ({ hasLiveUploadReference: jest.fn(async () => false) }));
jest.mock('../lib/ssrfGuard', () => ({ assertUrlIsPublic: jest.fn(async () => undefined) }));
jest.mock('../lib/redisAdapter', () => ({
  cache: {
    getAuthoritative: jest.fn(async () => null),
    setAuthoritative: jest.fn(async () => undefined),
    delAuthoritative: jest.fn(async () => undefined),
    withKeyLock: jest.fn(async (_k: string, fn: () => unknown) => fn()),
  },
}));
jest.mock('../lib/logger', () => ({ __esModule: true, default: mockLogger }));
jest.mock('child_process', () => ({ spawn: jest.fn(() => { throw new Error('not used'); }) }));

import express from 'express';
import request from 'supertest';
import router from '../routes/podcast';
const db: any = require('../db/loader');

function app() {
  const a = express();
  a.use(express.json({ limit: '5mb' }));
  a.use('/api/podcast', router);
  a.use((e: any, _req: any, res: any, _next: any) => res.status(e.status || 500).json({ error: e.message }));
  return a;
}

let seq = 0;
let channelId: string;
let serverId: string;
let userId: string;

beforeAll(() => {
  fs.rmSync(process.env.RECORDINGS_DIR!, { recursive: true, force: true });
  fs.mkdirSync(process.env.RECORDINGS_DIR!, { recursive: true });
});
afterAll(() => fs.rmSync(process.env.RECORDINGS_DIR!, { recursive: true, force: true }));

beforeEach(async () => {
  db._reset?.();
  jest.clearAllMocks();
  seq += 1;
  channelId = `pod-shape-${seq}`;
  serverId = `pod-shape-server-${seq}`;
  userId = `pod-shape-user-${seq}`;
  await db.users.insert({ _id: userId, username: userId, displayName: userId, isAdmin: false });
  await db.servers.insert({ _id: serverId, name: 'Shape', ownerId: 'someone-else' });
  await db.channels.insert({ _id: channelId, serverId, name: 'Stage', type: 'stage' });
  mockResolvePermissions.mockResolvedValue(1);
});

async function seedEpisode(overrides: Record<string, unknown> = {}) {
  const episode = {
    _id: `ep-${Math.random().toString(36).slice(2)}`,
    channelId, serverId, title: 'Bölüm', description: '',
    audioUrl: 'https://cdn.test/a.mp3', mimeType: 'audio/mpeg',
    fileSize: 1024, durationSeconds: 60, published: true,
    publishedAt: Date.now(), createdBy: userId, createdAt: Date.now(),
    ...overrides,
  };
  await db.podcastEpisodes.insert(episode);
  return episode;
}

const authed = (method: 'get' | 'post' | 'patch' | 'delete', url: string) =>
  request(app())[method](url).set('x-test-user', userId);

describe('episodes with no publish date do not destabilise the ordering', () => {
  it('the episode list keeps dated episodes newest-first and never drops undated ones', async () => {
    await seedEpisode({ _id: 'ep-old', title: 'Eski', publishedAt: 1_000 });
    await seedEpisode({ _id: 'ep-undated', title: 'Tarihsiz', publishedAt: undefined });
    await seedEpisode({ _id: 'ep-new', title: 'Yeni', publishedAt: 9_000 });

    const res = await authed('get', `/api/podcast/${channelId}/episodes`);

    expect(res.status).toBe(200);
    const ids = res.body.episodes.map((e: { _id: string }) => e._id);
    expect(ids).toHaveLength(3);
    expect(ids.indexOf('ep-new')).toBeLessThan(ids.indexOf('ep-old'));
    expect(ids).toContain('ep-undated');
  });

  it('the RSS feed applies the same ordering rule', async () => {
    await seedEpisode({ title: 'Eski', publishedAt: 1_000 });
    await seedEpisode({ title: 'Tarihsiz', publishedAt: null });
    await seedEpisode({ title: 'Yeni', publishedAt: 9_000 });

    const res = await request(app()).get(`/api/podcast/${channelId}/rss`);

    expect(res.status).toBe(200);
    expect(res.text.indexOf('Yeni')).toBeLessThan(res.text.indexOf('Eski'));
    expect(res.text).toContain('Tarihsiz');
  });

  it('the JSON feed applies the same ordering rule', async () => {
    await seedEpisode({ _id: 'j-old', title: 'Eski', publishedAt: 1_000 });
    await seedEpisode({ _id: 'j-undated', title: 'Tarihsiz', publishedAt: undefined });
    await seedEpisode({ _id: 'j-new', title: 'Yeni', publishedAt: 9_000 });

    const res = await request(app()).get(`/api/podcast/${channelId}/feed.json`);

    expect(res.status).toBe(200);
    const titles = res.body.items.map((i: { title: string }) => i.title);
    expect(titles.indexOf('Yeni')).toBeLessThan(titles.indexOf('Eski'));
    expect(titles).toHaveLength(3);
  });

  it('an unknown channel has no feed at all', async () => {
    expect((await request(app()).get('/api/podcast/nope/rss')).status).toBe(404);
    expect((await request(app()).get('/api/podcast/nope/feed.json')).status).toBe(404);
  });
});

describe('the RSS feed escapes user-authored text', () => {
  it('a title that tries to close the CDATA section is neutralised', async () => {
    await seedEpisode({ title: 'Kapat]]><script>alert(1)</script>', publishedAt: 5_000 });

    const res = await request(app()).get(`/api/podcast/${channelId}/rss`);

    expect(res.status).toBe(200);
    // The raw closing sequence must not survive into the document.
    expect(res.text).not.toContain(']]><script>');
    expect(res.text).toContain(']]]]><![CDATA[>');
  });

  it('a channel with no configured podcast title falls back to the channel name', async () => {
    await seedEpisode({ publishedAt: 1 });
    const res = await request(app()).get(`/api/podcast/${channelId}/rss`);
    expect(res.text).toContain('Stage');
  });
});

describe('publishing an episode', () => {
  const create = (body: Record<string, unknown>) =>
    authed('post', `/api/podcast/${channelId}/episodes`).send(body);

  const base = { title: 'Yeni Bölüm', audioUrl: 'https://cdn.test/a.mp3', mimeType: 'audio/mpeg' };

  it('defaults to published when the flag is omitted', async () => {
    const res = await create(base);
    expect(res.status).toBe(201);
    expect(res.body.episode.published).toBe(true);
    expect(res.body.episode.serverId).toBe(serverId);
  });

  const acceptedFlags: Array<[unknown, boolean]> = [
    [true, true], ['true', true], [1, true], ['1', true],
    [false, false], ['false', false], [0, false], ['0', false],
    ['', true], [null, true],
  ];
  for (const [value, expected] of acceptedFlags) {
    it(`reads published=${JSON.stringify(value)} as ${expected}`, async () => {
      const res = await create({ ...base, published: value });
      expect(res.status).toBe(201);
      expect(res.body.episode.published).toBe(expected);
    });
  }

  const rejectedFlags = ['yes', 'no', 2, {}, []];
  for (const value of rejectedFlags) {
    it(`refuses an ambiguous published=${JSON.stringify(value)}`, async () => {
      const res = await create({ ...base, published: value });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/published must be a boolean/);
    });
  }

  it('an explicitly null duration is stored as unknown, not as zero', async () => {
    const res = await create({ ...base, durationSeconds: null });
    expect(res.status).toBe(201);
    expect(res.body.episode.durationSeconds).toBeNull();
  });

  it('an omitted duration is also stored as unknown', async () => {
    const res = await create(base);
    expect(res.body.episode.durationSeconds).toBeNull();
  });

  it('a given duration is stored as the parsed integer', async () => {
    const res = await create({ ...base, durationSeconds: 125 });
    expect(res.body.episode.durationSeconds).toBe(125);
  });

  const badNumbers: Array<[string, Record<string, unknown>]> = [
    ['a negative duration', { durationSeconds: -1 }],
    ['a fractional duration', { durationSeconds: 1.5 }],
    ['a negative file size', { fileSize: -1 }],
    ['a non-numeric season', { season: 'first' }],
    ['a non-numeric episode number', { episode: 'one' }],
  ];
  for (const [name, extra] of badNumbers) {
    it(`refuses ${name}`, async () => {
      const res = await create({ ...base, ...extra });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/non-negative safe integers/);
    });
  }

  it('null season and episode numbers are accepted as "not part of a series"', async () => {
    const res = await create({ ...base, season: null, episode: null });
    expect(res.status).toBe(201);
    expect(res.body.episode.season).toBeNull();
    expect(res.body.episode.episode ?? null).toBeNull();
  });

  const missingSource: Array<[string, Record<string, unknown>]> = [
    ['neither a filename nor an audio url', { title: 'X', mimeType: 'audio/mpeg' }],
    ['a non-string filename', { title: 'X', mimeType: 'audio/mpeg', filename: 5 }],
    ['a non-string audio url', { title: 'X', mimeType: 'audio/mpeg', audioUrl: 5 }],
    ['a blank mime type', { title: 'X', audioUrl: 'https://cdn.test/a.mp3', mimeType: '  ' }],
  ];
  for (const [name, body] of missingSource) {
    it(`refuses an episode with ${name}`, async () => {
      const res = await create(body);
      expect(res.status).toBe(400);
    });
  }
});

describe('draft visibility', () => {
  it('an anonymous reader never sees unpublished episodes', async () => {
    await seedEpisode({ _id: 'draft', title: 'Taslak', published: false });
    await seedEpisode({ _id: 'live', title: 'Yayında', published: true });

    const res = await request(app()).get(`/api/podcast/${channelId}/episodes?published=all`);

    expect(res.status).toBe(200);
    expect(res.body.episodes.map((e: { _id: string }) => e._id)).toEqual(['live']);
  });

  it('a channel manager may ask for drafts explicitly', async () => {
    await seedEpisode({ _id: 'draft', title: 'Taslak', published: false });
    await seedEpisode({ _id: 'live', title: 'Yayında', published: true });

    const res = await request(app()).get(`/api/podcast/${channelId}/episodes?published=all`)
      .set('Authorization', `Bearer ${userId}`);

    expect(res.status).toBe(200);
    expect(res.body.episodes.map((e: { _id: string }) => e._id).sort()).toEqual(['draft', 'live']);
  });

  it('a token for a user with no channel rights still only sees published episodes', async () => {
    mockResolvePermissions.mockResolvedValue(0);
    await seedEpisode({ _id: 'draft', title: 'Taslak', published: false });
    await seedEpisode({ _id: 'live', title: 'Yayında', published: true });

    const res = await request(app()).get(`/api/podcast/${channelId}/episodes?published=all`)
      .set('Authorization', `Bearer ${userId}`);

    expect(res.body.episodes.map((e: { _id: string }) => e._id)).toEqual(['live']);
  });
});
