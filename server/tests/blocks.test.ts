// server/tests/blocks.test.ts
//
// KULLANICI ENGELLEME — API'SI HİÇ YOKTU
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
//
// ── NEDEN İKİ DOSYA ───────────────────────────────────────────────────────
// Arkadaşlık isteği ENFORCEMENT testleri kardeş dosyadadır
// (`blocks-enforcement.test.ts`). Sebep kapsam değil ölçüm: `/blocks` ve
// `/request` uçları AYNI `limits.friends()` kovasını paylaşır ve `combined`
// mod IP sayacını da tutar; supertest'te tüm istekler tek IP'den gelir. Tek
// dosyada toplanınca son testler 429 alıyordu. Limiti gevşetmek gerçek bir
// kontrolü zayıflatırdı.
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
describe('engelleme — oluşturma', () => {
  it('kullanıcı engellenebilir', async () => {
    const res = await request(app).post('/api/friends/blocks').set(as(ALICE)).send({ userId: BOB });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, blocked: true, userId: BOB });
    expect(await mockDb.blocks.findOne({ blockerId: ALICE, blockedId: BOB })).toBeTruthy();
  });

  it('KENDİNİ engellemek REDDEDİLİR', async () => {
    const res = await request(app).post('/api/friends/blocks').set(as(ALICE)).send({ userId: ALICE });

    expect(res.status).toBe(400);
    expect(await mockDb.blocks.findOne({ blockerId: ALICE, blockedId: ALICE })).toBeFalsy();
  });

  it('var olmayan kullanıcı engellenemez', async () => {
    const res = await request(app).post('/api/friends/blocks').set(as(ALICE)).send({ userId: 'yok' });
    expect(res.status).toBe(404);
  });

  it('userId zorunludur', async () => {
    expect((await request(app).post('/api/friends/blocks').set(as(ALICE)).send({})).status).toBe(400);
  });

  it('ETKİSİZ-TEKRARLANABİLİR: iki kez engellemek hata değildir', async () => {
    // İstemci yeniden denemesi kullanıcıyı hataya düşürmemeli.
    await request(app).post('/api/friends/blocks').set(as(ALICE)).send({ userId: BOB });
    const second = await request(app).post('/api/friends/blocks').set(as(ALICE)).send({ userId: BOB });

    expect(second.status).toBe(200);
    expect(await mockDb.blocks.find({ blockerId: ALICE, blockedId: BOB })).toHaveLength(1);
  });

  it('engellemek ARKADAŞLIĞI da kaldırır', async () => {
    // "Arkadaş ama engelli" tutarsız bir durumdur ve arkadaş listesini
    // yanıltıcı hale getirir.
    await mockDb.friendships.insert({ userId: ALICE, friendId: BOB, status: 'accepted', createdAt: 1 });

    await request(app).post('/api/friends/blocks').set(as(ALICE)).send({ userId: BOB });

    expect(await mockDb.friendships.findOne({ userId: ALICE, friendId: BOB })).toBeFalsy();
  });

  it('kimliksiz istek reddedilir', async () => {
    expect((await request(app).post('/api/friends/blocks').send({ userId: BOB })).status).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('engelleme — kaldırma', () => {
  it('engel kaldırılabilir', async () => {
    await request(app).post('/api/friends/blocks').set(as(ALICE)).send({ userId: BOB });

    const res = await request(app).delete(`/api/friends/blocks/${BOB}`).set(as(ALICE));

    expect(res.status).toBe(200);
    expect(await mockDb.blocks.findOne({ blockerId: ALICE, blockedId: BOB })).toBeFalsy();
  });

  it('BAŞKASININ engelini kaldıramaz', async () => {
    // Anahtar daima çağıranın kendi kimliğidir; istemciden `blockerId`
    // KABUL EDİLMEZ.
    await request(app).post('/api/friends/blocks').set(as(ALICE)).send({ userId: BOB });

    await request(app).delete(`/api/friends/blocks/${BOB}`).set(as(CAROL));

    expect(await mockDb.blocks.findOne({ blockerId: ALICE, blockedId: BOB })).toBeTruthy();
  });

  it('olmayan engeli kaldırmak hata değildir', async () => {
    expect((await request(app).delete(`/api/friends/blocks/${BOB}`).set(as(ALICE))).status).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('engelleme — listeleme', () => {
  it('YALNIZCA çağıranın kendi engelleri döner', async () => {
    await request(app).post('/api/friends/blocks').set(as(ALICE)).send({ userId: BOB });
    await request(app).post('/api/friends/blocks').set(as(CAROL)).send({ userId: ALICE });

    const res = await request(app).get('/api/friends/blocks').set(as(ALICE));

    expect(res.status).toBe(200);
    expect(res.body.blocks.map((b: Record<string, unknown>) => b.userId)).toEqual([BOB]);
  });

  it('listede GİZLİ alanlar yoktur', async () => {
    await request(app).post('/api/friends/blocks').set(as(ALICE)).send({ userId: BOB });

    const res = await request(app).get('/api/friends/blocks').set(as(ALICE));
    const body = JSON.stringify(res.body);

    expect(body).not.toContain('password');
    expect(body).not.toContain('hash');
    expect(body).not.toContain('b@x.test');
  });

  it('engel yoksa boş liste döner', async () => {
    const res = await request(app).get('/api/friends/blocks').set(as(ALICE));
    expect(res.body.blocks).toEqual([]);
  });
});
