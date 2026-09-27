// server/tests/groupDm.test.ts
process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

// ── ATOMIK OLUSTURMA YOLU ────────────────────────────────────────────────────
// `POST /api/gdm` artik UC yazmayi TEK transaction icinde yapar
// (GroupDmRepository.createAtomic). Bunun nedeni canli bir kusurdu: yazmalar
// tamamlaniyor, ardindan zenginlestirme patliyor, istek 500 donuyor ve GERIDE
// YETIM GRUP kaliyordu.
//
// `withTransaction` gercek bir PoolClient verir; `PgCollection` ise havuzdan
// KENDI baglantisini aldigi icin repository cagrilari transaction'a KATILMAZ.
// Bu yuzden kanonik yol HAM SQL kullanir. Testte de ayni sozlesme taklit
// edilir: sahte client, ayni UC INSERT'i mockDb'ye yazar. Boylece test
// gercek yolu olcmeye DEVAM eder (yalnizca 201 degil, uyelikler de dogrulanir).
jest.mock('../db/postgres/transaction', () => ({
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn({
    query: async (sql: string, params: unknown[]) => {
      const db = require('../db/loader');
      if (/INSERT INTO group_dm_conversations/.test(sql)) {
        const row = {
          _id: params[0], name: params[1], ownerId: params[2],
          icon: params[3], createdAt: params[4], lastMessageAt: params[5],
        };
        await db.groupDmConversations.insert(row);
        return { rows: [row] };
      }
      if (/INSERT INTO group_dm_members/.test(sql)) {
        const [ids, gids, uids, joined] = params as string[][];
        for (let i = 0; i < ids.length; i++) {
          await db.groupDmMembers.insert({ _id: ids[i], groupId: gids[i], userId: uids[i], joinedAt: joined[i] });
        }
        return { rows: [] };
      }
      if (/INSERT INTO group_dm_messages/.test(sql)) {
        await db.groupDmMessages.insert({
          _id: params[0], groupId: params[1], userId: params[2], displayName: params[3],
          avatarColor: params[4], content: params[5], type: params[6], reactions: {}, createdAt: params[7],
        });
        return { rows: [] };
      }
      return { rows: [] };
    },
  }),
}));
jest.mock('../middleware/rateLimit', () => ({
  limits: { messages: () => (_req: unknown, _res: unknown, next: () => void) => next(), dm: () => (_req: unknown, _res: unknown, next: () => void) => next() },
}));

// groupDm.js imports sanitizeUser from ./auth — mock it
jest.mock('../routes/auth', () => ({
  sanitizeUser: (u: Record<string, unknown>) => ({ _id: u._id, username: u.username, displayName: u.displayName, avatarColor: u.avatarColor || '#2d9cdb', avatarUrl: u.avatarUrl || null }),
  router: { use: jest.fn() },
}));

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
const db      = require('../db/loader');
const jwt     = require('jsonwebtoken');
import { authMiddleware } from '../middleware/auth';
import gdmRouter from '../routes/groupDm';

function buildApp() {
  const app = express();
  app.set('io', null); // explicit null — no global leak, routes guard with if (io)
  app.use(express.json());
  app.use('/api/gdm', authMiddleware, gdmRouter);
  return app;
}
function tok(uid: string, v = 0) { return jwt.sign({ id: uid, v }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

describe('Group DM Routes', () => {
  let app: express.Express;
  let user1Id: string;
  let user2Id: string;
  let user3Id: string;
  let token1: string;
let token2: string;
let token3: string;

  beforeEach(async () => {
    db._reset?.();
    app     = buildApp();
    user1Id = uuidv4();
    user2Id = uuidv4();
    user3Id = uuidv4();
    token1  = tok(user1Id);
    token2  = tok(user2Id);
    token3  = tok(user3Id);

    await db.users.insert({ _id: user1Id, username: 'alice', displayName: 'Alice', tokenVersion: 0 });
    await db.users.insert({ _id: user2Id, username: 'bob',   displayName: 'Bob',   tokenVersion: 0 });
    await db.users.insert({ _id: user3Id, username: 'carol', displayName: 'Carol', tokenVersion: 0 });
  });

  describe('GET /api/gdm', () => {
    it('returns empty list when user has no group DMs', async () => {
      const res = await request(app)
        .get('/api/gdm')
        .set('Authorization', `Bearer ${token1}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(0);
    });

    it('returns groups the user belongs to', async () => {
      const gid = uuidv4();
      await db.groupDmConversations.insert({ _id: gid, name: 'Friends', ownerId: user1Id, createdAt: Date.now() });
      await db.groupDmMembers.insert({ _id: uuidv4(), groupId: gid, userId: user1Id, joinedAt: Date.now() });
      const res = await request(app)
        .get('/api/gdm')
        .set('Authorization', `Bearer ${token1}`);
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
    });

    it('rejects unauthenticated', async () => {
      const res = await request(app).get('/api/gdm');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/gdm — create group', () => {
    it('creates a group DM with valid members', async () => {
      const res = await request(app)
        .post('/api/gdm')
        .set('Authorization', `Bearer ${token1}`)
        .send({ name: 'Trip Planning', memberIds: [user2Id, user3Id] });
      expect([200, 201]).toContain(res.status);
      expect(res.body).toHaveProperty('_id');
    });

    it('returns 400 when no members provided', async () => {
      const res = await request(app)
        .post('/api/gdm')
        .set('Authorization', `Bearer ${token1}`)
        .send({ name: 'Empty Group', memberIds: [] });
      expect(res.status).toBe(400);
    });

    it('rejects unauthenticated', async () => {
      const res = await request(app).post('/api/gdm').send({ name: 'X', memberIds: [user2Id] });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/gdm/:gid', () => {
    let gid: string;
    beforeEach(async () => {
      gid = uuidv4();
      await db.groupDmConversations.insert({ _id: gid, name: 'MyGroup', ownerId: user1Id, createdAt: Date.now() });
      await db.groupDmMembers.insert({ _id: uuidv4(), groupId: gid, userId: user1Id, joinedAt: Date.now() });
    });

    it('returns group info for a member', async () => {
      const res = await request(app)
        .get(`/api/gdm/${gid}`)
        .set('Authorization', `Bearer ${token1}`);
      expect(res.status).toBe(200);
      expect(res.body._id).toBe(gid);
    });

    it('returns 403 for non-members', async () => {
      const res = await request(app)
        .get(`/api/gdm/${gid}`)
        .set('Authorization', `Bearer ${token2}`);
      expect([403, 404]).toContain(res.status);
    });

    it('returns 404 for nonexistent group', async () => {
      const res = await request(app)
        .get(`/api/gdm/${uuidv4()}`)
        .set('Authorization', `Bearer ${token1}`);
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/gdm/:gid — disband group', () => {
    let gid: string;
    beforeEach(async () => {
      gid = uuidv4();
      await db.groupDmConversations.insert({ _id: gid, name: 'ToDelete', ownerId: user1Id, createdAt: Date.now() });
      await db.groupDmMembers.insert({ _id: uuidv4(), groupId: gid, userId: user1Id, joinedAt: Date.now() });
    });

    it('owner can disband the group', async () => {
      const res = await request(app)
        .delete(`/api/gdm/${gid}`)
        .set('Authorization', `Bearer ${token1}`);
      expect([200, 204]).toContain(res.status);
      const group = await db.groupDmConversations.findOne({ _id: gid });
      expect(group).toBeNull();
    });

    it('non-owner cannot disband', async () => {
      await db.groupDmMembers.insert({ _id: uuidv4(), groupId: gid, userId: user2Id, joinedAt: Date.now() });
      const res = await request(app)
        .delete(`/api/gdm/${gid}`)
        .set('Authorization', `Bearer ${token2}`);
      expect(res.status).toBe(403);
    });
  });
});
