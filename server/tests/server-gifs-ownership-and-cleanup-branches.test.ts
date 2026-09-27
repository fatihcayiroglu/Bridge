// server/tests/server-gifs-ownership-and-cleanup-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// SUNUCU GIF'LERİ — YÜKLEME SAHİPLİĞİ, ARAMA VE FİZİKSEL TEMİZLİK
// ════════════════════════════════════════════════════════════════════════════
//
// Bir GIF kaydı, istemcinin verdiği bir ADRESİ kalıcılaştırır. Bu yüzden buradaki
// üç sınır de doğrudan güvenlik/veri bütünlüğüdür:
//
//   · SAHİPLİK. Adres istemciden gelse de kabul edilen tek şey, ÖN YÜKLEME
//     ucunun ürettiği kanonik anahtardır ve o anahtar İSTEĞİ YAPAN kullanıcıya
//     ait olmalıdır. Aksi hâlde bir üye, başkasının yüklediği (ya da tamamen
//     harici) bir adresi kendi sunucusunda yayımlatabilirdi.
//   · ADRES YENİDEN ÜRETİLİR. Saklanan adres, sağlayıcının anahtardan
//     ürettiği kanonik adrestir; istemcinin gönderdiği dize değil.
//   · TEMİZLİK. Satır silindikten SONRA dosya yalnızca başka hiçbir yerden
//     referans verilmiyorsa silinir; belirsizlikte dosya KORUNUR ve loglanır.

'use strict';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';

import type { RequestBody } from './helpers/httpDoubles';
import { createMockDb, makeServer, makeUser, requireDoc } from './helpers/mockDb';
let db = createMockDb();
jest.mock('../db/index', () => { const { createMockDb } = require('./helpers/mockDb'); return createMockDb(); });
jest.mock('../db/loader', () => require('../db/index'));

jest.mock('../routes/roles', () => ({
  getMemberPerms: async (userId: string, serverId: string) => {
    const dbMod = require('../db/index');
    const server = await dbMod.servers.findOne({ _id: serverId });
    if (server?.ownerId === userId) return 0xFFFFFFFF;
    return 0;
  },
  hasPermission: (perms: number, flag: number) => (perms & flag) !== 0,
  PERMS: { MANAGE_CHANNELS: 16, ADMINISTRATOR: 8 },
}));

const keyFromUrl = jest.fn((url: string) => url.replace(/^https?:\/\/[^/]+\//, ''));
const publicUrlForKey = jest.fn((key: string) => `https://cdn.test/${key}`);
const deleteFile = jest.fn(async () => undefined);
jest.mock('../lib/storageAdapter', () => ({
  getStorageAdapter: () => ({ keyFromUrl, publicUrlForKey, deleteFile }),
  getPrivateStorageAdapter: () => ({ keyFromUrl, publicUrlForKey, deleteFile }),
  getProvider: () => 'local',
  getPrivateStorageProvider: () => 'local',
}));

const hasLiveUploadReference = jest.fn();
jest.mock('../lib/uploadReferenceSafety', () => {
  const actual = jest.requireActual('../lib/uploadReferenceSafety');
  return { ...actual, hasLiveUploadReference: (...a: unknown[]) => hasLiveUploadReference(...a) };
});

const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../lib/logger', () => ({ __esModule: true, default: log, ...log, createLogger: () => log }));
jest.mock('../middleware/rateLimit', () => ({
  limits: new Proxy({}, { get: () => () => (_req: unknown, _res: unknown, next: () => void) => next() }),
}));

import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
const router = require('../routes/serverGifs');

const token = (userId: string) =>
  jwt.sign({ id: userId, username: 'user', v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers/:id/gifs', router);
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

const VALID_KEY = 'uploads/server-gifs/gif_11111111-2222-3333-4444-555555555555.gif';
const VALID_URL = `https://cdn.test/${VALID_KEY}`;

let app: express.Express;
let owner: any;
let member: any;
let server: any;
let otherServer: any;

beforeEach(async () => {
  db = createMockDb();
  Object.assign(require('../db/loader'), db);
  Object.assign(require('../db/index'), db);
  jest.clearAllMocks();
  keyFromUrl.mockImplementation((url: string) => url.replace(/^https?:\/\/[^/]+\//, ''));
  publicUrlForKey.mockImplementation((key: string) => `https://cdn.test/${key}`);
  hasLiveUploadReference.mockResolvedValue(false);

  app = buildApp();
  owner = makeUser({ username: 'owner' });
  member = makeUser({ username: 'member' });
  server = makeServer(owner._id, { name: 'Gif Server' });
  otherServer = makeServer(owner._id, { name: 'Other Server' });

  await db.users.insert(owner);
  await db.users.insert(member);
  await db.servers.insert(server);
  await db.servers.insert(otherServer);
  await db.members.insert({ userId: owner._id, serverId: server._id, roles: '[]', joinedAt: Date.now() });
  await db.members.insert({ userId: member._id, serverId: server._id, roles: '[]', joinedAt: Date.now() });
  await db.members.insert({ userId: owner._id, serverId: otherServer._id, roles: '[]', joinedAt: Date.now() });
  await db.uploads.insert({ _id: 'up1', key: VALID_KEY, userId: owner._id, createdAt: Date.now() });
});

const post = (body: RequestBody, actor = owner) =>
  request(app).post(`/api/servers/${server._id}/gifs`).set('Authorization', `Bearer ${token(actor._id)}`).send(body);
const list = (query = '', actor = member) =>
  request(app).get(`/api/servers/${server._id}/gifs${query}`).set('Authorization', `Bearer ${token(actor._id)}`);
const remove = (gifId: string, actor = owner) =>
  request(app).delete(`/api/servers/${server._id}/gifs/${gifId}`).set('Authorization', `Bearer ${token(actor._id)}`);

describe('publishing a GIF binds it to an owned pre-upload', () => {
  it('stores the provider\'s canonical url, not the one the client sent', async () => {
    publicUrlForKey.mockReturnValue('https://cdn.test/canonical/regenerated.gif');
    const res = await post({ name: '  Party  ', url: 'https://attacker.test/' + VALID_KEY, tags: ['FUN', 'party'] });

    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://cdn.test/canonical/regenerated.gif');
    expect(res.body.name).toBe('Party');
    expect(res.body.tags).toEqual(['fun', 'party']);
    expect(res.body.fileType).toBe('image/gif');
  });

  it('refuses a key that did not come from the pre-upload endpoint', async () => {
    const res = await post({ name: 'Elsewhere', url: 'https://cdn.test/uploads/avatars/whatever.gif' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must come from \/api\/upload\/server-gif/);
  });

  it('refuses a key with a disallowed extension', async () => {
    keyFromUrl.mockReturnValue('uploads/server-gifs/gif_11111111-2222-3333-4444-555555555555.svg');
    const res = await post({ name: 'Vector', url: 'https://cdn.test/x' });
    expect(res.status).toBe(400);
  });

  it('accepts a key the adapter returns without the uploads/ prefix', async () => {
    keyFromUrl.mockReturnValue('server-gifs/gif_11111111-2222-3333-4444-555555555555.gif');
    const res = await post({ name: 'Prefixless', url: 'https://cdn.test/x' });
    expect(res.status).toBe(200);
    expect(publicUrlForKey).toHaveBeenCalledWith(VALID_KEY);
  });

  it('refuses an upload owned by a different user', async () => {
    // Same valid key shape, but the row belongs to somebody else.
    await db.uploads.remove({ key: VALID_KEY });
    await db.uploads.insert({ _id: 'up2', key: VALID_KEY, userId: member._id, createdAt: Date.now() });
    const res = await post({ name: 'Stolen', url: VALID_URL });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not owned by the current user/);
  });

  it('refuses a key with no upload row at all', async () => {
    await db.uploads.remove({ key: VALID_KEY });
    const res = await post({ name: 'Ghost', url: VALID_URL });
    expect(res.status).toBe(403);
  });

  const invalidBodies: Array<[string, RequestBody, RegExp]> = [
    ['no name', { url: VALID_URL }, /name and valid url are required/],
    ['a blank name', { name: '  ', url: VALID_URL }, /name and valid url are required/],
    ['a non-string name', { name: 5, url: VALID_URL }, /name and valid url are required/],
    ['no url', { name: 'X' }, /name and valid url are required/],
    ['an empty url', { name: 'X', url: '' }, /name and valid url are required/],
    ['an array body', [], /name and valid url are required/],
    ['non-array tags', { name: 'X', url: VALID_URL, tags: 'fun' }, /tags must be a string array/],
    ['non-string tags', { name: 'X', url: VALID_URL, tags: [1] }, /tags must be a string array/],
    ['a non-string fileType', { name: 'X', url: VALID_URL, fileType: 5 }, /fileType must be a string/],
  ];
  for (const [name, body, message] of invalidBodies) {
    it(`refuses ${name}`, async () => {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(message);
    });
  }

  it('bounds the name, tag length and tag count', async () => {
    const res = await post({
      name: 'n'.repeat(100), url: VALID_URL,
      tags: Array.from({ length: 15 }, () => 't'.repeat(50)),
    });
    expect(res.status).toBe(200);
    expect(res.body.name).toHaveLength(64);
    expect(res.body.tags).toHaveLength(10);
    expect(res.body.tags[0]).toHaveLength(32);
  });

  it('a member without MANAGE_CHANNELS cannot publish', async () => {
    const res = await post({ name: 'X', url: VALID_URL }, member);
    expect(res.status).toBe(403);
  });
});

describe('listing and searching', () => {
  beforeEach(async () => {
    await db.serverGifs.insert({
      _id: 'g1', serverId: server._id, name: 'Party Time', tags: ['fun'], url: VALID_URL, createdAt: 1,
    });
    await db.serverGifs.insert({
      _id: 'g2', serverId: server._id, name: 'Sad Cat', tags: JSON.stringify(['animals', 'cat']), url: VALID_URL, createdAt: 2,
    });
    await db.serverGifs.insert({
      _id: 'g3', serverId: server._id, url: VALID_URL, createdAt: 3,
    });
  });

  it('returns the whole collection with no query', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body.map((g: { _id: string }) => g._id).sort()).toEqual(['g1', 'g2', 'g3']);
  });

  it('matches on the name, case-insensitively', async () => {
    const res = await list('?q=PARTY');
    expect(res.body.map((g: { _id: string }) => g._id)).toEqual(['g1']);
  });

  it('matches on tags stored as an array', async () => {
    const res = await list('?q=fun');
    expect(res.body.map((g: { _id: string }) => g._id)).toEqual(['g1']);
  });

  it('matches on tags stored as a JSON string', async () => {
    const res = await list('?q=cat');
    expect(res.body.map((g: { _id: string }) => g._id)).toEqual(['g2']);
  });

  it('a row with neither a name nor tags simply does not match', async () => {
    const res = await list('?q=anything');
    expect(res.body).toEqual([]);
  });

  it('a non-member cannot list', async () => {
    const outsider = makeUser({ username: 'outsider' });
    await db.users.insert(outsider);
    const res = await list('', outsider);
    expect(res.status).toBe(403);
  });

  it('the cross-server view groups by server and names unknown servers', async () => {
    await db.serverGifs.insert({ _id: 'g4', serverId: 'srv-vanished', name: 'Orphan', url: VALID_URL, createdAt: 4 });
    await db.members.insert({ userId: member._id, serverId: 'srv-vanished', roles: '[]', joinedAt: Date.now() });

    const res = await request(app).get(`/api/servers/${server._id}/gifs/all`)
      .set('Authorization', `Bearer ${token(member._id)}`);

    expect(res.status).toBe(200);
    expect(res.body[server._id].server).toMatchObject({ name: 'Gif Server' });
    expect(res.body[server._id].gifs).toHaveLength(3);
    // A membership whose server row is gone still groups, under a placeholder.
    expect(res.body['srv-vanished'].server).toEqual({ name: 'Unknown' });
  });
});

describe('deleting a GIF', () => {
  beforeEach(async () => {
    await db.serverGifs.insert({
      _id: 'g1', serverId: server._id, name: 'Party', tags: [], url: VALID_URL, createdAt: 1,
    });
  });

  it('removes the row first and then the unreferenced file', async () => {
    hasLiveUploadReference.mockResolvedValue(false);
    const res = await remove('g1');
    expect(res.status).toBe(200);
    expect(await db.serverGifs.findOne({ _id: 'g1' })).toBeFalsy();
    expect(deleteFile).toHaveBeenCalledWith(VALID_KEY);
  });

  it('keeps a file that something else still references', async () => {
    hasLiveUploadReference.mockResolvedValue(true);
    const res = await remove('g1');
    expect(res.status).toBe(200);
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('keeps the file when the reference lookup fails, and says so', async () => {
    hasLiveUploadReference.mockRejectedValue(new Error('reference index offline'));
    const res = await remove('g1');
    expect(res.status).toBe(200);
    expect(deleteFile).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'server_gif.cleanup_failed' }), expect.any(String));
  });

  it('an unusable storage key skips physical cleanup and is reported', async () => {
    keyFromUrl.mockReturnValue('../../etc/passwd');
    const res = await remove('g1');
    expect(res.status).toBe(200);
    expect(deleteFile).not.toHaveBeenCalled();
    expect(hasLiveUploadReference).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'server_gif.cleanup_invalid_key' }), expect.any(String));
  });

  it('a GIF from another server cannot be deleted through this one', async () => {
    await db.serverGifs.insert({
      _id: 'foreign', serverId: otherServer._id, name: 'Foreign', url: VALID_URL, createdAt: 1,
    });
    const res = await remove('foreign');
    expect(res.status).toBe(404);
    expect(await db.serverGifs.findOne({ _id: 'foreign' })).toBeTruthy();
  });

  it('a member without MANAGE_CHANNELS cannot delete', async () => {
    const res = await remove('g1', member);
    expect(res.status).toBe(403);
    expect(await db.serverGifs.findOne({ _id: 'g1' })).toBeTruthy();
  });
});
