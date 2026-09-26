// server/tests/soundboard.test.ts
'use strict';

process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';

import path from 'path';
const os   = require('os');
const fs   = require('fs');

const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-sb-test-'));

jest.mock('multer', () => {
  const multer = jest.requireActual('multer');
  const storage = multer.diskStorage({
    destination: (_req: unknown, _file: unknown, cb: (err: Error | null, dest: string) => void) => cb(null, UPLOAD_DIR),
    filename:    (_req: unknown, _file: unknown, cb: (err: Error | null, name: string) => void) => cb(null, `sound_test_${Date.now()}.mp3`),
  });
  const m = (opts: Record<string, unknown>) => multer({ ...opts, storage });
  m.diskStorage = multer.diskStorage;
  return m;
});

import { createMockDb, makeServer, makeUser, requireDoc } from './helpers/mockDb';
import type { ServerFixture, UserFixture } from './helpers/mockDb';
/* Bu süit REFERANS-GÜVENLİ TEMİZLİK sırasını ölçer: fiziksel dosya, DB
   referansı kalmadığı KANITLANMADAN silinmemelidir. Kontrol
   `hasLiveUploadReference(db._pool, ...)` üzerinden gider, bu yüzden havuz
   stub'u AÇIKÇA istenir (varsayılan mock'ta yoktur — bkz. helpers/mockDb.ts). */
let db = createMockDb({ withPgPool: true });
jest.mock('../db/index', () => { const { createMockDb } = require('./helpers/mockDb'); return createMockDb({ withPgPool: true }); });
jest.mock('../db/loader', () => require('../db/index'));

import request from 'supertest';
import express from 'express';
const jwt     = require('jsonwebtoken');
const router  = require('../routes/soundboard');

function token(userId: string) {
  return jwt.sign({ id: userId, username: 'user', v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });
}

function buildApp() {
  const app = express();
  app.set('io', testIo);
  app.use(express.json());
  app.use('/api/servers/:sid/soundboard', router);
  app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

const ioEmit = jest.fn();
const testIo = { to: jest.fn(() => ({ emit: ioEmit })) };

function makePcmWav(durationSeconds: number): Buffer {
  const sampleRate = 8_000;
  const dataBytes = Math.max(1, Math.round(sampleRate * durationSeconds));
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

const FAKE_AUDIO = path.join(UPLOAD_DIR, 'fake.wav');
fs.writeFileSync(FAKE_AUDIO, makePcmWav(0.25));

const TOO_LONG_AUDIO = path.join(UPLOAD_DIR, 'too-long.wav');
fs.writeFileSync(TOO_LONG_AUDIO, makePcmWav(5.25));

// Sesle ILGISI OLMAYAN yuk — negatif testler icin.
const NOT_AUDIO = path.join(UPLOAD_DIR, 'not-audio.mp3');
fs.writeFileSync(NOT_AUDIO, Buffer.from('<html><script>alert(1)</script></html>'));

const HEADER_ONLY_MP3 = path.join(UPLOAD_DIR, 'header-only.mp3');
fs.writeFileSync(HEADER_ONLY_MP3, Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]));

let app: express.Express;
let owner: UserFixture;
let member: UserFixture;
let outsider: UserFixture;
let server: ServerFixture;

beforeEach(async () => {
  db = createMockDb({ withPgPool: true });
  Object.assign(require('../db/loader'), db);
  Object.assign(require('../db/index'), db);

  owner    = makeUser({ username: 'owner' });
  member   = makeUser({ username: 'member' });
  outsider = makeUser({ username: 'outsider' });
  server   = makeServer(owner._id);

  await db.users.insert(owner);
  await db.users.insert(member);
  await db.users.insert(outsider);
  await db.servers.insert(server);
  await db.members.insert({ userId: owner._id,  serverId: server._id, roles: '[]', joinedAt: Date.now() });
  await db.members.insert({ userId: member._id, serverId: server._id, roles: '[]', joinedAt: Date.now() });

  app = buildApp();
  testIo.to.mockClear();
  ioEmit.mockClear();
});

afterAll(() => {
  try { fs.rmSync(UPLOAD_DIR, { recursive: true }); } catch {}
});

// ═══════════════════════════════════════════════════════
// GET /api/servers/:sid/soundboard
// ═══════════════════════════════════════════════════════

/**
 * PostgreSQL havuz STUB'u — `MockDb._pool` ISTEGE BAGLIDIR (bkz. mockDb.ts).
 * Bu suit atomik SQL yolunu olctugu icin havuzun VARLIGI iddianin parcasidir;
 * yoksa testin kendisi yanlis kurulmus demektir.
 */
function pgPool(): NonNullable<typeof db._pool> {
  if (!db._pool) throw new Error('pg havuz stubu kurulmadi: attachPgPoolStub() cagrildi mi?');
  return db._pool;
}

describe('GET /api/servers/:sid/soundboard', () => {
  it('üye ses listesini alır', async () => {
    await db.soundboard.insert({ _id: 's1', serverId: server._id, name: 'boom', emoji: '💥', url: '/uploads/soundboard/boom.mp3', createdAt: Date.now() });
    const res = await request(app)
      .get(`/api/servers/${server._id}/soundboard`)
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
    expect(res.body[0].name).toBe('boom');
  });

  it('boş liste döner (ses yok)', async () => {
    const res = await request(app)
      .get(`/api/servers/${server._id}/soundboard`)
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('üye olmayan 403 alır', async () => {
    const res = await request(app)
      .get(`/api/servers/${server._id}/soundboard`)
      .set('Authorization', `Bearer ${token(outsider._id)}`);
    expect(res.status).toBe(403);
  });

  it('üyelik deposu arızasında fail-closed davranır', async () => {
    const original = db.members.findOne;
    db.members.findOne = jest.fn().mockRejectedValue(new Error('membership unavailable'));
    const res = await request(app)
      .get(`/api/servers/${server._id}/soundboard?limit=20`)
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(403);
    db.members.findOne = original;
  });

  it('token olmadan 401 döner', async () => {
    const res = await request(app).get(`/api/servers/${server._id}/soundboard`);
    expect(res.status).toBe(401);
  });

  it('global + server kütüphanesini opak cursor ile sayfalar ve yönetim yetkisini fail-closed sunar', async () => {
    await db.soundboard.insert({ _id: 'server-sound', serverId: server._id, name: 'Server Bell', emoji: '🔔', url: '/uploads/soundboard/bell.wav', category: 'Alerts', createdAt: 10 });
    const first = await request(app)
      .get(`/api/servers/${server._id}/soundboard?limit=3&scope=all`)
      .set('Authorization', `Bearer ${token(owner._id)}`);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(3);
    expect(first.body.items.every((sound: Record<string, unknown>) =>
      typeof sound.scope === 'string' && ['global', 'server'].includes(sound.scope))).toBe(true);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    expect(first.body.canManage).toBe(true);

    const second = await request(app)
      .get(`/api/servers/${server._id}/soundboard?limit=3&scope=all&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(second.status).toBe(200);
    expect(second.body.canManage).toBe(false);
    expect(second.body.items.map((sound: Record<string, unknown>) => sound._id)).not.toEqual(expect.arrayContaining(first.body.items.map((sound: Record<string, unknown>) => sound._id)));
    expect([...first.body.items, ...second.body.items].some((sound) => sound._id === 'server-sound')).toBe(true);
  });

  it('cursoru sorgu/scope bağlamına bağlar ve biçimsiz/çoklu sorguları reddeder', async () => {
    const page = await request(app)
      .get(`/api/servers/${server._id}/soundboard?limit=1&scope=all&q=i`)
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(page.status).toBe(200);
    expect(page.body.nextCursor).toEqual(expect.any(String));

    const mismatch = await request(app)
      .get(`/api/servers/${server._id}/soundboard?limit=1&scope=server&q=other&cursor=${encodeURIComponent(page.body.nextCursor)}`)
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(mismatch.status).toBe(400);
    const malformed = await request(app)
      .get(`/api/servers/${server._id}/soundboard?cursor=%25%25%25&limit=20`)
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(malformed.status).toBe(400);
    const arrayQuery = await request(app)
      .get(`/api/servers/${server._id}/soundboard?q=a&q=b`)
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(arrayQuery.status).toBe(400);
  });

  it('geçersiz kapsam, limit ve arama girdilerini deterministik 400 ile reddeder', async () => {
    for (const query of [
      'scope=unknown', 'limit=0', 'limit=101', 'limit=1.5',
      `q=${encodeURIComponent('x'.repeat(65))}`, `q=${encodeURIComponent('bad\u0001query')}`,
    ]) {
      const res = await request(app)
        .get(`/api/servers/${server._id}/soundboard?${query}`)
        .set('Authorization', `Bearer ${token(member._id)}`);
      expect(res.status).toBe(400);
    }
  });

  it('yönetim yetkisi çözümleme arızasını listelemeyi bozmadan false olarak işaretler', async () => {
    const original = db.servers.findOne;
    db.servers.findOne = jest.fn().mockRejectedValue(new Error('permission dependency unavailable'));
    const res = await request(app)
      .get(`/api/servers/${server._id}/soundboard?limit=20`)
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(200);
    expect(res.body.canManage).toBe(false);
    db.servers.findOne = original;
  });

  it('1.500 kayıtta yanıtı sayfa boyutuna sınırlar ve literal arama yapar', async () => {
    await Promise.all(Array.from({ length: 1_500 }, (_, i) => db.soundboard.insert({
      _id: `large-${String(i).padStart(4, '0')}`,
      serverId: server._id,
      name: i === 777 ? 'Literal 100%_Match' : `Library ${i}`,
      emoji: '🔊',
      url: `/uploads/soundboard/large-${i}.wav`,
      category: 'Scale',
      createdAt: i,
    })));
    const started = Date.now();
    const page = await request(app)
      .get(`/api/servers/${server._id}/soundboard?limit=60&scope=server`)
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(page.status).toBe(200);
    expect(page.body.items).toHaveLength(60);
    expect(page.body.nextCursor).toEqual(expect.any(String));
    expect(Buffer.byteLength(JSON.stringify(page.body))).toBeLessThan(30_000);
    expect(Date.now() - started).toBeLessThan(2_000);

    const search = await request(app)
      .get(`/api/servers/${server._id}/soundboard?limit=60&scope=server&q=${encodeURIComponent('100%_')}`)
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(search.status).toBe(200);
    expect(search.body.items.map((sound: Record<string, unknown>) => sound._id)).toEqual(['large-0777']);
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/servers/:sid/soundboard
// ═══════════════════════════════════════════════════════
describe('POST /api/servers/:sid/soundboard', () => {
  it('sunucu sahibi ses yükleyebilir', async () => {
    const res = await request(app)
      .post(`/api/servers/${server._id}/soundboard`)
      .set('Authorization', `Bearer ${token(owner._id)}`)
      .attach('sound', FAKE_AUDIO, { contentType: 'audio/wav' })
      .field('name', 'explosion')
      .field('emoji', '💥');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('explosion');
    expect(res.body.emoji).toBe('💥');
    expect(res.body.url).toMatch(/\/uploads\/soundboard\//);
    expect(res.body.serverId).toBe(server._id);
    expect(res.body.durationSeconds).toBeCloseTo(0.25, 2);
    expect(res.body.mimeType).toBe('audio/wav');
    expect(ioEmit).toHaveBeenCalledWith('soundboard:created', expect.objectContaining({ serverId: server._id }));
  });

  it('name olmasa filename\'den türetir', async () => {
    const res = await request(app)
      .post(`/api/servers/${server._id}/soundboard`)
      .set('Authorization', `Bearer ${token(owner._id)}`)
      .attach('sound', FAKE_AUDIO, { filename: 'mysound.wav', contentType: 'audio/wav' });
    expect(res.status).toBe(200);
    expect(typeof res.body.name).toBe('string');
    expect(res.body.name.length).toBeGreaterThan(0);
  });

  it('browser audio/x-wav aliasını imza ve codec doğrulamasından geçirir', async () => {
    const res = await request(app)
      .post(`/api/servers/${server._id}/soundboard`)
      .set('Authorization', `Bearer ${token(owner._id)}`)
      .attach('sound', FAKE_AUDIO, { filename: 'alias.bin', contentType: 'audio/x-wav' })
      .field('name', 'wav alias');
    expect(res.status).toBe(200);
    expect(res.body.mimeType).toBe('audio/x-wav');
    expect(res.body.durationSeconds).toBeCloseTo(0.25, 2);
  });

  it('normal üye ses yükleyemez', async () => {
    const res = await request(app)
      .post(`/api/servers/${server._id}/soundboard`)
      .set('Authorization', `Bearer ${token(member._id)}`)
      .attach('sound', FAKE_AUDIO, { contentType: 'audio/wav' })
      .field('name', 'test');
    expect(res.status).toBe(403);
  });

  it('GÜVENLİK: VIEW_CHANNELS(1) veya eski hard-coded 64 biti MANAGE_SERVER sayılmaz ve dosya yazmaz', async () => {
    for (const [roleId, permissions] of [['view-only', 1], ['bit64-only', 64]] as const) {
      await db.roles.insert({ _id: roleId, serverId: server._id, name: roleId, permissions, position: 1 });
      await db.members.update(
        { userId: member._id, serverId: server._id },
        { $set: { roles: JSON.stringify([roleId]) } },
      );
      const before = fs.readdirSync(UPLOAD_DIR).filter((f: string) => f.startsWith('sound_test_')).length;
      const res = await request(app)
        .post(`/api/servers/${server._id}/soundboard`)
        .set('Authorization', `Bearer ${token(member._id)}`)
        .attach('sound', FAKE_AUDIO, { contentType: 'audio/wav' })
        .field('name', roleId);
      const after = fs.readdirSync(UPLOAD_DIR).filter((f: string) => f.startsWith('sound_test_')).length;
      expect(res.status).toBe(403);
      expect(after).toBe(before);
    }
  });

  it('MANAGE_SERVER(8) rolü olan üye ses yükleyebilir', async () => {
    await db.roles.insert({ _id: 'sound-manager', serverId: server._id, name: 'sound-manager', permissions: 8, position: 1 });
    await db.members.update(
      { userId: member._id, serverId: server._id },
      { $set: { roles: JSON.stringify(['sound-manager']) } },
    );
    const res = await request(app)
      .post(`/api/servers/${server._id}/soundboard`)
      .set('Authorization', `Bearer ${token(member._id)}`)
      .attach('sound', FAKE_AUDIO, { contentType: 'audio/wav' })
      .field('name', 'managed');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('managed');
  });

  it('DB insert başarısızsa yazılmış sound dosyasını rollback eder', async () => {
    const originalInsert = db.soundboard.insert.bind(db.soundboard);
    db.soundboard.insert = jest.fn(async () => { throw new Error('db down'); });
    const before = fs.readdirSync(UPLOAD_DIR).filter((f: string) => f.startsWith('sound_test_')).length;
    const res = await request(app)
      .post(`/api/servers/${server._id}/soundboard`)
      .set('Authorization', `Bearer ${token(owner._id)}`)
      .attach('sound', FAKE_AUDIO, { contentType: 'audio/wav' })
      .field('name', 'rollback');
    const after = fs.readdirSync(UPLOAD_DIR).filter((f: string) => f.startsWith('sound_test_')).length;
    expect(res.status).toBe(500);
    expect(after).toBe(before);
    db.soundboard.insert = originalInsert;
  });

  it('dosya olmadan 400 döner', async () => {
    const res = await request(app)
      .post(`/api/servers/${server._id}/soundboard`)
      .set('Authorization', `Bearer ${token(owner._id)}`)
      .field('name', 'nofile');
    expect(res.status).toBe(400);
  });

  it('MIME başlığına güvenmez; bozuk codec/container ve beş saniyeyi aşan sesi siler', async () => {
    const before = fs.readdirSync(UPLOAD_DIR).filter((file: string) => file.startsWith('sound_test_')).length;
    const malformed = await request(app)
      .post(`/api/servers/${server._id}/soundboard`)
      .set('Authorization', `Bearer ${token(owner._id)}`)
      .attach('sound', NOT_AUDIO, { contentType: 'audio/mpeg' })
      .field('name', 'not audio');
    expect(malformed.status).toBe(400);

    const headerOnly = await request(app)
      .post(`/api/servers/${server._id}/soundboard`)
      .set('Authorization', `Bearer ${token(owner._id)}`)
      .attach('sound', HEADER_ONLY_MP3, { contentType: 'audio/mpeg' })
      .field('name', 'header only');
    expect(headerOnly.status).toBe(400);
    expect(headerOnly.body.error).toMatch(/codec\/container/i);

    const tooLong = await request(app)
      .post(`/api/servers/${server._id}/soundboard`)
      .set('Authorization', `Bearer ${token(owner._id)}`)
      .attach('sound', TOO_LONG_AUDIO, { contentType: 'audio/wav' })
      .field('name', 'too long');
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error).toMatch(/at most 5 seconds/i);
    expect(fs.readdirSync(UPLOAD_DIR).filter((file: string) => file.startsWith('sound_test_'))).toHaveLength(before);
  });

  it('uzun/kontrol karakterli metadata ve tanınmayan MIME türünü reddeder', async () => {
    const badName = await request(app)
      .post(`/api/servers/${server._id}/soundboard`)
      .set('Authorization', `Bearer ${token(owner._id)}`)
      .attach('sound', FAKE_AUDIO, { contentType: 'audio/wav' })
      .field('name', 'x'.repeat(33));
    expect(badName.status).toBe(400);

    const controlName = await request(app)
      .post(`/api/servers/${server._id}/soundboard`)
      .set('Authorization', `Bearer ${token(owner._id)}`)
      .attach('sound', FAKE_AUDIO, { contentType: 'audio/wav' })
      .field('name', 'bad\u0001name');
    expect(controlName.status).toBe(400);

    const badMime = await request(app)
      .post(`/api/servers/${server._id}/soundboard`)
      .set('Authorization', `Bearer ${token(owner._id)}`)
      .attach('sound', FAKE_AUDIO, { contentType: 'application/octet-stream' });
    expect(badMime.status).toBe(400);
  });

  it('64 ses üstünde kullanıcıya görünen yapay bir kütüphane tavanı uygulamaz', async () => {
    for (let i = 0; i < 64; i++) {
      await db.soundboard.insert({ _id: `s${i}`, serverId: server._id, name: `sound${i}`, url: `/uploads/soundboard/s${i}.mp3`, createdAt: Date.now() });
    }
    const res = await request(app)
      .post(`/api/servers/${server._id}/soundboard`)
      .set('Authorization', `Bearer ${token(owner._id)}`)
      .attach('sound', FAKE_AUDIO, { contentType: 'audio/wav' })
      .field('name', 'overflow');
    expect(res.status).toBe(200);
    expect(await db.soundboard.count({ serverId: server._id })).toBe(65);
  });

  it('token olmadan 401 döner', async () => {
    const res = await request(app).post(`/api/servers/${server._id}/soundboard`);
    expect(res.status).toBe(401);
  });

  it('yetki deposu arızasında yüklemeyi multer çalışmadan fail-closed reddeder', async () => {
    const original = db.servers.findOne;
    db.servers.findOne = jest.fn().mockRejectedValue(new Error('permission unavailable'));
    const before = fs.readdirSync(UPLOAD_DIR).filter((file: string) => file.startsWith('sound_test_')).length;
    const res = await request(app)
      .post(`/api/servers/${server._id}/soundboard`)
      .set('Authorization', `Bearer ${token(member._id)}`)
      .attach('sound', FAKE_AUDIO, { contentType: 'audio/wav' });
    expect(res.status).toBe(403);
    expect(fs.readdirSync(UPLOAD_DIR).filter((file: string) => file.startsWith('sound_test_'))).toHaveLength(before);
    db.servers.findOne = original;
  });
});

describe('PATCH and favorite persistence', () => {
  beforeEach(async () => {
    await db.soundboard.insert({
      _id: 'editable', serverId: server._id, name: 'Old', emoji: '🔊', category: 'Server',
      url: '/uploads/soundboard/editable.wav', uploadedBy: owner._id, createdAt: 1,
    });
  });

  it('yönetici adı/emoji/kategoriyi günceller ve canonical realtime olayını yollar', async () => {
    const res = await request(app)
      .patch(`/api/servers/${server._id}/soundboard/editable`)
      .set('Authorization', `Bearer ${token(owner._id)}`)
      .send({ name: 'New', emoji: '✨', category: 'Memes' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ name: 'New', emoji: '✨', category: 'Memes', scope: 'server' }));
    expect(ioEmit).toHaveBeenCalledWith('soundboard:updated', { serverId: server._id, sound: expect.objectContaining({ _id: 'editable', name: 'New' }) });
  });

  it('normal üyeyi ve bilinmeyen/boş/taşan güncellemeleri reddeder', async () => {
    const denied = await request(app)
      .patch(`/api/servers/${server._id}/soundboard/editable`)
      .set('Authorization', `Bearer ${token(member._id)}`)
      .send({ name: 'Denied' });
    expect(denied.status).toBe(403);

    for (const body of [{}, { url: '/evil' }, { name: '' }, { emoji: 'x'.repeat(17) }, { category: 'x'.repeat(33) }]) {
      const invalid = await request(app)
        .patch(`/api/servers/${server._id}/soundboard/editable`)
        .set('Authorization', `Bearer ${token(owner._id)}`)
        .send(body);
      expect(invalid.status).toBe(400);
    }
    const arrayBody = await request(app)
      .patch(`/api/servers/${server._id}/soundboard/editable`)
      .set('Authorization', `Bearer ${token(owner._id)}`)
      .send([]);
    expect(arrayBody.status).toBe(400);
    const missing = await request(app)
      .patch(`/api/servers/${server._id}/soundboard/missing`)
      .set('Authorization', `Bearer ${token(owner._id)}`)
      .send({ name: 'No row' });
    expect(missing.status).toBe(404);
  });

  it('server ve built-in favorileri kalıcılaştırır; favorites/recent/frequent görünümleri ayırır', async () => {
    for (const soundId of ['editable', 'global:chime']) {
      const favorite = await request(app)
        .put(`/api/servers/${server._id}/soundboard/${soundId}/favorite`)
        .set('Authorization', `Bearer ${token(member._id)}`);
      expect(favorite.status).toBe(200);
      expect(favorite.body.favorite).toBe(true);
    }
    await db.soundboardUserStats.update(
      { userId: member._id, soundId: 'editable' },
      { $set: { playCount: 8, lastPlayedAt: 500 } },
    );

    const favorites = await request(app)
      .get(`/api/servers/${server._id}/soundboard?scope=favorites&limit=20`)
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(favorites.body.items.map((sound: Record<string, unknown>) => sound._id).sort()).toEqual(['editable', 'global:chime']);
    const frequent = await request(app)
      .get(`/api/servers/${server._id}/soundboard?scope=frequent&limit=20`)
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(frequent.body.items.map((sound: Record<string, unknown>) => sound._id)).toEqual(['editable']);

    const unfavorite = await request(app)
      .delete(`/api/servers/${server._id}/soundboard/global:chime/favorite`)
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(unfavorite.status).toBe(200);
    expect(unfavorite.body.favorite).toBe(false);
  });

  it('başka sunucuya ait veya bilinmeyen ses favorisini reddeder', async () => {
    const otherServer = makeServer(owner._id);
    await db.servers.insert(otherServer);
    await db.soundboard.insert({ _id: 'other-sound', serverId: otherServer._id, name: 'Other', url: '/uploads/soundboard/o.wav', createdAt: 1 });
    for (const soundId of ['other-sound', 'missing']) {
      const res = await request(app)
        .put(`/api/servers/${server._id}/soundboard/${soundId}/favorite`)
        .set('Authorization', `Bearer ${token(member._id)}`);
      expect(res.status).toBe(404);
    }
    const outsiderFavorite = await request(app)
      .put(`/api/servers/${server._id}/soundboard/global:chime/favorite`)
      .set('Authorization', `Bearer ${token(outsider._id)}`);
    expect(outsiderFavorite.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════
// DELETE /api/servers/:sid/soundboard/:soundId
// ═══════════════════════════════════════════════════════
describe('DELETE /api/servers/:sid/soundboard/:soundId', () => {
  it('sunucu sahibi ses silebilir', async () => {
    // Create a real temp file to simulate uploaded sound
    const tmpFile = path.join(UPLOAD_DIR, 'sound_del.mp3');
    fs.writeFileSync(tmpFile, Buffer.alloc(64));
    await db.soundboard.insert({ _id: 'del1', serverId: server._id, name: 'to-delete', url: '/uploads/soundboard/sound_del.mp3', createdAt: Date.now() });
    await db.soundboardUserStats.insert({ _id: 'stat-del1', userId: member._id, soundId: 'del1', serverId: server._id, favorite: true, favoritedAt: 1, playCount: 1, lastPlayedAt: 1 });

    const res = await request(app)
      .delete(`/api/servers/${server._id}/soundboard/del1`)
      .set('Authorization', `Bearer ${token(owner._id)}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(await db.soundboardUserStats.findOne({ soundId: 'del1' })).toBeNull();
    expect(ioEmit).toHaveBeenCalledWith('soundboard:deleted', { serverId: server._id, soundId: 'del1' });
  });

  it('başka canlı referans varsa fiziksel nesneyi korur', async () => {
    const file = path.join(UPLOAD_DIR, 'shared.mp3');
    fs.writeFileSync(file, Buffer.alloc(16));
    await db.soundboard.insert({ _id: 'shared', serverId: server._id, name: 'shared', url: '/uploads/soundboard/shared.mp3', createdAt: 1 });
    pgPool().query.mockResolvedValueOnce({ rows: [{ referenced: true }] });
    const res = await request(app)
      .delete(`/api/servers/${server._id}/soundboard/shared`)
      .set('Authorization', `Bearer ${token(owner._id)}`);
    expect(res.status).toBe(200);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('referans sorgusu arızasını gözlemlenebilir orphan cleanup işine bırakır', async () => {
    const file = path.join(UPLOAD_DIR, 'cleanup-db-down.mp3');
    fs.writeFileSync(file, Buffer.alloc(16));
    await db.soundboard.insert({ _id: 'cleanup-db-down', serverId: server._id, name: 'cleanup', url: '/uploads/soundboard/cleanup-db-down.mp3', createdAt: 1 });
    pgPool().query.mockRejectedValueOnce(new Error('reference query unavailable'));
    const res = await request(app)
      .delete(`/api/servers/${server._id}/soundboard/cleanup-db-down`)
      .set('Authorization', `Bearer ${token(owner._id)}`);
    expect(res.status).toBe(200);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('eşzamanlı silmede canonical delete satır kazanamadıysa 404 döner ve dosyaya dokunmaz', async () => {
    const file = path.join(UPLOAD_DIR, 'raced.mp3');
    fs.writeFileSync(file, Buffer.alloc(16));
    await db.soundboard.insert({ _id: 'raced', serverId: server._id, name: 'raced', url: '/uploads/soundboard/raced.mp3', createdAt: 1 });
    const original = db.soundboard.remove;
    db.soundboard.remove = jest.fn().mockResolvedValue({ deleted: 0 });
    const res = await request(app)
      .delete(`/api/servers/${server._id}/soundboard/raced`)
      .set('Authorization', `Bearer ${token(owner._id)}`);
    expect(res.status).toBe(404);
    expect(fs.existsSync(file)).toBe(true);
    expect(ioEmit).not.toHaveBeenCalledWith('soundboard:deleted', expect.anything());
    db.soundboard.remove = original;
  });

  it('GÜVENLİK: fiziksel dosyayı yalnız DB referansı kaldırıldıktan sonra siler', async () => {
    await db.soundboard.insert({ _id: 'ordered-del', serverId: server._id, name: 'ordered', url: '/uploads/soundboard/ordered.mp3', createdAt: Date.now() });
    const order: string[] = [];
    const originalRemove = db.soundboard.remove.bind(db.soundboard);
    db.soundboard.remove = jest.fn(async (q) => { order.push('db'); return originalRemove(q); });
    const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    const unlinkSpy = jest.spyOn(fs, 'unlinkSync').mockImplementation(() => { order.push('file'); });

    const res = await request(app)
      .delete(`/api/servers/${server._id}/soundboard/ordered-del`)
      .set('Authorization', `Bearer ${token(owner._id)}`);

    expect(res.status).toBe(200);
    expect(order).toEqual(['db', 'file']);
    expect(await db.soundboard.findOne({ _id: 'ordered-del' })).toBeNull();
    unlinkSpy.mockRestore();
    existsSpy.mockRestore();
    db.soundboard.remove = originalRemove;
  });

  it('mevcut olmayan ses 404 döner', async () => {
    const res = await request(app)
      .delete(`/api/servers/${server._id}/soundboard/nonexistent`)
      .set('Authorization', `Bearer ${token(owner._id)}`);
    expect(res.status).toBe(404);
  });

  it('normal üye silemez', async () => {
    await db.soundboard.insert({ _id: 'del2', serverId: server._id, name: 'protected', url: '/uploads/soundboard/p.mp3', createdAt: Date.now() });
    const res = await request(app)
      .delete(`/api/servers/${server._id}/soundboard/del2`)
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(403);
  });
});
