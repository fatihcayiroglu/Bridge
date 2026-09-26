// server/tests/messages-permission-resolution-failure.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// İZİN ÇÖZÜMLEMESİ ÇÖKERSE MESAJ UÇLARI FAIL-CLOSED OLMALI
// ════════════════════════════════════════════════════════════════════════════
//
// `routes/messages.ts` içindeki HER yetki okuması `.catch(() => 0)` ile
// sarılıdır. Bu, "izin sunucusu/DB cevap veremiyor" durumunu SIFIR YETKİ
// olarak yorumlar. Sarmalayıcı yanlış yazılsaydı (örneğin `.catch(() => -1)`
// ya da hiç catch olmasaydı) iki ayrı üretim kusuru doğardı:
//
//   · Yakalanmayan reddetme → 500 ve isteğin YARIM kalması,
//   · Yanlış varsayılan → izin çözümlenemezken İZİN VERİLMESİ.
//
// Bu süit her uçta o sözleşmeyi ölçer: yetki okunamıyorsa istek 403/404 ile
// reddedilir, hiçbir mutasyon veri tabanına ULAŞMAZ ve arka uç ayrıntısı
// (hata mesajı/stack) istemciye SIZMAZ.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

import { createMockDb, requireDoc } from './helpers/mockDb';
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
jest.mock('../lib/redisAdapter', () => ({
  ...jest.requireActual('../lib/redisAdapter'),
  cache: {
    invalidatePattern: jest.fn().mockResolvedValue(undefined),
    get: async () => null, set: async () => undefined, del: async () => undefined,
  },
}));

// Yetki cozumleyicisinin KENDISI sinirdir; `hasPermission`/`PERMS` gercektir.
type Behaviour = number | 'reject';
const behaviours: Behaviour[] = [];
let defaultBehaviour: Behaviour = 0;
const resolveSpy = jest.fn(async () => {
  const next = behaviours.length ? behaviours.shift()! : defaultBehaviour;
  if (next === 'reject') throw new Error('permission store offline: pg 10.1.2.3:5432');
  return next;
});
jest.mock('../lib/permissions', () => ({
  ...jest.requireActual('../lib/permissions'),
  resolvePermissions: (...args: unknown[]) => resolveSpy(...(args as [])),
}));

import request from 'supertest';
import express from 'express';
const jwt = require('jsonwebtoken');

import { PERMS } from '../lib/permissions';
import messagesRouter from '../routes/messages';

const app = express();
app.use(express.json());
app.use('/api/channels', messagesRouter);
app.use('/api/messages', messagesRouter);
app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(err.status || 500).json({ error: err.message }));

const tok = (id: string) => jwt.sign({ id, username: id, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });

const USER  = 'perm-fail-user';
const OTHER = 'perm-fail-other';
const SRV   = 'perm-fail-srv';
const CH    = 'perm-fail-ch';
const MINE  = 'perm-fail-msg-mine';
const THEIRS = 'perm-fail-msg-theirs';
const BULK_A = 'perm-fail-bulk-a';

const ALL = PERMS.VIEW_CHANNELS | PERMS.READ_HISTORY | PERMS.MANAGE_MESSAGES | PERMS.ADD_REACTIONS;

beforeAll(async () => {
  await mockDb.users.insert({ _id: USER, username: USER, displayName: 'Perm' });
  await mockDb.users.insert({ _id: OTHER, username: OTHER, displayName: 'Other' });
  await mockDb.servers.insert({ _id: SRV, name: 'Perm', ownerId: 'sahip', createdAt: 1 });
  await mockDb.members.insert({ userId: USER, serverId: SRV, roles: [], joinedAt: 1 });
  await mockDb.channels.insert({ _id: CH, serverId: SRV, name: 'genel', type: 'text', createdAt: 1 });

  await mockDb.messages.insert({
    _id: MINE, channelId: CH, serverId: SRV, userId: USER, content: 'benim',
    type: 'normal', reactions: {}, pinned: 1, editHistory: [{ content: 'eski', editedAt: 5 }], createdAt: 1000,
  });
  await mockDb.messages.insert({
    _id: THEIRS, channelId: CH, serverId: SRV, userId: OTHER, content: 'baskasinin',
    type: 'normal', reactions: {}, pinned: 0, editHistory: [], createdAt: 1001,
  });
  await mockDb.messages.insert({
    _id: BULK_A, channelId: CH, serverId: SRV, userId: OTHER, content: 'toplu',
    type: 'normal', reactions: {}, pinned: 0, editHistory: [], createdAt: 1002,
  });
});

beforeEach(() => {
  behaviours.length = 0;
  defaultBehaviour = ALL;
  resolveSpy.mockClear();
});

/** Hiçbir yanıt gövdesi arka uç ayrıntısını taşımamalı. */
function expectNoBackendLeak(body: unknown): void {
  const text = JSON.stringify(body ?? {});
  expect(text).not.toMatch(/offline|pg |10\.1\.2\.3|5432|Error:/i);
}

describe('kanal görünürlüğü yetkisi okunamadığında', () => {
  it('sabitlenmiş mesajlar tam içerikle sızmaz, 403 döner', async () => {
    behaviours.push('reject');
    const res = await request(app).get(`/api/channels/${CH}/pinned`).set('Authorization', `Bearer ${tok(USER)}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Bu kanalı görüntüleyemezsiniz.');
    expect(JSON.stringify(res.body)).not.toContain('benim');
    expectNoBackendLeak(res.body);
    expect(resolveSpy).toHaveBeenCalledTimes(1);
  });

  it('yetki okunabildiğinde aynı uç normal çalışır (kontrol grubu)', async () => {
    const res = await request(app).get(`/api/channels/${CH}/pinned`).set('Authorization', `Bearer ${tok(USER)}`);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('benim');
  });
});

describe('toplu silmede yetki okunamadığında', () => {
  it('sunucu düzeyi yetki çözümlenemezse hiçbir mesaj silinmez', async () => {
    behaviours.push('reject');
    const res = await request(app).delete('/api/messages/bulk')
      .set('Authorization', `Bearer ${tok(USER)}`)
      .send({ ids: [BULK_A], serverId: SRV });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('MANAGE_MESSAGES permission required for bulk delete');
    expectNoBackendLeak(res.body);
    expect((await mockDb.messages.findOne({ _id: BULK_A }))?.deletedAt).toBeFalsy();
  });

  it('kanal düzeyi yetki çözümlenemezse sunucu yetkisi yeterli sayılmaz', async () => {
    behaviours.push(ALL);      // sunucu tabani okunabildi
    behaviours.push('reject'); // kanal kapsami okunamadi
    const res = await request(app).delete('/api/messages/bulk')
      .set('Authorization', `Bearer ${tok(USER)}`)
      .send({ ids: [BULK_A], serverId: SRV });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('No moderation permission in one or more target channels');
    expectNoBackendLeak(res.body);
    expect(resolveSpy).toHaveBeenCalledTimes(2);
    expect((await mockDb.messages.findOne({ _id: BULK_A }))?.deletedAt).toBeFalsy();
  });
});

describe('tekil mesaj eylemlerinde yetki okunamadığında', () => {
  it('başkasının mesajı silinemez ve kayıt korunur', async () => {
    // Final21 Phase 16: silme artik lib/messageMutations.ts'te. Gorunurluk canViewChannel'in
    // KENDI (fail-closed) cozumlemesiyle belirlenir; silme karari TEK resolvePermissions
    // okumasidir ve o okuma basarisizsa silme REDDEDILMELIDIR.
    behaviours.push('reject'); // silme yetkisi okunamadi
    const res = await request(app).delete(`/api/messages/${THEIRS}`).set('Authorization', `Bearer ${tok(USER)}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Not your message');
    expectNoBackendLeak(res.body);
    expect((await mockDb.messages.findOne({ _id: THEIRS }))?.deletedAt).toBeFalsy();
  });

  it('kendi mesajının sahipliği yetkiye bağlı değildir; yetki okunamasa da silinebilir', async () => {
    behaviours.push(ALL);
    behaviours.push('reject');
    const res = await request(app).delete(`/api/messages/${MINE}`).set('Authorization', `Bearer ${tok(USER)}`);

    // Sahiplik yetkiden BAGIMSIZ bir haktir: fail-closed burada kullaniciyi
    // kendi mesajindan etmez.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, id: MINE });
  });

  it('düzenleme geçmişi yetkisi okunamazsa geçmiş de güncel içerik de dönmez', async () => {
    behaviours.push(ALL);
    behaviours.push('reject');
    const res = await request(app).get(`/api/messages/${THEIRS}/history`).set('Authorization', `Bearer ${tok(USER)}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('No permission to read message history');
    expect(JSON.stringify(res.body)).not.toContain('baskasinin');
    expectNoBackendLeak(res.body);
  });

  it('reaksiyon yetkisi okunamazsa tepki yazılmaz', async () => {
    behaviours.push(ALL);
    behaviours.push('reject');
    const res = await request(app).post(`/api/messages/${THEIRS}/react`)
      .set('Authorization', `Bearer ${tok(USER)}`).send({ emoji: '👍' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('ADD_REACTIONS permission required');
    expectNoBackendLeak(res.body);
    const stored = await mockDb.messages.findOne({ _id: THEIRS });
    expect(stored?.reactions ?? {}).toEqual({});
  });

  it('şikâyet ucunda yetki okunamazsa mesajın varlığı bile doğrulanmaz', async () => {
    behaviours.push('reject');
    const res = await request(app).post(`/api/messages/${THEIRS}/report`)
      .set('Authorization', `Bearer ${tok(USER)}`).send({ reason: 'spam' });

    // Var/yok ayrimi sizdirilmez: gorulemeyen mesaj "yok" gibi cevaplanir.
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Message not available');
    expectNoBackendLeak(res.body);
    expect(await mockDb.messageReports.findOne({ messageId: THEIRS })).toBeFalsy();
  });
});
