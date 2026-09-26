// server/tests/blocks-enforcement.test.ts
//
// ENGEL, ARKADAŞLIK İSTEĞİNDE DE UYGULANIR
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK BOŞLUK
// ════════════════════════════════════════════════════════════════════════════
// `SocialRepository` engelleme için dört yöntem taşıyordu — `findBlock`,
// `findBlocksByUser`, `insertBlock`, `removeBlock` — ve `findBlock` GERÇEKTEN
// uygulanıyordu:
//
//   · socket/handlers/dm.ts → `dm:send`       (iki yönlü engel denetimi)
//   · socket/handlers/dm.ts → `dm:call:start` (engel denetimi)
//
// Ancak `insertBlock` ve `removeBlock` HİÇBİR rotadan çağrılmıyordu. Yani
// engelleme UYGULANIYOR ama OLUŞTURULAMIYORDU: `blocks` tablosu yapısı gereği
// her zaman boş kalır ve güvenlik özelliği kullanılamaz durumdaydı.
//
// İkinci boşluk: arkadaşlık isteği engeli HİÇ denetlemiyordu. Engellenen kişi
// hedefe istek göndermeye devam edebiliyordu — engellemenin amacını doğrudan
// boşa çıkaran bir taciz yolu.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

import { createMockDb, requireDoc } from './helpers/mockDb';
const mockDb = createMockDb();

jest.mock('../db/index', () => mockDb);
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/repositories', () => ({
  Users: {
    findById:       async (id: string) => mockDb.users.findOne({ _id: id }),
    findByUsername: async (username: string) => mockDb.users.findOne({ username }),
    findByIds:      async (ids: string[]) => {
      const out = [];
      for (const id of ids || []) {
        const u = await mockDb.users.findOne({ _id: id });
        if (u) out.push(u);
      }
      return out;
    },
  },
  Social: {
    findBlock:        async (blockerId: string, blockedId: string) => mockDb.blocks.findOne({ blockerId, blockedId }),
    findBlocksByUser: async (blockerId: string) => mockDb.blocks.find({ blockerId }),
    findBlocksInvolvingUser: async (userId: string) => mockDb.blocks.find({ $or: [{ blockerId: userId }, { blockedId: userId }] }),
    insertBlock:      async (blockerId: string, blockedId: string) =>
      mockDb.blocks.insert({ blockerId, blockedId, createdAt: Date.now() }),
    removeBlock:      async (blockerId: string, blockedId: string) => mockDb.blocks.remove({ blockerId, blockedId }),
    findFriendshipById: async (id: string) => mockDb.friendships.findOne({ _id: id }),
    findFriendship:   async (userId: string, otherId: string) => mockDb.friendships.findOne({
      $or: [{ userId, friendId: otherId }, { userId: otherId, friendId: userId }],
    }),
    findFriendships: async (userId: string) => mockDb.friendships.find({
      $or: [{ userId }, { friendId: userId }],
    }),
    createFriendship: async (userId: string, friendId: string) =>
      mockDb.friendships.insert({ userId, friendId, status: 'pending', createdAt: Date.now() }),
    acceptFriendship: async (id: string) => mockDb.friendships.update({ _id: id }, { $set: { status: 'accepted' } }),
    removeFriendship: async (id: string) => mockDb.friendships.remove({ _id: id }),
  },
}));

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

import request from 'supertest';
import express from 'express';
const jwt = require('jsonwebtoken');

import { Social } from '../db/repositories';
import friendsRouter from '../routes/friends';

const app = express();
app.use(express.json());
app.use('/api/friends', friendsRouter);

const tok = (id: string) => jwt.sign({ id, username: id, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });

const ALICE = 'u-alice';
const BOB   = 'u-bob';
const CAROL = 'u-carol';

const as = (user: string) => ({ Authorization: `Bearer ${tok(user)}` });

beforeAll(async () => {
  await mockDb.users.insert({ _id: ALICE, username: 'alice', displayName: 'Alice', email: 'a@x.test', password: 'hash' });
  await mockDb.users.insert({ _id: BOB,   username: 'bob',   displayName: 'Bob',   email: 'b@x.test', password: 'hash' });
  await mockDb.users.insert({ _id: CAROL, username: 'carol', displayName: 'Carol', email: 'c@x.test', password: 'hash' });
});

afterEach(async () => {
  for (const b of await mockDb.blocks.find({})) await mockDb.blocks.remove({ _id: b._id });
  for (const f of await mockDb.friendships.find({})) await mockDb.friendships.remove({ _id: f._id });
});

// ════════════════════════════════════════════════════════════════════════════
describe('engel ARKADAŞLIK İSTEĞİNDE de uygulanır', () => {
  it('engellediğim kişi bana istek GÖNDEREMEZ', async () => {
    await request(app).post('/api/friends/blocks').set(as(ALICE)).send({ userId: BOB });

    const res = await request(app).post('/api/friends/request').set(as(BOB)).send({ username: 'alice' });

    expect(res.status).toBe(409);
    expect(await mockDb.friendships.findOne({ userId: BOB, friendId: ALICE })).toBeFalsy();
  });

  it('engellediğim kişiye BEN de istek gönderemem', async () => {
    await request(app).post('/api/friends/blocks').set(as(ALICE)).send({ userId: BOB });

    const res = await request(app).post('/api/friends/request').set(as(ALICE)).send({ username: 'bob' });

    expect(res.status).toBe(409);
  });

  it('yanıt engelin VARLIĞINI ele vermez', async () => {
    // "Engellendiniz" demek, bu ucu birinin sizi engelleyip engellemediğini
    // öğrenmek için bir keşif aracına çevirirdi. Yanıt, "zaten arkadaş /
    // istek beklemede" ile AYNI olmalıdır.
    await request(app).post('/api/friends/blocks').set(as(ALICE)).send({ userId: BOB });
    const blockedRes = await request(app).post('/api/friends/request').set(as(BOB)).send({ username: 'alice' });

    await mockDb.friendships.insert({ userId: CAROL, friendId: ALICE, status: 'pending', createdAt: 1 });
    const pendingRes = await request(app).post('/api/friends/request').set(as(CAROL)).send({ username: 'alice' });

    expect(blockedRes.status).toBe(pendingRes.status);
    expect(blockedRes.body).toEqual(pendingRes.body);
  });

  it('POZİTİF KONTROL: engel yokken istek GEÇER', async () => {
    // Aksi halde "her şeyi reddet" de testi geçerdi.
    const res = await request(app).post('/api/friends/request').set(as(BOB)).send({ username: 'carol' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, status: 'pending' });
  });


  it('block-policy store failure fails closed instead of creating a friend request', async () => {
    const spy = jest.spyOn(Social, 'findBlock').mockRejectedValueOnce(new Error('blocks down'));
    const res = await request(app).post('/api/friends/request').set(as(BOB)).send({ username: 'alice' });
    expect(res.status).toBe(503);
    expect(await mockDb.friendships.findOne({ userId: BOB, friendId: ALICE })).toBeFalsy();
    spy.mockRestore();
  });

  it('stale friendship rows cannot resurrect or expose a relationship across a canonical block', async () => {
    await mockDb.blocks.insert({ _id: 'blk-stale', blockerId: ALICE, blockedId: BOB, createdAt: 1 });
    await mockDb.friendships.insert({ _id: 'accepted-stale', userId: ALICE, friendId: BOB, status: 'accepted', createdAt: 1 });
    await mockDb.friendships.insert({ _id: 'pending-stale', userId: BOB, friendId: ALICE, status: 'pending', createdAt: 2 });

    const list = await request(app).get('/api/friends').set(as(ALICE));
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);

    const pending = await request(app).get('/api/friends/pending').set(as(ALICE));
    expect(pending.status).toBe(200);
    expect(pending.body).toEqual([]);

    const accept = await request(app).post('/api/friends/pending-stale/accept').set(as(ALICE));
    expect(accept.status).toBe(409);
    expect((await mockDb.friendships.findOne({ _id: 'pending-stale' }))?.status).toBe('pending');
  });

  it('engel KALDIRILINCA istek yeniden mümkün olur', async () => {
    await request(app).post('/api/friends/blocks').set(as(ALICE)).send({ userId: BOB });
    await request(app).delete(`/api/friends/blocks/${BOB}`).set(as(ALICE));

    const res = await request(app).post('/api/friends/request').set(as(BOB)).send({ username: 'alice' });
    expect(res.status).toBe(200);
  });
});
