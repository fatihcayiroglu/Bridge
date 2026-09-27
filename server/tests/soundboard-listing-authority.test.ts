// server/tests/soundboard-listing-authority.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// GET /soundboard — SUNUCU YETKISI, SORGU SINIRLARI VE KIMLIK DOGRULAMA
// ════════════════════════════════════════════════════════════════════════════
// Liste ucu iki ayri isi birden yapar ve ikisi de guvenlik acisindan onemlidir.
//
// 1. SORGU SINIRLARI. `limit`, `cursor`, `q`, `scope`, `channelId` hepsi
//    ISTEMCIDEN gelir. Sinirsiz bir `limit`, cok uzun bir `cursor` ya da
//    kontrol karakteri iceren bir arama, ya veritabanini ya da gunlukleri
//    hedef alir. Her biri AYRI AYRI reddedilmelidir.
//
// 2. `canPlay` / `locked` ISARETI. Bu, panelin bir sesi kilitli gostermesini
//    saglar. ISARET BIR YETKI DEGILDIR — gercek karar `soundboard:play`
//    soket isleyicisinde tekrar verilir. Ama isaretin YANLIS olmasi da
//    kabul edilemez: kullanicinin calamayacagi bir sesi acik gostermek, her
//    tiklamada sessizce basarisiz olan bir arayuz demektir.
//
//    Isaret, oynatma isleyicisiyle AYNI dort kosula baglidir:
//      · uye zaman asiminda OLMAMALI,
//      · kanal gercekten voice/stage OLMALI,
//      · VIEW_CHANNELS + CONNECT + SPEAK verilmis OLMALI.
//    Herhangi biri duserse isaret `false`'a duser (FAIL-CLOSED).
'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';

import { createMockDb, makeUser, makeServer, makeChannel } from './helpers/mockDb';

let db = createMockDb({ withPgPool: true });
jest.mock('../db/index', () => {
  const { createMockDb } = require('./helpers/mockDb');
  return createMockDb({ withPgPool: true });
});
jest.mock('../db/loader', () => require('../db/index'));

const resolvePermissions = jest.fn();
jest.mock('../lib/permissions', () => {
  const actual = jest.requireActual('../lib/permissions');
  return { ...actual, resolvePermissions: (...a: unknown[]) => resolvePermissions(...a) };
});

import request from 'supertest';
import express from 'express';
import { PERMS } from '../lib/permissions';

const jwt = require('jsonwebtoken');
const router = require('../routes/soundboard');

const ioEmit = jest.fn();
const testIo = { to: jest.fn(() => ({ emit: ioEmit })) };

const token = (userId: string) =>
  jwt.sign({ id: userId, username: 'user', v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });

function buildApp() {
  const app = express();
  app.set('io', testIo);
  app.use(express.json());
  app.use('/api/servers/:sid/soundboard', router);
  app.use((err: { status?: number; message: string }, _req: unknown, res: { status(c: number): { json(b: unknown): void } }) =>
    res.status(err.status || 500).json({ error: err.message }));
  return app;
}

const PLAYABLE = PERMS.VIEW_CHANNELS | PERMS.CONNECT | PERMS.SPEAK;
const MANAGER = PLAYABLE | PERMS.MANAGE_SERVER;

let app: ReturnType<typeof buildApp>;
let owner: ReturnType<typeof makeUser>;
let member: ReturnType<typeof makeUser>;
let outsider: ReturnType<typeof makeUser>;
let server: ReturnType<typeof makeServer>;
let voice: ReturnType<typeof makeChannel>;
let text: ReturnType<typeof makeChannel>;

/** Listeyi sayfali modda ister (`paged` tetikleyen bir anahtar ile). */
function list(userId: string, query: Record<string, string> = {}) {
  return request(app)
    .get(`/api/servers/${server._id}/soundboard`)
    .query({ limit: '10', ...query })
    .set('Authorization', `Bearer ${token(userId)}`);
}

beforeEach(async () => {
  db = createMockDb({ withPgPool: true });
  Object.assign(require('../db/loader'), db);
  Object.assign(require('../db/index'), db);

  resolvePermissions.mockReset();
  // Yetki kimlige gore cozulur: sahibin YONETIM yetkisi vardir, duz uyenin
  // yalnizca oynatma yetkisi. Tek bir sabit deger dondurmek, yetkilendirme
  // sirasini (once yetki, sonra ayristirma) olcemez hale getirirdi.
  resolvePermissions.mockImplementation(async (userId: string) =>
    userId === owner._id ? MANAGER : PLAYABLE);

  owner = makeUser({ username: 'owner' });
  member = makeUser({ username: 'member' });
  outsider = makeUser({ username: 'outsider' });
  server = makeServer(owner._id);
  voice = makeChannel(server._id, { name: 'lounge', type: 'voice' });
  text = makeChannel(server._id, { name: 'general', type: 'text' });

  await db.users.insert(owner);
  await db.users.insert(member);
  await db.users.insert(outsider);
  await db.servers.insert(server);
  await db.channels.insert(voice);
  await db.channels.insert(text);
  await db.members.insert({ userId: owner._id, serverId: server._id, roles: '[]', joinedAt: Date.now() });
  await db.members.insert({ userId: member._id, serverId: server._id, roles: '[]', joinedAt: Date.now() });
  await db.soundboard.insert({
    _id: 's1', serverId: server._id, name: 'boom', emoji: '💥',
    url: '/uploads/soundboard/boom.mp3', createdAt: Date.now(),
  });

  app = buildApp();
  testIo.to.mockClear(); ioEmit.mockClear();
});

// ── QUERY BOUNDS ────────────────────────────────────────────────────────────
describe('every client-supplied query parameter is bounded', () => {
  it('refuses a repeated parameter that arrives as an array', async () => {
    const res = await request(app)
      .get(`/api/servers/${server._id}/soundboard?limit=10&limit=20`)
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/scalar/i);
  });

  it.each([
    ['a non-numeric limit', { limit: 'abc' }, /page limit/i],
    ['a four-digit limit', { limit: '1000' }, /page limit/i],
    ['a zero limit', { limit: '0' }, /between 1 and 100/i],
    ['a limit above the ceiling', { limit: '101' }, /between 1 and 100/i],
  ])('refuses %s', async (_label, query, message) => {
    const res = await list(member._id, query as Record<string, string>);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
  });

  it('refuses an over-long search query and control characters in it', async () => {
    const long = await list(member._id, { q: 'x'.repeat(65) });
    expect(long.status).toBe(400);

    const control = await list(member._id, { q: 'ab\u0007cd' });
    expect(control.status).toBe(400);
  });

  it('refuses an over-long cursor before trying to decode it', async () => {
    const res = await list(member._id, { cursor: 'c'.repeat(513) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cursor/i);
  });

  it('refuses a malformed cursor that is within the length bound', async () => {
    const res = await list(member._id, { cursor: 'not-a-real-cursor' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cursor/i);
  });

  it.each([
    ['an over-long channel id', 'c'.repeat(65)],
    ['a control character in the channel id', 'chan\u0000nel'],
  ])('refuses %s', async (_label, channelId) => {
    const res = await list(member._id, { channelId });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/voice channel/i);
  });

  it('refuses an unknown scope', async () => {
    const res = await list(member._id, { scope: 'everything' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/scope/i);
  });

  it('serves the legacy unpaged shape when no paging key is supplied', async () => {
    const res = await request(app)
      .get(`/api/servers/${server._id}/soundboard`)
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(200);
    // Eski istemciler duz bir dizi bekler; sozlesme korunur.
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('serves the paged shape and defaults the limit when only a scope is given', async () => {
    const res = await request(app)
      .get(`/api/servers/${server._id}/soundboard`)
      .query({ scope: 'all' })
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(false);
    expect(res.body).toHaveProperty('items');
    expect(res.body).toHaveProperty('canManage');
  });

  it('refuses a non-member outright', async () => {
    const res = await list(outsider._id);
    expect(res.status).toBe(403);
  });
});

// ── PLAY ANNOTATION ─────────────────────────────────────────────────────────
describe('the locked marker mirrors the play handler exactly', () => {
  it('omits the marker entirely when no voice channel is named', async () => {
    const res = await list(member._id);
    expect(res.status).toBe(200);
    // Kanal bilinmeden oynatilabilirlik hakkinda IDDIA uretilmez.
    expect(res.body).not.toHaveProperty('canPlay');
    expect(res.body.items[0]).not.toHaveProperty('locked');
  });

  it('marks every sound playable for a permitted member in a voice channel', async () => {
    const res = await list(member._id, { channelId: voice._id });
    expect(res.status).toBe(200);
    expect(res.body.canPlay).toBe(true);
    expect(res.body.items[0]).toEqual(expect.objectContaining({ canPlay: true, locked: false }));
  });

  it.each([
    ['SPEAK is denied', PERMS.VIEW_CHANNELS | PERMS.CONNECT],
    ['CONNECT is denied', PERMS.VIEW_CHANNELS | PERMS.SPEAK],
    ['VIEW_CHANNELS is denied', PERMS.CONNECT | PERMS.SPEAK],
    ['nothing is granted', 0],
  ])('locks every sound when %s', async (_label, perms) => {
    resolvePermissions.mockResolvedValue(perms);
    const res = await list(member._id, { channelId: voice._id });
    expect(res.body.canPlay).toBe(false);
    expect(res.body.items[0]).toEqual(expect.objectContaining({ canPlay: false, locked: true }));
  });

  it('locks sounds for a text channel, which can never carry audio', async () => {
    const res = await list(member._id, { channelId: text._id });
    expect(res.body.canPlay).toBe(false);
  });

  it('locks sounds for a channel that does not belong to this server', async () => {
    const foreign = makeChannel('other-server', { name: 'elsewhere', type: 'voice' });
    await db.channels.insert(foreign);
    const res = await list(member._id, { channelId: foreign._id });
    // Baska sunucunun kanali adiyla anilarak yetki devsirilemez.
    expect(res.body.canPlay).toBe(false);
  });

  it('locks sounds while the member is timed out', async () => {
    await db.members.update(
      { userId: member._id, serverId: server._id },
      { $set: { timeoutUntil: Date.now() + 600_000 } },
    );
    const res = await list(member._id, { channelId: voice._id });
    // Moderasyon yaptirimi metinle sinirli degildir; uye ses de URETEMEZ.
    expect(res.body.canPlay).toBe(false);
    expect(res.body.items[0].locked).toBe(true);
  });

  it('unlocks again once the timeout has elapsed', async () => {
    await db.members.update(
      { userId: member._id, serverId: server._id },
      { $set: { timeoutUntil: Date.now() - 1_000 } },
    );
    const res = await list(member._id, { channelId: voice._id });
    expect(res.body.canPlay).toBe(true);
  });

  it('fails closed when the permission resolver itself throws', async () => {
    resolvePermissions.mockRejectedValue(new Error('permission store down'));
    const res = await list(member._id, { channelId: voice._id });
    expect(res.status).toBe(200);
    // Yetki bilinemiyorsa KILITLI gosterilir; acik gostermek yalan olurdu.
    expect(res.body.canPlay).toBe(false);
    expect(res.body.canManage).toBe(false);
  });
});

// ── MUTATION ID BOUNDS ──────────────────────────────────────────────────────
describe('every mutation validates the sound id before touching storage', () => {
  const longId = 'x'.repeat(65);

  it.each([
    ['PATCH', (id: string) => request(app).patch(`/api/servers/${server._id}/soundboard/${id}`).send({ name: 'x' })],
    ['PUT favorite', (id: string) => request(app).put(`/api/servers/${server._id}/soundboard/${id}/favorite`)],
    ['DELETE favorite', (id: string) => request(app).delete(`/api/servers/${server._id}/soundboard/${id}/favorite`)],
    ['DELETE sound', (id: string) => request(app).delete(`/api/servers/${server._id}/soundboard/${id}`)],
  ])('%s refuses an over-long id', async (_label, call) => {
    const res = await call(longId).set('Authorization', `Bearer ${token(owner._id)}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sound id/i);
  });

  it.each([
    ['PATCH', () => request(app).patch(`/api/servers/${server._id}/soundboard/${longId}`).send({ name: 'x' })],
    ['DELETE sound', () => request(app).delete(`/api/servers/${server._id}/soundboard/${longId}`)],
  ])('%s authorizes before it parses the id', async (_label, call) => {
    // Yetkisiz cagirana ayristirma hatasi bile SIZDIRILMAZ: once 403.
    const res = await call().set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(403);
  });

  it('reports a missing sound rather than inventing a favorite', async () => {
    const res = await request(app)
      .delete(`/api/servers/${server._id}/soundboard/does-not-exist/favorite`)
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(404);
  });

  it('reports a missing sound on delete', async () => {
    const res = await request(app)
      .delete(`/api/servers/${server._id}/soundboard/does-not-exist`)
      .set('Authorization', `Bearer ${token(owner._id)}`);
    expect(res.status).toBe(404);
  });

  it('favouriting is idempotent and reports the stored timestamp', async () => {
    const first = await request(app)
      .put(`/api/servers/${server._id}/soundboard/s1/favorite`)
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(first.status).toBe(200);
    expect(first.body).toEqual(expect.objectContaining({ ok: true, soundId: 's1', favorite: true }));
    expect(typeof first.body.favoritedAt).toBe('number');

    const second = await request(app)
      .put(`/api/servers/${server._id}/soundboard/s1/favorite`)
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(second.status).toBe(200);
    expect(second.body.favorite).toBe(true);
  });

  it('refuses a rename from a member without MANAGE_SERVER', async () => {
    resolvePermissions.mockResolvedValue(PERMS.VIEW_CHANNELS);
    const res = await request(app)
      .patch(`/api/servers/${server._id}/soundboard/s1`)
      .set('Authorization', `Bearer ${token(member._id)}`)
      .send({ name: 'sahiplenildi' });
    expect(res.status).toBe(403);
  });
});
