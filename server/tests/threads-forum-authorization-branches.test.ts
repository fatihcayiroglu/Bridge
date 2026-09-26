// server/tests/threads-forum-authorization-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// THREAD / FORUM — GİRDİ SINIRI, KANAL GÖRÜNÜRLÜĞÜ VE LİSTE SIRALAMASI
// ════════════════════════════════════════════════════════════════════════════
//
// `threads.test.ts` izin çözümünü stub'lar ve mutlu yolu ölçer. Burada GERÇEK
// izin çözümleyicisi (kanal override'ları) kullanılır; ölçülmemiş dalların
// taşıdığı riskler şunlardır:
//
//   · GEÇMİŞ ERİŞİM HAKKI DEĞİLDİR — thread'e daha önce yazmış bir üye kanal
//     iznini kaybettiğinde yeni yanıt bildirimini ALMAMALIDIR; aksi hâlde
//     bildirim önizlemesi, artık göremediği kanalın içeriğini sızdırır.
//   · TEKRAR GÖNDERİM — HTTP yanıtı kaybolduğunda istemci aynı `clientNonce`
//     ile yeniden dener. İkinci istek sayaç artırmamalı ve ikinci bildirim
//     ÜRETMEMELİDİR.
//   · BOZUK GÖVDE/ETİKET — istek gövdesi dizi/metin olabilir, `tags` sütunu
//     bozuk JSON tutabilir. İkisi de 500 değil, tanımlı davranış üretmelidir.
//   · SIRALAMA — forum listesi sabitlenmişleri önce, sonra seçilen ölçüte göre
//     sıralar. Yanlış sıralama moderasyon duyurularını görünmez yapar.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV = 'test';

import request from 'supertest';
import express from 'express';
const jwt = require('jsonwebtoken');
import { requireDoc } from './helpers/mockDb';

let db: MockDb;
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/index', () => {
  const { createMockDb } = require('./helpers/mockDb');
  db = createMockDb();
  return db;
});
// `routes/roles` modul yuklenirken `limits.roles()` cagirir; bu suit hiz
// sinirini olcmedigi icin HER limit adi gecisli bir ara katmana cozulur.
jest.mock('../middleware/rateLimit', () => ({
  limits: new Proxy({}, { get: () => () => (_q: unknown, _s: unknown, n: () => void) => n() }),
  rateLimit: () => (_q: unknown, _s: unknown, n: () => void) => n(),
}));

const processNotifications = jest.fn().mockResolvedValue(undefined);
jest.mock('../lib/notifications', () => ({ processNotifications: (...a: unknown[]) => processNotifications(...a) }));

import { PERMS } from '../lib/permissions';
import threadsRouter from '../routes/threads';
import type { MockDb } from './helpers/mockDb';

const token = (id: string) => jwt.sign({ id, username: id, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });

const AUTHOR = 'thr-yazar';
const READER = 'thr-okur';
const DEMOTED = 'thr-eski-uye';
const SRV = 'thr-srv';
const FORUM = 'thr-forum';
const TEXT = 'thr-metin';
const HIDDEN = 'thr-gizli';

let app: express.Express;
let emitted: Array<{ room: string; event: string; payload: unknown }>;

beforeEach(async () => {
  const { createMockDb } = require('./helpers/mockDb');
  db = createMockDb();
  Object.assign(require('../db/index'), db);
  processNotifications.mockClear().mockResolvedValue(undefined);

  for (const id of [AUTHOR, READER, DEMOTED]) {
    await db.users.insert({ _id: id, username: id, displayName: id, avatarColor: id === AUTHOR ? '#ff0000' : undefined });
  }
  await db.servers.insert({ _id: SRV, name: 'Forum', ownerId: 'sahip', createdAt: 1 });
  for (const id of [AUTHOR, READER, DEMOTED]) {
    await db.members.insert({ userId: id, serverId: SRV, roles: [], joinedAt: 1 });
  }
  await db.channels.insert({ _id: FORUM, serverId: SRV, name: 'forum', type: 'forum', createdAt: 1 });
  await db.channels.insert({ _id: TEXT, serverId: SRV, name: 'genel', type: 'text', createdAt: 1 });
  await db.channels.insert({ _id: HIDDEN, serverId: SRV, name: 'gizli', type: 'forum', createdAt: 1 });
  await db.channelOverrides.insert({
    _id: 'ovr-thr-hidden', channelId: HIDDEN, targetType: 'everyone', targetId: SRV,
    allow: 0, deny: PERMS.VIEW_CHANNELS, position: 0,
  });

  emitted = [];
  app = express();
  app.use(express.json());
  app.set('io', { to: (room: string) => ({ emit: (event: string, payload: unknown) => { emitted.push({ room, event, payload }); } }) });
  app.set('socketUsers', new Map());
  app.use('/api/threads', threadsRouter);
  app.use((err: Error & { status?: number }, _q: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _n: unknown) => res.status(500).json({ error: err.message }));
});

afterEach(() => { jest.restoreAllMocks(); });

async function createForumThread(over: Record<string, unknown> = {}) {
  const now = Date.now();
  const row = {
    _id: `t-${Math.random().toString(36).slice(2, 10)}`,
    channelId: FORUM, serverId: SRV, parentMessageId: null,
    name: 'Konu', firstMessage: '', tags: '[]',
    createdBy: AUTHOR, createdAt: now, lastMessageAt: now,
    messageCount: 0, participantCount: 1, pinned: false, locked: false,
    ...over,
  };
  await db.threads.insert(row);
  return row;
}

describe('thread oluşturma girdi sınırı', () => {
  it('nesne olmayan gövde boş kabul edilir ve zorunlu alan hatası verir', async () => {
    const res = await request(app).post('/api/threads')
      .set('Authorization', `Bearer ${token(AUTHOR)}`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(['dizi', 'govde']));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('parentMessageId required');
  });

  it('geçersiz channelId biçimleri reddedilir', async () => {
    for (const channelId of [42, '', '   ', 'x'.repeat(129)]) {
      const res = await request(app).post('/api/threads')
        .set('Authorization', `Bearer ${token(AUTHOR)}`)
        .send({ channelId, name: 'Konu' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('channelId invalid');
    }
  });

  it('görünmeyen forum kanalında konu açılamaz', async () => {
    const res = await request(app).post('/api/threads')
      .set('Authorization', `Bearer ${token(READER)}`)
      .send({ channelId: HIDDEN, name: 'Gizli konu' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('No permission');
    expect(await db.threads.find({})).toHaveLength(0);
  });

  it('silinmiş kullanıcı kaydı konu açamaz', async () => {
    await db.users.remove({ _id: READER });

    const res = await request(app).post('/api/threads')
      .set('Authorization', `Bearer ${token(READER)}`)
      .send({ channelId: FORUM, name: 'Hayalet konu' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('User not found');
  });

  it('avatar rengi olmayan kullanıcı için varsayılan renk yazılır', async () => {
    const res = await request(app).post('/api/threads')
      .set('Authorization', `Bearer ${token(READER)}`)
      .send({ channelId: FORUM, name: 'Renk', firstMessage: 'ilk ileti' });

    expect(res.status).toBe(201);
    const messages = await db.threadMessages.find({ threadId: res.body.thread._id });
    expect(messages[0].avatarColor).toBe('#2d9cdb');
    expect(emitted).toContainEqual(expect.objectContaining({ room: `channel:${FORUM}`, event: 'forum:thread:created' }));
  });

  it('mesajdan açılan thread adı sırasıyla ad, mesaj içeriği ve sabit yedeğe düşer', async () => {
    await db.messages.insert({
      _id: 'm-uzun', channelId: TEXT, serverId: SRV, userId: AUTHOR,
      content: 'x'.repeat(120), type: 'normal', reactions: {}, createdAt: 1,
    });
    await db.messages.insert({
      _id: 'm-bos', channelId: TEXT, serverId: SRV, userId: AUTHOR,
      content: '', type: 'normal', reactions: {}, createdAt: 2,
    });

    const fromContent = await request(app).post('/api/threads')
      .set('Authorization', `Bearer ${token(AUTHOR)}`)
      .send({ parentMessageId: 'm-uzun', name: '   ' });
    expect(fromContent.status).toBe(200);
    expect(fromContent.body.name).toBe('x'.repeat(50));

    const fallback = await request(app).post('/api/threads')
      .set('Authorization', `Bearer ${token(AUTHOR)}`)
      .send({ parentMessageId: 'm-bos' });
    expect(fallback.body.name).toBe('Thread');
  });
});

describe('thread okuma yetkisi', () => {
  it('kanalı göremeyen üye thread detayını okuyamaz', async () => {
    const thread = await createForumThread({ channelId: HIDDEN, name: 'GIZLI-BASLIK' });

    const res = await request(app).get(`/api/threads/${thread._id}`)
      .set('Authorization', `Bearer ${token(READER)}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('No permission');
    expect(JSON.stringify(res.body)).not.toContain('GIZLI-BASLIK');
  });

  it('mesaj listesi sayfalama parametrelerini kabul eder', async () => {
    const thread = await createForumThread();
    for (let i = 0; i < 3; i += 1) {
      await db.threadMessages.insert({
        _id: `tm-${i}`, threadId: thread._id, channelId: FORUM, serverId: SRV,
        userId: AUTHOR, content: `ileti ${i}`, type: 'normal', reactions: {}, createdAt: 100 + i,
      });
    }

    const res = await request(app).get(`/api/threads/${thread._id}/messages?limit=2&before=103`)
      .set('Authorization', `Bearer ${token(AUTHOR)}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.messages ?? res.body)).toBe(true);
  });
});

describe('thread mesajı gönderme', () => {
  it('nesne olmayan gövde ve geçersiz nonce reddedilir', async () => {
    const thread = await createForumThread();

    const badBody = await request(app).post(`/api/threads/${thread._id}/messages`)
      .set('Authorization', `Bearer ${token(AUTHOR)}`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(['dizi']));
    expect(badBody.status).toBe(400);
    expect(badBody.body.error).toBe('content required');

    for (const clientNonce of [42, 'kisa', 'n'.repeat(129)]) {
      const res = await request(app).post(`/api/threads/${thread._id}/messages`)
        .set('Authorization', `Bearer ${token(AUTHOR)}`)
        .send({ content: 'merhaba', clientNonce });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('clientNonce invalid');
    }
  });

  it('silinmiş kullanıcı kaydı mesaj gönderemez', async () => {
    const thread = await createForumThread();
    await db.users.remove({ _id: READER });

    const res = await request(app).post(`/api/threads/${thread._id}/messages`)
      .set('Authorization', `Bearer ${token(READER)}`).send({ content: 'hayalet' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('User not found');
  });

  it('aynı nonce ile tekrar gönderim sayaç artırmaz ve ikinci bildirim üretmez', async () => {
    const thread = await createForumThread();
    const nonce = 'nonce-12345678';

    const first = await request(app).post(`/api/threads/${thread._id}/messages`)
      .set('Authorization', `Bearer ${token(AUTHOR)}`).send({ content: 'ilk', clientNonce: nonce });
    expect(first.status).toBe(200);
    const notificationsAfterFirst = processNotifications.mock.calls.length;
    const emittedAfterFirst = emitted.length;

    const retry = await request(app).post(`/api/threads/${thread._id}/messages`)
      .set('Authorization', `Bearer ${token(AUTHOR)}`).send({ content: 'ilk', clientNonce: nonce });

    expect(retry.status).toBe(200);
    expect(retry.body._id).toBe(first.body._id);
    expect(processNotifications.mock.calls).toHaveLength(notificationsAfterFirst);
    expect(emitted).toHaveLength(emittedAfterFirst);
    expect(await db.threadMessages.find({ threadId: thread._id })).toHaveLength(1);
  });

  it('nonce verilmezse kayda null yazılır ve her gönderim yeni mesajdır', async () => {
    const thread = await createForumThread();

    await request(app).post(`/api/threads/${thread._id}/messages`)
      .set('Authorization', `Bearer ${token(AUTHOR)}`).send({ content: 'bir' });
    await request(app).post(`/api/threads/${thread._id}/messages`)
      .set('Authorization', `Bearer ${token(AUTHOR)}`).send({ content: 'iki' });

    const rows = await db.threadMessages.find({ threadId: thread._id });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.clientNonce === null)).toBe(true);
  });

  it('izni kaybeden eski katılımcıya yanıt bildirimi gönderilmez', async () => {
    const thread = await createForumThread({ channelId: TEXT, createdBy: DEMOTED });
    await db.threadMessages.insert({
      _id: 'tm-eski', threadId: thread._id, channelId: TEXT, serverId: SRV,
      userId: DEMOTED, content: 'eski ileti', type: 'normal', reactions: {}, createdAt: 1,
    });
    await db.threadMessages.insert({
      _id: 'tm-okur', threadId: thread._id, channelId: TEXT, serverId: SRV,
      userId: READER, content: 'okur iletisi', type: 'normal', reactions: {}, createdAt: 2,
    });
    // DEMOTED artik bu kanali goremiyor.
    await db.channelOverrides.insert({
      _id: 'ovr-demoted', channelId: TEXT, targetType: 'user', targetId: DEMOTED,
      allow: 0, deny: PERMS.VIEW_CHANNELS, position: 1,
    });

    const res = await request(app).post(`/api/threads/${thread._id}/messages`)
      .set('Authorization', `Bearer ${token(AUTHOR)}`).send({ content: 'yeni yanıt' });

    expect(res.status).toBe(200);
    const notified = emitted.filter(e => e.event === 'notification:thread_reply').map(e => e.room);
    expect(notified).toContain(`user:${READER}`);
    expect(notified).not.toContain(`user:${DEMOTED}`);
  });

  it('bildirim hattı çökse bile mesaj kaydedilmiş sayılır', async () => {
    const thread = await createForumThread();
    processNotifications.mockRejectedValueOnce(new Error('notification store down'));

    const res = await request(app).post(`/api/threads/${thread._id}/messages`)
      .set('Authorization', `Bearer ${token(AUTHOR)}`).send({ content: 'kalıcı' });

    expect(res.status).toBe(200);
    expect(await db.threadMessages.find({ threadId: thread._id })).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain('notification store down');
  });

  it('kilitli thread\'e yazılamaz', async () => {
    const thread = await createForumThread({ locked: true });

    const res = await request(app).post(`/api/threads/${thread._id}/messages`)
      .set('Authorization', `Bearer ${token(AUTHOR)}`).send({ content: 'kilitli' });

    expect(res.status).toBe(423);
    expect(res.body.error).toBe('Thread is locked');
  });
});

describe('forum listesi filtre ve sıralama', () => {
  beforeEach(async () => {
    await createForumThread({ _id: 't-eski', name: 'Alfa duyuru', tags: JSON.stringify(['duyuru']), createdAt: 100, lastMessageAt: 100, messageCount: 9 });
    await createForumThread({ _id: 't-yeni', name: 'Beta soru', tags: JSON.stringify(['soru']), createdAt: 300, lastMessageAt: 150, messageCount: 1 });
    await createForumThread({ _id: 't-bozuk', name: 'Gama bozuk', tags: '{bozuk-json', createdAt: 200, lastMessageAt: 200, messageCount: 5 });
    await createForumThread({ _id: 't-sabit', name: 'Delta sabit', tags: JSON.stringify(['duyuru']), createdAt: 50, lastMessageAt: 50, messageCount: 0, pinned: true });
  });

  const list = (query = '') =>
    request(app).get(`/api/threads/channel/${FORUM}${query}`).set('Authorization', `Bearer ${token(AUTHOR)}`);

  it('olmayan kanal 404, görünmeyen kanal 403 verir', async () => {
    expect((await request(app).get('/api/threads/channel/yok').set('Authorization', `Bearer ${token(AUTHOR)}`)).status).toBe(404);
    expect((await request(app).get(`/api/threads/channel/${HIDDEN}`).set('Authorization', `Bearer ${token(AUTHOR)}`)).status).toBe(403);
  });

  it('etikete göre süzer ve bozuk etiket JSON\'u eşleşme dışı bırakır', async () => {
    const res = await list('?tag=duyuru');
    expect(res.status).toBe(200);
    expect(res.body.map((t: { _id: string }) => t._id).sort()).toEqual(['t-eski', 't-sabit']);
  });

  it('bozuk etiket JSON\'u listede boş dizi olarak sunulur', async () => {
    const res = await list();
    const broken = res.body.find((t: { _id: string }) => t._id === 't-bozuk');
    expect(broken.tags).toEqual([]);
  });

  it('başlığa göre harf duyarsız arar', async () => {
    const res = await list('?search=BETA');
    expect(res.body.map((t: { _id: string }) => t._id)).toEqual(['t-yeni']);
  });

  it('sabitlenmiş her zaman başta; ölçüt top/new/latest arasında değişir', async () => {
    const top = await list('?sort=top');
    expect(top.body.map((t: { _id: string }) => t._id)).toEqual(['t-sabit', 't-eski', 't-bozuk', 't-yeni']);

    const fresh = await list('?sort=new');
    expect(fresh.body.map((t: { _id: string }) => t._id)).toEqual(['t-sabit', 't-yeni', 't-bozuk', 't-eski']);

    const latest = await list();
    expect(latest.body.map((t: { _id: string }) => t._id)).toEqual(['t-sabit', 't-bozuk', 't-yeni', 't-eski']);
  });

  // ══════════════════════════════════════════════════════════════════════
  // Final21 Faz 17 — SÜTUNLARI OLMAYAN ESKİ SATIRLAR
  // ══════════════════════════════════════════════════════════════════════
  // `tags`, `messageCount` ve `lastMessageAt` forum özelliğinden ÖNCE yazılmış
  // satırlarda yoktur. Sıralama karşılaştırmaları bu alanları doğrudan okusaydı
  // `undefined` ile aritmetik NaN üretir ve liste sırası RASTGELE olurdu; etiket
  // ayrıştırması da atardı. Bu yedeklerin hiçbiri ölçülmemişti.
  it('alanları eksik eski satırlar listeyi bozmadan, öngörülebilir sırada gelir', async () => {
    await createForumThread({
      _id: 't-eski', name: 'Eski konu',
      tags: null as unknown as string, messageCount: undefined as unknown as number,
      lastMessageAt: undefined as unknown as number, createdAt: 400,
    });

    for (const query of ['', '?sort=top', '?sort=new']) {
      const res = await list(query);
      expect(res.status).toBe(200);
      const legacy = (res.body as Array<{ _id: string; tags: unknown }>).find((t) => t._id === 't-eski');
      // Etiketi olmayan satır BOŞ liste taşır — `null` ya da çökme değil.
      expect(legacy?.tags).toEqual([]);
      // Ve sıra kararlıdır: sabitlenmiş konu her ölçütte hâlâ başta.
      expect((res.body as Array<{ _id: string }>)[0]._id).toBe('t-sabit');
    }
  });

  it('en yeni ölçütünde eski satır kendi oluşturma zamanına göre yerleşir', async () => {
    await createForumThread({
      _id: 't-eski2', name: 'Eski konu 2',
      tags: null as unknown as string, lastMessageAt: undefined as unknown as number, createdAt: 900,
    });

    const res = await list('');
    const ids = (res.body as Array<{ _id: string }>).map((t) => t._id);
    // `lastMessageAt` yoksa `createdAt` kullanılır; 900 diğerlerinin hepsinden yenidir.
    expect(ids.indexOf('t-eski2')).toBe(1);   // yalnız sabitlenmiş konunun ardında
  });
  it('moderasyon yetkisi başlıkla bildirilir', async () => {
    const withoutManage = await list();
    expect(withoutManage.headers['x-bridge-forum-can-manage']).toBe('0');

    await db.channelOverrides.insert({
      _id: 'ovr-manage', channelId: FORUM, targetType: 'user', targetId: AUTHOR,
      allow: PERMS.MANAGE_MESSAGES, deny: 0, position: 1,
    });
    const withManage = await list();
    expect(withManage.headers['x-bridge-forum-can-manage']).toBe('1');
  });
});

describe('sabitleme, kilitleme ve güncelleme', () => {
  it('moderasyon yetkisi olmayan sabitleyemez ve kilitleyemez', async () => {
    const thread = await createForumThread();

    expect((await request(app).patch(`/api/threads/${thread._id}/pin`)
      .set('Authorization', `Bearer ${token(READER)}`).send({ pinned: true })).status).toBe(403);
    expect((await request(app).patch(`/api/threads/${thread._id}/lock`)
      .set('Authorization', `Bearer ${token(READER)}`).send({ locked: true })).status).toBe(403);
  });

  it('yetkili sabitleme ve kilitleme kanala yayınlanır', async () => {
    const thread = await createForumThread();
    await db.channelOverrides.insert({
      _id: 'ovr-mod', channelId: FORUM, targetType: 'user', targetId: AUTHOR,
      allow: PERMS.MANAGE_MESSAGES, deny: 0, position: 1,
    });

    const pin = await request(app).patch(`/api/threads/${thread._id}/pin`)
      .set('Authorization', `Bearer ${token(AUTHOR)}`).send({ pinned: true });
    expect(pin.status).toBe(200);
    expect(pin.body).toEqual({ ok: true, pinned: 1 });

    const lock = await request(app).patch(`/api/threads/${thread._id}/lock`)
      .set('Authorization', `Bearer ${token(AUTHOR)}`).send({ locked: true });
    expect(lock.status).toBe(200);
    expect(lock.body).toEqual({ ok: true, locked: 1 });

    expect(emitted.filter(e => e.event === 'forum:thread:updated')).toEqual([
      { room: `channel:${FORUM}`, event: 'forum:thread:updated', payload: { threadId: thread._id, pinned: 1 } },
      { room: `channel:${FORUM}`, event: 'forum:thread:updated', payload: { threadId: thread._id, locked: 1 } },
    ]);
  });

  it('boolean olmayan sabitleme/kilitleme değeri reddedilir', async () => {
    const thread = await createForumThread();
    await db.channelOverrides.insert({
      _id: 'ovr-mod2', channelId: FORUM, targetType: 'user', targetId: AUTHOR,
      allow: PERMS.MANAGE_MESSAGES, deny: 0, position: 1,
    });

    expect((await request(app).patch(`/api/threads/${thread._id}/pin`)
      .set('Authorization', `Bearer ${token(AUTHOR)}`).send({ pinned: 'evet' })).body.error).toBe('pinned must be boolean');
    expect((await request(app).patch(`/api/threads/${thread._id}/lock`)
      .set('Authorization', `Bearer ${token(AUTHOR)}`).send({ locked: 1 })).body.error).toBe('locked must be boolean');
  });

  it('olmayan thread güncellenemez; sahibi olmayan üye de güncelleyemez', async () => {
    const missing = await request(app).patch('/api/threads/yok-boyle')
      .set('Authorization', `Bearer ${token(AUTHOR)}`).send({ name: 'Yeni' });
    expect(missing.status).toBe(404);

    const thread = await createForumThread();
    const forbidden = await request(app).patch(`/api/threads/${thread._id}`)
      .set('Authorization', `Bearer ${token(READER)}`).send({ name: 'Yeni' });
    expect(forbidden.status).toBe(403);
    expect((await requireDoc(db.threads, { _id: thread._id })).name).toBe('Konu');
  });

  it('thread sahibi kendi başlığını güncelleyebilir', async () => {
    const thread = await createForumThread();

    const res = await request(app).patch(`/api/threads/${thread._id}`)
      .set('Authorization', `Bearer ${token(AUTHOR)}`).send({ name: '  Güncel başlık  ' });

    expect(res.status).toBe(200);
    expect((await requireDoc(db.threads, { _id: thread._id })).name).toBe('Güncel başlık');
  });
});
