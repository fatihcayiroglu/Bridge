// server/tests/dm.test.ts
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

import request from 'supertest';
import express from 'express';
const jwt     = require('jsonwebtoken');
import { createMockDb, makeUser } from './helpers/mockDb';
import type { MockDb, UserFixture } from './helpers/mockDb';

let db: MockDb;
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/index', () => {
  const { createMockDb } = require('./helpers/mockDb');
  db = createMockDb();
  return db;
});

jest.mock('../db/repositories', () => {
  const currentDb = () => require('../db/loader');
  const buildDmId = (a: string, b: string) => [a, b].sort().join('_');

  return {
    Dms: {
      findConversation: (id: string) => currentDb().dmConversations.findOne({ _id: id }),
      async findConversationsByUser(userId: string) {
        const conversations = await currentDb().dmConversations.find({});
        return conversations.filter((conv: { participants?: unknown }) =>
          Array.isArray(conv.participants) && conv.participants.includes(userId),
        );
      },
      async findOrCreateConversation(userId: string, toUserId: string) {
        const dmId = buildDmId(userId, toUserId);
        let conv = await currentDb().dmConversations.findOne({ _id: dmId });
        if (!conv) {
          conv = await currentDb().dmConversations.insert({
            _id: dmId,
            participants: [userId, toUserId],
            createdAt: Date.now(),
            lastMessageAt: Date.now(),
          });
        } else {
          await currentDb().dmConversations.update(
            { _id: dmId },
            { $set: { lastMessageAt: Date.now() } },
          );
        }
        return { conv, dmId };
      },
      findMessages(dmId: string, { limit = 50, before, beforeId }: { limit?: number; before?: number; beforeId?: string } = {}) {
        // Faz 10.2 kompozit cursor — gerçek repository ile aynı semantik.
        // (Sorgu semantiğinin ASIL testi tests/dm-pagination.test.ts'tedir;
        //  burası yalnızca route seviyesini besler.)
        const query: Record<string, unknown> = { dmId };
        if (before) {
          query.$or = beforeId
            ? [{ createdAt: { $lt: before } }, { createdAt: before, _id: { $lt: beforeId } }]
            : [{ createdAt: { $lt: before } }];
        }
        return currentDb().dmMessages.find(query).sort({ createdAt: -1, _id: -1 }).limit(Math.min(limit, 100));
      },
      // Faz 10.3 — route artık türetilmiş okunmamış sayacı istiyor.
      // Gerçek sayım semantiği tests/dm-unread.test.ts'te sınanır.
      async countUnread(dmId: string, userId: string, readAt?: number) {
        const query: Record<string, unknown> = { dmId, userId: { $ne: userId } };
        if (typeof readAt === 'number' && readAt > 0) query.createdAt = { $gt: readAt };
        return currentDb().dmMessages.count(query);
      },
      async markRead(dmId: string, userId: string) {
        const conv = await currentDb().dmConversations.findOne({ _id: dmId });
        if (!conv || !Array.isArray(conv.participants) || !conv.participants.includes(userId)) return false;
        const readAt = { ...(conv.readAt || {}), [userId]: Date.now() };
        await currentDb().dmConversations.update({ _id: dmId }, { $set: { readAt } });
        return true;
      },
      // Faz 10.8 — route gizlilik kontrolü için mevcut konuşmayı sorguluyor.
      async findConversationByParticipants(a: string, b: string) {
        return currentDb().dmConversations.findOne({ _id: buildDmId(a, b) });
      },
    },
    // Faz 10.8 — DM açılışında engel/gizlilik kontrolü. Bu süitte kısıtlama
    // yok (varsayılan 'everyone'); asıl politika testi
    // tests/dm-privacy-security.test.ts'tedir.
    Social: {
      findBlock: async () => null,
      findFriendship: async () => null,
    },
    Users: {
      findById: (id: string) => currentDb().users.findOne({ _id: id }),
      findByIds: (ids: string[]) => currentDb().users.find({ _id: { $in: ids } }),
    },
  };
});

import dmRouter from '../routes/dm';

function makeToken(userId: string) {
  return jwt.sign({ id: userId, username: 'tester', v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });
}

let app: express.Express;
let userA: UserFixture;
let userB: UserFixture;
let tokenA: string;
let tokenB: string;

beforeEach(async () => {
  const { createMockDb, makeUser } = require('./helpers/mockDb');
  db = createMockDb();
  Object.assign(require('../db/loader'), db);
  Object.assign(require('../db/index'), db);

  userA = makeUser({ username: 'alice' });
  userB = makeUser({ username: 'bob' });
  await db.users.insert(userA);
  await db.users.insert(userB);

  tokenA = makeToken(userA._id);
  tokenB = makeToken(userB._id);

  app = express();
  app.use(express.json());
  app.use('/api/dm', dmRouter);
  app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(500).json({ error: err.message }));
});

describe('POST /api/dm/:userId — konuşma başlat', () => {
  it('yeni DM konuşması oluşturur', async () => {
    const res = await request(app)
      .post(`/api/dm/${userB._id}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.participants).toContain(userA._id);
    expect(res.body.participants).toContain(userB._id);
    expect(res.body.other._id).toBe(userB._id);
    expect(res.body.other.password).toBeUndefined();
  });

  it('aynı çift için mevcut konuşmayı döner', async () => {
    const res1 = await request(app)
      .post(`/api/dm/${userB._id}`)
      .set('Authorization', `Bearer ${tokenA}`);

    const res2 = await request(app)
      .post(`/api/dm/${userB._id}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res1.body._id).toBe(res2.body._id);
  });

  it('kendine DM 400 döner', async () => {
    const res = await request(app)
      .post(`/api/dm/${userA._id}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/yourself/i);
  });

  it('mevcut olmayan kullanıcıya DM 404 döner', async () => {
    const res = await request(app)
      .post('/api/dm/nonexistent')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(404);
  });

  it('DM ID simetrik oluşturulur (A→B === B→A)', async () => {
    const resAB = await request(app)
      .post(`/api/dm/${userB._id}`)
      .set('Authorization', `Bearer ${tokenA}`);

    const resBA = await request(app)
      .post(`/api/dm/${userA._id}`)
      .set('Authorization', `Bearer ${tokenB}`);

    expect(resAB.body._id).toBe(resBA.body._id);
  });
});

describe('GET /api/dm — konuşma listesi', () => {
  it('boş liste döner', async () => {
    const res = await request(app)
      .get('/api/dm')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(0);
  });

  it('konuşma oluşturduktan sonra listede görünür', async () => {
    await request(app)
      .post(`/api/dm/${userB._id}`)
      .set('Authorization', `Bearer ${tokenA}`);

    const res = await request(app)
      .get('/api/dm')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].other._id).toBe(userB._id);
  });
});

describe('GET /api/dm/:dmId/messages — mesajlar', () => {
  let dmId: string;

  beforeEach(async () => {
    const createRes = await request(app)
      .post(`/api/dm/${userB._id}`)
      .set('Authorization', `Bearer ${tokenA}`);
    dmId = createRes.body._id;

    // Birkaç mesaj ekle
    for (let i = 0; i < 3; i++) {
      await db.dmMessages.insert({
        _id: `dm-msg-${i}`, dmId,
        userId: userA._id, displayName: userA.displayName,
        avatarColor: '#2d9cdb', content: `Mesaj ${i}`,
        createdAt: Date.now() - (3 - i),
      });
    }
  });

  it('mesajları döner', async () => {
    const res = await request(app)
      .get(`/api/dm/${dmId}/messages`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(3);
  });

  it('konuşmada olmayan kullanıcı 403 alır', async () => {
    const userC = makeUser();
    await db.users.insert(userC);
    const tokenC = makeToken(userC._id);

    const res = await request(app)
      .get(`/api/dm/${dmId}/messages`)
      .set('Authorization', `Bearer ${tokenC}`);

    expect(res.status).toBe(403);
  });

  it('mevcut olmayan konuşma 404 döner', async () => {
    const res = await request(app)
      .get('/api/dm/nonexistent/messages')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(404);
  });

  it('limit parametresi çalışır', async () => {
    const res = await request(app)
      .get(`/api/dm/${dmId}/messages?limit=2`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(2);
  });

  it.each(['-1', '1.5', '9007199254740992'])('rejects unsafe limit=%s before querying history', async (raw) => {
    const res = await request(app)
      .get(`/api/dm/${dmId}/messages?limit=${encodeURIComponent(raw)}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(400);
  });

  it.each(['-1', '1.5', '9007199254740992'])('rejects unsafe before=%s cursor', async (raw) => {
    const res = await request(app)
      .get(`/api/dm/${dmId}/messages?before=${encodeURIComponent(raw)}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(400);
  });
});
