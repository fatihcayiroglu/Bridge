// server/tests/activity-broadcast-and-expiry-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// AKTİVİTE — DOĞRULAMA, YAYIN KAPSAMI VE BAYAT KAYIT TEMİZLİĞİ
// ════════════════════════════════════════════════════════════════════════════
//
// Aktivite ("şunu oynuyor / şunu dinliyor") bir GÖRÜNÜRLÜK yüzeyidir ve yalnız
// kullanıcının üye olduğu sunuculara yayılır. Ölçülmemiş dallar:
//
//   · YAYIN KAPSAMI — güncelleme yalnız ÜYE olunan sunuculara gitmelidir;
//     kapsam yanlış hesaplanırsa kullanıcının ne yaptığı yabancılara sızar.
//   · BAYAT KAYIT — 4 saatten eski aktivite gösterilmemeli, okunduğunda
//     temizlenmelidir; aksi hâlde kullanıcı günlerce "oyunda" görünür.
//   · DOĞRULAMA — tip/ad/detay sınırları aşıldığında kayıt YAZILMAMALI;
//     emoji verilmezse tipe göre türetilmelidir.
//   · IO YOKLUĞU — yayın katmanı yoksa istek yine başarıyla tamamlanmalıdır.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV = 'test';

import { createMockDb, makeServer, makeUser, requireDoc } from './helpers/mockDb';
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
    try { req.user = require('jsonwebtoken').verify(h.slice(7), 'test-jwt-secret-long-enough-32chars!!'); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
  },
}));
jest.mock('../middleware/rateLimit', () => ({
  limits: new Proxy({}, { get: () => () => (_req: unknown, _res: unknown, next: () => void) => next() }),
}));

const cacheStore: Record<string, unknown> = {};
jest.mock('../lib/redisAdapter', () => ({
  redisClient: () => null,
  subscribeToChannel: async () => undefined,
  cache: {
    invalidatePattern: jest.fn().mockResolvedValue(undefined),
    get: async (k: string) => cacheStore[k] ?? null,
    set: async (k: string, v: unknown) => { cacheStore[k] = v; },
    del: async (k: string) => { delete cacheStore[k]; },
    delete: async (k: string) => { delete cacheStore[k]; },
  },
}));
jest.mock('../lib/contentSanitizer', () => ({
  sanitizeMessageContent: (v: unknown) => String(v ?? ''),
  sanitizeDisplayName: (v: unknown) => String(v ?? ''),
  sanitizeTitle: (v: unknown) => String(v ?? ''),
  sanitizeActivityPubContent: (v: unknown) => String(v ?? ''),
  sanitizeUrl: (v: unknown) => (typeof v === 'string' ? v : null),
  isCleanString: (v: unknown) => typeof v === 'string',
}));

let ioHandle: { to: (rooms: string[]) => { emit: (event: string, payload: unknown) => void } } | null = null;
const broadcasts: Array<{ rooms: string[]; event: string; payload: unknown }> = [];
jest.mock('../socket', () => ({ getIo: () => ioHandle }));

import request from 'supertest';
import express from 'express';
const jwt = require('jsonwebtoken');

import { router } from '../routes/activity';

const app = express();
app.use(express.json());
app.use('/api/activity', router);
app.use((err: Error & { status?: number }, _q: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _n: unknown) => res.status(err.status || 500).json({ error: err.message }));

const token = (id: string) => jwt.sign({ id, username: id, displayName: id, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });

const ME = 'act-me';
const OTHER = 'act-other';
const SRV_A = 'act-srv-a';
const SRV_B = 'act-srv-b';
const HOUR = 3_600_000;

function liveIo() {
  return {
    to(rooms: string[]) {
      return { emit(event: string, payload: unknown) { broadcasts.push({ rooms, event, payload }); } };
    },
  };
}

beforeAll(async () => {
  await mockDb.users.insert(makeUser({ _id: ME, username: 'ben' }));
  await mockDb.users.insert(makeUser({ _id: OTHER, username: 'oteki', displayName: '' }));
  await mockDb.servers.insert(makeServer(ME, { _id: SRV_A }));
  await mockDb.servers.insert(makeServer(ME, { _id: SRV_B }));
  await mockDb.members.insert({ userId: ME, serverId: SRV_A, roles: '[]', joinedAt: 1 });
  await mockDb.members.insert({ userId: ME, serverId: SRV_B, roles: '[]', joinedAt: 1 });
  await mockDb.members.insert({ userId: OTHER, serverId: SRV_A, roles: '[]', joinedAt: 1 });
});

beforeEach(async () => {
  broadcasts.length = 0;
  ioHandle = liveIo();
  for (const key of Object.keys(cacheStore)) delete cacheStore[key];
  await mockDb.users.update({ _id: ME }, { $set: { activity: null, activityUpdatedAt: null } });
  await mockDb.users.update({ _id: OTHER }, { $set: { activity: null, activityUpdatedAt: null } });
});

const patch = (body: unknown, id = ME) =>
  request(app).patch('/api/activity').set('Authorization', `Bearer ${token(id)}`).send(body as never);

describe('aktivite doğrulaması', () => {
  it('metin olmayan alanlar açık bir hata ile reddedilir', async () => {
    for (const field of ['type', 'name', 'detail', 'url', 'emoji']) {
      const res = await patch({ name: 'Bridge', [field]: 42 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(`${field} must be a string`);
    }
    expect((await requireDoc(mockDb.users, { _id: ME })).activity).toBeFalsy();
  });

  it('tanınmayan tip geçerli tip listesiyle birlikte reddedilir', async () => {
    const res = await patch({ type: 'uydurma', name: 'X' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid activity type');
    expect(Array.isArray(res.body.valid)).toBe(true);
    expect(res.body.valid).toContain('playing');
  });

  it('ad ve detay uzunluk sınırları uygulanır', async () => {
    expect((await patch({ name: 'x'.repeat(65) })).body.error).toBe('name max 64 chars');
    expect((await patch({ name: 'ok', detail: 'y'.repeat(129) })).body.error).toBe('detail max 128 chars');
    // Tam sinirda kabul edilir.
    expect((await patch({ name: 'x'.repeat(64), detail: 'y'.repeat(128) })).status).toBe(200);
  });

  it('tip verilmezse "custom" olur ve emoji tipten türetilir', async () => {
    const custom = await patch({ name: 'Serbest' });
    expect(custom.body.activity).toMatchObject({ type: 'custom', emoji: '✏️', name: 'Serbest' });

    const coding = await patch({ type: 'coding', name: 'Bridge' });
    expect(coding.body.activity).toMatchObject({ type: 'coding', emoji: '💻' });

    const explicit = await patch({ type: 'coding', name: 'Bridge', emoji: '  🚀  ' });
    expect(explicit.body.activity.emoji).toBe('🚀');
  });

  it('boşluklar kırpılır ve URL korunur', async () => {
    const res = await patch({ type: 'listening', name: '  Şarkı  ', detail: '  Sanatçı ', url: ' https://bridge.test/x ' });

    expect(res.body.activity).toMatchObject({ name: 'Şarkı', detail: 'Sanatçı', url: 'https://bridge.test/x' });
  });
});

describe('yayın kapsamı', () => {
  it('güncelleme yalnız üye olunan sunuculara yayılır', async () => {
    const res = await patch({ type: 'playing', name: 'Satranç' });

    expect(res.status).toBe(200);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]!.event).toBe('user:activity');
    expect([...broadcasts[0]!.rooms].sort()).toEqual([SRV_A, SRV_B]);
    expect(broadcasts[0]!.payload).toMatchObject({ userId: ME, activity: { name: 'Satranç' } });
  });

  it('temizleme de aynı kapsama null aktivite yayınlar', async () => {
    await patch({ type: 'playing', name: 'Satranç' });
    broadcasts.length = 0;

    const res = await patch({});

    expect(res.body).toEqual({ activity: null });
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]!.payload).toEqual({ userId: ME, activity: null });
    expect(cacheStore[`activity:${ME}`]).toBeUndefined();
  });

  it('yalnız bir sunucunun üyesi olan kullanıcı yalnız oraya yayın yapar', async () => {
    await patch({ type: 'playing', name: 'Satranç' }, OTHER);

    expect(broadcasts[0]!.rooms).toEqual([SRV_A]);
  });

  it('yayın katmanı yoksa istek yine başarıyla tamamlanır', async () => {
    ioHandle = null;

    const res = await patch({ type: 'playing', name: 'Satranç' });

    expect(res.status).toBe(200);
    expect(broadcasts).toHaveLength(0);
    expect((await requireDoc(mockDb.users, { _id: ME })).activity).toBeTruthy();
  });

  it('yayın çökerse istek yine başarılı sayılır', async () => {
    ioHandle = { to() { throw new Error('io down'); } } as never;

    const res = await patch({ type: 'playing', name: 'Satranç' });

    expect(res.status).toBe(200);
    expect((await requireDoc(mockDb.users, { _id: ME })).activity).toBeTruthy();
  });
});

describe('okuma ve bayat kayıt temizliği', () => {
  it('önbellekteki kayıt işaretlenerek döner', async () => {
    await patch({ type: 'playing', name: 'Satranç' });

    const res = await request(app).get(`/api/activity/${ME}`).set('Authorization', `Bearer ${token(ME)}`);

    expect(res.body.cached).toBe(true);
    expect(res.body.activity).toMatchObject({ name: 'Satranç' });
  });

  it('4 saatten eski aktivite okunurken temizlenir', async () => {
    await mockDb.users.update({ _id: OTHER }, {
      $set: { activity: { type: 'playing', name: 'Eski' }, activityUpdatedAt: Date.now() - 5 * HOUR },
    });

    const res = await request(app).get(`/api/activity/${OTHER}`).set('Authorization', `Bearer ${token(ME)}`);

    expect(res.body).toEqual({ activity: null });
    expect((await requireDoc(mockDb.users, { _id: OTHER })).activity).toBeNull();
  });

  it('4 saatten yeni aktivite korunur', async () => {
    await mockDb.users.update({ _id: OTHER }, {
      $set: { activity: { type: 'playing', name: 'Taze' }, activityUpdatedAt: Date.now() - 1 * HOUR },
    });

    const res = await request(app).get(`/api/activity/${OTHER}`).set('Authorization', `Bearer ${token(ME)}`);

    expect(res.body.activity).toMatchObject({ name: 'Taze' });
    expect(res.body.cached).toBeUndefined();
  });

  it('zaman damgası olmayan kayıt yaş denetimine girmez', async () => {
    await mockDb.users.update({ _id: OTHER }, {
      $set: { activity: { type: 'playing', name: 'Damgasız' }, activityUpdatedAt: null },
    });

    const res = await request(app).get(`/api/activity/${OTHER}`).set('Authorization', `Bearer ${token(ME)}`);

    expect(res.body.activity).toMatchObject({ name: 'Damgasız' });
  });

  it('aktivitesi olmayan kullanıcı için null döner', async () => {
    const res = await request(app).get(`/api/activity/${OTHER}`).set('Authorization', `Bearer ${token(ME)}`);

    expect(res.body).toEqual({ activity: null });
  });
});

describe('sunucu aktivite listesi', () => {
  it('yalnız taze aktiviteler listelenir ve görünen ad kullanıcı adına düşer', async () => {
    await mockDb.users.update({ _id: ME }, {
      $set: { activity: { type: 'coding', name: 'Bridge' }, activityUpdatedAt: Date.now() - 1_000 },
    });
    await mockDb.users.update({ _id: OTHER }, {
      $set: { activity: { type: 'playing', name: 'Eski' }, activityUpdatedAt: Date.now() - 5 * HOUR },
    });

    const res = await request(app).get(`/api/activity/server/${SRV_A}`).set('Authorization', `Bearer ${token(ME)}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.active[0]).toMatchObject({ userId: ME, activity: { name: 'Bridge' } });
  });

  it('görünen adı olmayan üye kullanıcı adıyla listelenir', async () => {
    await mockDb.users.update({ _id: OTHER }, {
      $set: { activity: { type: 'coding', name: 'X' }, activityUpdatedAt: Date.now() - 1_000 },
    });

    const res = await request(app).get(`/api/activity/server/${SRV_A}`).set('Authorization', `Bearer ${token(OTHER)}`);

    const row = res.body.active.find((entry: { userId: string }) => entry.userId === OTHER);
    expect(row.displayName).toBe('oteki');
  });

  it('üye olmayan sunucunun listesini göremez', async () => {
    const res = await request(app).get(`/api/activity/server/${SRV_B}`).set('Authorization', `Bearer ${token(OTHER)}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Not a member');
  });
});
