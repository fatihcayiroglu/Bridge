// server/tests/server-profile-slug-and-public-page-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// SUNUCU PROFİLİ — SLUG DOĞRULAMA VE KAMUYA AÇIK SAYFA
// ════════════════════════════════════════════════════════════════════════════
//
// `/s/:slug` KİMLİK DOĞRULAMASIZ bir sayfadır: hesabı olmayan herkes görür.
// Bu yüzden burada ölçülen iki şey de doğrudan gizlilik/bütünlük sınırıdır:
//
//   · SLUG. Kabul edilen her slug kalıcı bir genel adres olur. Uzunluk,
//     karakter kümesi ve rezerve isim denetimleri ATOMİK sahiplik/entitlement
//     çağrısından ÖNCE gelmeli; sonuç kodları (bulunamadı / sahibi değil /
//     boost gerekli / çakışma) çağırana AYRIŞTIRILMIŞ olarak dönmelidir.
//   · KANAL LİSTESİ. Yalnız @everyone için GÖRÜNÜR kanallar yayınlanır ve
//     override deposu okunamıyorsa kanal GİZLİ sayılır (fail-closed). Aksi
//     hâlde bir sunucu vanity URL açtığında özel kanal adları da internete
//     açılırdı.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV = 'test';
process.env.INSTANCE_URL = 'http://localhost:3001';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

const boosts = { mutateVanityAtomic: jest.fn(), getLiveVanityServer: jest.fn() };
jest.mock('../db/repositories/BoostRepository.js', () => ({ Boosts: boosts }));

const isUserOnline = jest.fn();
jest.mock('../lib/presenceCache', () => ({ isUserOnline: (...a: unknown[]) => isUserOnline(...a) }));

const findOverridesByChannel = jest.fn();
const findWhere = jest.fn();
const findByServer = jest.fn();

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { authMiddleware } from '../middleware/auth';

const db: any = require('../db/loader');
const { Channels, Members } = require('../db/repositories');
const profileRouter = require('../routes/serverProfile');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers', authMiddleware, profileRouter);
  app.use('/s', profileRouter);
  return app;
}
const tok = (uid: string) => jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });

let app: express.Express;
let ownerId: string;
let serverId: string;
let ownerToken: string;
let channelsSpy: jest.SpyInstance;
let overridesSpy: jest.SpyInstance;
let membersSpy: jest.SpyInstance;

beforeEach(async () => {
  db._reset?.();
  jest.clearAllMocks();
  app = buildApp();
  ownerId = uuidv4();
  serverId = uuidv4();
  ownerToken = tok(ownerId);

  await db.users.insert({ _id: ownerId, username: 'owner', displayName: 'Owner', tokenVersion: 0 });
  await db.servers.insert({ _id: serverId, name: 'Bridge Gaming', ownerId, icon: '🎮' });

  boosts.mutateVanityAtomic.mockResolvedValue('ok');
  boosts.getLiveVanityServer.mockResolvedValue(null);
  isUserOnline.mockResolvedValue(false);
  findWhere.mockResolvedValue([]);
  findOverridesByChannel.mockResolvedValue([]);
  findByServer.mockResolvedValue([]);

  channelsSpy = jest.spyOn(Channels, 'findWhere').mockImplementation((...a: unknown[]) => findWhere(...a));
  overridesSpy = jest.spyOn(Channels, 'findOverridesByChannel').mockImplementation((...a: unknown[]) => findOverridesByChannel(...a));
  membersSpy = jest.spyOn(Members, 'findByServer').mockImplementation((...a: unknown[]) => findByServer(...a));
});

afterEach(() => {
  channelsSpy.mockRestore();
  overridesSpy.mockRestore();
  membersSpy.mockRestore();
});

function putSlug(slug: unknown, sid = serverId, token = ownerToken) {
  return request(app).put(`/api/servers/${sid}/slug`)
    .set('Authorization', `Bearer ${token}`).send({ slug });
}

describe('slug validation happens before the atomic ownership write', () => {
  const rejected: Array<[string, unknown, RegExp]> = [
    ['a single character', 'a', /en az 2 karakter/],
    ['two characters', 'ab', /3–32 karakter/],
    ['thirty-three characters', 'a'.repeat(33), /3–32 karakter/],
    ['a reserved word', 'admin', /rezerve/],
    ['another reserved word', 'discover', /rezerve/],
  ];

  for (const [name, slug, message] of rejected) {
    it(`refuses ${name}`, async () => {
      const res = await putSlug(slug);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(message);
      expect(boosts.mutateVanityAtomic).not.toHaveBeenCalled();
    });
  }

  it('normalises Turkish characters and accepts the result', async () => {
    const res = await putSlug('Şahane Gündüz');
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe('sahane-gunduz');
    expect(boosts.mutateVanityAtomic).toHaveBeenCalledWith(serverId, ownerId, 'sahane-gunduz');
  });

  it('an empty slug is derived from the server name', async () => {
    const res = await putSlug('');
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe('bridge-gaming');
  });

  it('a server with no name at all yields the literal fallback, not a 500', async () => {
    // `slugify` ends in `|| 'server'`, so a nameless server gets that literal
    // rather than crashing on `undefined.toLowerCase()`. (The comment beside
    // the call still describes the older "falls to a 400" behaviour.)
    const nameless = uuidv4();
    await db.servers.insert({ _id: nameless, ownerId });
    const res = await putSlug('', nameless);
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe('server');
  });

  it('a name made only of punctuation falls back to the literal "server"', async () => {
    const punctuation = uuidv4();
    await db.servers.insert({ _id: punctuation, name: '!!! ???', ownerId });
    const res = await putSlug('', punctuation);
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe('server');
  });

  it('an unknown server is a 404 on both slug endpoints', async () => {
    const missing = uuidv4();
    await expect(putSlug('valid-slug', missing)).resolves.toMatchObject({ status: 404 });
    const read = await request(app).get(`/api/servers/${missing}/slug`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(read.status).toBe(404);
    expect(boosts.mutateVanityAtomic).not.toHaveBeenCalled();
  });

  it('a non-owner is refused before the atomic write', async () => {
    const strangerId = uuidv4();
    await db.users.insert({ _id: strangerId, username: 'stranger', tokenVersion: 0 });
    const res = await putSlug('valid-slug', serverId, tok(strangerId));
    expect(res.status).toBe(403);
    expect(boosts.mutateVanityAtomic).not.toHaveBeenCalled();
  });

  const outcomes: Array<[string, string, number, RegExp]> = [
    ['a server deleted mid-request', 'not_found', 404, /Not found/],
    ['ownership lost mid-request', 'forbidden', 403, /Sadece sunucu sahibi/],
    ['a missing boost entitlement', 'boost_required', 403, /Boost Level 3/],
    ['a slug already taken', 'conflict', 409, /kullanımda/],
  ];
  for (const [name, result, status, message] of outcomes) {
    it(`reports ${name} distinctly`, async () => {
      boosts.mutateVanityAtomic.mockResolvedValue(result);
      const res = await putSlug('valid-slug');
      expect(res.status).toBe(status);
      expect(res.body.error).toMatch(message);
    });
  }

  it('reads back the stored vanity column under the public field name', async () => {
    await db.servers.update({ _id: serverId }, { $set: { vanityUrl: 'stored-slug' } });
    const res = await request(app).get(`/api/servers/${serverId}/slug`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ slug: 'stored-slug' });
  });
});

describe('the public vanity page', () => {
  const server = () => ({
    _id: serverId, name: 'Bridge Gaming', icon: '🎮',
    description: 'Oyun topluluğu', vanityUrl: 'gaming',
  });

  it('a slug that normalises to nothing is refused', async () => {
    const res = await request(app).get('/s/!!!');
    expect(res.status).toBe(400);
    expect(boosts.getLiveVanityServer).not.toHaveBeenCalled();
  });

  it('an expired or unknown vanity renders the not-found page, not a 500', async () => {
    boosts.getLiveVanityServer.mockResolvedValue(null);
    const res = await request(app).get('/s/gaming');
    expect(res.status).toBe(404);
    expect(res.text).toContain('Sunucu bulunamadı');
  });

  it('publishes only channels @everyone may view', async () => {
    boosts.getLiveVanityServer.mockResolvedValue(server());
    findWhere.mockResolvedValue([
      { _id: 'c-public', name: 'genel', topic: 'Herkese açık' },
      { _id: 'c-private', name: 'gizli-yonetim' },
    ]);
    findOverridesByChannel.mockImplementation(async (channelId: string) => (
      channelId === 'c-private' ? [{ targetType: 'everyone', deny: 1 }] : []
    ));

    const res = await request(app).get('/s/gaming');

    expect(res.status).toBe(200);
    expect(res.text).toContain('genel');
    expect(res.text).toContain('Herkese açık');
    expect(res.text).not.toContain('gizli-yonetim');
  });

  it('an override row with no deny mask does not hide a channel', async () => {
    boosts.getLiveVanityServer.mockResolvedValue(server());
    findWhere.mockResolvedValue([{ _id: 'c1', name: 'duyurular' }]);
    findOverridesByChannel.mockResolvedValue([{ targetType: 'everyone' }]);

    const res = await request(app).get('/s/gaming');
    expect(res.text).toContain('duyurular');
  });

  it('a role override does not hide a channel from the public list', async () => {
    boosts.getLiveVanityServer.mockResolvedValue(server());
    findWhere.mockResolvedValue([{ _id: 'c1', name: 'duyurular' }]);
    findOverridesByChannel.mockResolvedValue([{ targetType: 'role', deny: 1 }]);

    const res = await request(app).get('/s/gaming');
    expect(res.text).toContain('duyurular');
  });

  it('a channel whose overrides cannot be read is treated as private', async () => {
    boosts.getLiveVanityServer.mockResolvedValue(server());
    findWhere.mockResolvedValue([{ _id: 'c1', name: 'belirsiz-kanal' }]);
    findOverridesByChannel.mockRejectedValue(new Error('override store offline'));

    const res = await request(app).get('/s/gaming');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('belirsiz-kanal');
  });

  it('at most eight channels are published however many are visible', async () => {
    boosts.getLiveVanityServer.mockResolvedValue(server());
    findWhere.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => ({ _id: `c${i}`, name: `kanal-${i}` })));

    const res = await request(app).get('/s/gaming');

    expect(res.status).toBe(200);
    for (let i = 0; i < 8; i += 1) expect(res.text).toContain(`kanal-${i}`);
    expect(res.text).not.toContain('kanal-8');
    // The loop stops early rather than resolving overrides for every channel.
    expect(findOverridesByChannel).toHaveBeenCalledTimes(8);
  });

  it('a non-string topic is dropped rather than rendered as an object', async () => {
    boosts.getLiveVanityServer.mockResolvedValue(server());
    findWhere.mockResolvedValue([{ _id: 'c1', name: 'kanal', topic: { nope: true } }]);
    const res = await request(app).get('/s/gaming');
    expect(res.text).toContain('kanal');
    expect(res.text).not.toContain('[object Object]');
  });

  it('a channel listing failure still renders the page', async () => {
    boosts.getLiveVanityServer.mockResolvedValue(server());
    findWhere.mockRejectedValue(new Error('channel store offline'));
    const res = await request(app).get('/s/gaming');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Bridge Gaming');
  });

  it('counts only members the presence cache reports as online', async () => {
    boosts.getLiveVanityServer.mockResolvedValue(server());
    findByServer.mockResolvedValue([{ userId: 'a' }, { userId: 'b' }, { userId: 'c' }]);
    isUserOnline.mockImplementation(async (userId: string) => userId !== 'c');

    const res = await request(app).get('/s/gaming');

    expect(res.status).toBe(200);
    expect(isUserOnline).toHaveBeenCalledTimes(3);
    expect(res.text).toContain('3');
  });

  it('a presence outage does not take the page down', async () => {
    boosts.getLiveVanityServer.mockResolvedValue(server());
    findByServer.mockResolvedValue([{ userId: 'a' }]);
    isUserOnline.mockRejectedValue(new Error('presence offline'));
    const res = await request(app).get('/s/gaming');
    expect(res.status).toBe(200);
  });

  it('a member listing failure does not take the page down', async () => {
    boosts.getLiveVanityServer.mockResolvedValue(server());
    findByServer.mockRejectedValue(new Error('member store offline'));
    const res = await request(app).get('/s/gaming');
    expect(res.status).toBe(200);
  });

  const tagShapes: Array<[string, unknown, string[]]> = [
    ['a JSON string', '["fps","tr"]', ['fps', 'tr']],
    ['an empty JSON string', '', []],
    ['a real array', ['coop'], ['coop']],
    ['something else entirely', 42, []],
  ];
  for (const [name, tags, expected] of tagShapes) {
    it(`renders tags stored as ${name}`, async () => {
      boosts.getLiveVanityServer.mockResolvedValue({ ...server(), tags });
      const res = await request(app).get('/s/gaming');
      expect(res.status).toBe(200);
      for (const tag of expected) expect(res.text).toContain(tag);
    });
  }

  it('renders the banner and icon images when the server has them', async () => {
    boosts.getLiveVanityServer.mockResolvedValue({
      ...server(), bannerUrl: 'https://cdn.test/banner.png', iconUrl: 'https://cdn.test/icon.png',
    });
    const res = await request(app).get('/s/gaming');
    // Both URLs go through the HTML escaper, so slashes appear escaped.
    expect(res.text).toContain("url('https:&#x2F;&#x2F;cdn.test&#x2F;banner.png')");
    expect(res.text).toContain('<img src="https:&#x2F;&#x2F;cdn.test&#x2F;icon.png"');
  });

  it('falls back to a gradient and the emoji icon without images', async () => {
    boosts.getLiveVanityServer.mockResolvedValue(server());
    const res = await request(app).get('/s/gaming');
    expect(res.text).toContain('linear-gradient');
    expect(res.text).toContain('🎮');
  });

  it('escapes a server name that contains markup', async () => {
    boosts.getLiveVanityServer.mockResolvedValue({
      ...server(), name: '<script>alert(1)</script>', description: undefined,
    });
    const res = await request(app).get('/s/gaming');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<script>alert(1)</script>');
    expect(res.text).toContain('&lt;script&gt;');
  });

  it('is not served on the API mount; the request falls through to the canonical 404', async () => {
    boosts.getLiveVanityServer.mockResolvedValue(server());
    const res = await request(app).get('/api/servers/anything')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
    // The vanity page never ran: no lookup, and none of its markup.
    expect(boosts.getLiveVanityServer).not.toHaveBeenCalled();
    expect(res.text).not.toContain('Topluluğa Katıl');
  });
});
