// server/tests/friends.test.ts
// Tests for POST /request, GET /, GET /pending, POST /:id/accept, DELETE /:id
import type { Request, Response, NextFunction } from 'express';

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

import { createMockDb, requireDoc } from './helpers/mockDb';
const mockDb = createMockDb();

jest.mock('../db/index', () => mockDb);
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/repositories', () => ({
  Users: {
    findByUsername: async (username: string) => mockDb.users.findOne({ username }),
    findByIds: async (ids: string[]) => {
      const users = [];
      for (const id of ids || []) {
        const user = await mockDb.users.findOne({ _id: id });
        if (user) users.push(user);
      }
      return users;
    },
  },
  Social: {
    // `findBlock` GERCEK depoda vardir ve `/request` artik engeli denetler
    // (engellenen kisi istek gonderemez). Mock'ta eksik olmasi, uretimde
    // olmayan bir 500 uretiyordu — eksik olan MOCK'tu, kod degil.
    findBlock: async (blockerId: string, blockedId: string) => mockDb.blocks.findOne({ blockerId, blockedId }),
    findBlocksInvolvingUser: async (userId: string) => mockDb.blocks.find({
      $or: [{ blockerId: userId }, { blockedId: userId }],
    }),
    findFriendship: async (userId: string, otherId: string) => mockDb.friendships.findOne({
      $or: [
        { userId, friendId: otherId },
        { userId: otherId, friendId: userId },
      ],
    }),
    findFriendshipById: async (friendshipId: string) => mockDb.friendships.findOne({ _id: friendshipId }),
    findFriendships: async (userId: string) => {
      const query: any = mockDb.friendships.find({
        $or: [{ userId }, { friendId: userId }],
      });
      if (Array.isArray(query)) return query;
      if (query && typeof query.toArray === 'function') return await query.toArray();
      if (query && typeof query.all === 'function') return await query.all();
      if (query && typeof query.exec === 'function') return await query.exec();
      if (query && typeof query.then === 'function') return await query;
      throw new Error('Mock friendship query cannot be materialized');
    },
    createFriendship: async (userId: string, friendId: string) => mockDb.friendships.insert({
      userId,
      friendId,
      status: 'pending',
      createdAt: Date.now(),
    }),
    acceptFriendship: async (friendshipId: string) => mockDb.friendships.update(
      { _id: friendshipId },
      { $set: { status: 'accepted' } },
    ),
    declineFriendship: async (friendshipId: string) => mockDb.friendships.update(
      { _id: friendshipId },
      { $set: { status: 'declined' } },
    ),
    removeFriendship: async (friendshipId: string) => mockDb.friendships.remove({ _id: friendshipId }),
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
    const jwt = require('jsonwebtoken');
    try { req.user = jwt.verify(h.slice(7), 'test-jwt-secret-long-enough-32chars!!'); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
  },
}));
jest.mock('../routes/roles', () => ({
  getMemberPerms: async () => 0xFFFFFFFF,
  hasPermission:  () => true,
  PERMS: { MANAGE_MESSAGES: 32, ADMIN: 8, MANAGE_CHANNELS: 16 },
}));

const request  = require('supertest');
const express  = require('express');
const jwt      = require('jsonwebtoken');
const router   = require('../routes/friends');

const app = express();
app.use(express.json());
app.use((req: Request, _res: Response, next: NextFunction) => {
  // inject authMiddleware-style req.user from JWT
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) {
    try { req.user = jwt.verify(h.slice(7), 'test-jwt-secret-long-enough-32chars!!'); } catch {}
  }
  next();
});
app.use('/api/friends', router);
app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(err.status || 500).json({ error: err.message }));

function token(id: string, username = 'user') {
  return jwt.sign({ id, username, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });
}

const USER_A = { _id: 'ua', username: 'alice', displayName: 'Alice', avatarColor: '#fff', status: 'online' };
const USER_B = { _id: 'ub', username: 'bob',   displayName: 'Bob',   avatarColor: '#fff', status: 'online' };
const USER_C = { _id: 'uc', username: 'carol', displayName: 'Carol', avatarColor: '#fff', status: 'online' };

beforeAll(async () => {
  await mockDb.users.insert(USER_A);
  await mockDb.users.insert(USER_B);
  await mockDb.users.insert(USER_C);
});

afterEach(async () => {
  // Relationship rows are test state, unlike the shared user fixtures.  A
  // stale ua/ub row otherwise makes the peer-id delete test remove an older
  // relationship and falsely leave the row it just created behind.
  for (const row of await mockDb.friendships.find({})) {
    await mockDb.friendships.remove({ _id: row._id });
  }
  for (const row of await mockDb.blocks.find({})) {
    await mockDb.blocks.remove({ _id: row._id });
  }
});

describe('POST /api/friends/request', () => {
  it('sends a friend request by username', async () => {
    const res = await request(app)
      .post('/api/friends/request')
      .set('Authorization', `Bearer ${token('ua')}`)
      .send({ username: 'bob' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(res.body.friendId).toBe('ub');
  });

  it('rejects adding yourself', async () => {
    const res = await request(app)
      .post('/api/friends/request')
      .set('Authorization', `Bearer ${token('ua')}`)
      .send({ username: 'alice' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/kendinize|yourself/i);
  });

  it('rejects unknown user', async () => {
    const res = await request(app)
      .post('/api/friends/request')
      .set('Authorization', `Bearer ${token('ua')}`)
      .send({ username: 'nobody' });
    expect(res.status).toBe(404);
  });

  it('rejects duplicate request', async () => {
    await mockDb.friendships.insert({
      userId: 'ua',
      friendId: 'ub',
      status: 'pending',
      createdAt: Date.now(),
    });
    const res = await request(app)
      .post('/api/friends/request')
      .set('Authorization', `Bearer ${token('ua')}`)
      .send({ username: 'bob' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already/i);
  });

  it('rejects missing username field', async () => {
    const res = await request(app)
      .post('/api/friends/request')
      .set('Authorization', `Bearer ${token('ua')}`)
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('GET /api/friends/pending', () => {
  it('returns pending requests for recipient', async () => {
    await mockDb.friendships.insert({
      userId: 'ua',
      friendId: 'ub',
      status: 'pending',
      createdAt: Date.now(),
    });
    const res = await request(app)
      .get('/api/friends/pending')
      .set('Authorization', `Bearer ${token('ub')}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0].sender.username).toBe('alice');
  });

  it('returns empty list if no pending requests', async () => {
    const res = await request(app)
      .get('/api/friends/pending')
      .set('Authorization', `Bearer ${token('uc')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('POST /api/friends/:id/accept', () => {
  it('accepts the friend request', async () => {
    const pending = await mockDb.friendships.insert({
      userId: 'ua',
      friendId: 'ub',
      status: 'pending',
      createdAt: Date.now(),
    });
    const res = await request(app)
      .post(`/api/friends/${pending._id}/accept`)
      .set('Authorization', `Bearer ${token('ub')}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const updated = await requireDoc(mockDb.friendships, { _id: pending._id });
    expect(updated.status).toBe('accepted');
  });

  it('rejects accept by a third party', async () => {
    // Create a new pending request from alice to carol
    const newReq = await mockDb.friendships.insert({ userId: 'ua', friendId: 'uc', status: 'pending', createdAt: Date.now() });
    const res = await request(app)
      .post(`/api/friends/${newReq._id}/accept`)
      .set('Authorization', `Bearer ${token('ub')}`); // bob, not carol
    expect(res.status).toBe(404);
  });

  it('rejects decline by a third party', async () => {
    const newReq = await mockDb.friendships.insert({ userId: 'ua', friendId: 'uc', status: 'pending', createdAt: Date.now() });
    const res = await request(app)
      .post(`/api/friends/${newReq._id}/decline`)
      .set('Authorization', `Bearer ${token('ub')}`); // bob, not carol
    expect(res.status).toBe(404);
  });
});

describe('GET /api/friends', () => {
  it('lists accepted friends', async () => {
    await mockDb.friendships.insert({
      userId: 'ua',
      friendId: 'ub',
      status: 'accepted',
      createdAt: Date.now(),
    });
    const res = await request(app)
      .get('/api/friends')
      .set('Authorization', `Bearer ${token('ua')}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const names = res.body.map((u: Record<string, unknown>) => u.username);
    expect(names).toContain('bob');
  });

  it('does not include pending requests in friends list', async () => {
    await mockDb.friendships.insert({
      userId: 'ua',
      friendId: 'uc',
      status: 'pending',
      createdAt: Date.now(),
    });
    const res = await request(app)
      .get('/api/friends')
      .set('Authorization', `Bearer ${token('ua')}`);
    // carol request is still pending
    const names = res.body.map((u: Record<string, unknown>) => u.username);
    expect(names).not.toContain('carol');
  });
});

describe('DELETE /api/friends/:id', () => {
  it('removes an accepted friendship by peer user id (shipping client contract)', async () => {
    const f = await mockDb.friendships.insert({ userId: 'ua', friendId: 'ub', status: 'accepted', createdAt: Date.now() });
    const res = await request(app)
      .delete('/api/friends/ub')
      .set('Authorization', `Bearer ${token('ua')}`);
    expect(res.status).toBe(200);
    expect(await mockDb.friendships.findOne({ _id: f._id })).toBeNull();
  });

  it('keeps legacy friendship-row ids compatible for involved users', async () => {
    const f = await mockDb.friendships.insert({ userId: 'ua', friendId: 'ub', status: 'accepted', createdAt: Date.now() });
    const res = await request(app)
      .delete(`/api/friends/${f._id}`)
      .set('Authorization', `Bearer ${token('ua')}`);
    expect(res.status).toBe(200);
    expect(await mockDb.friendships.findOne({ _id: f._id })).toBeNull();
  });

  it('returns 404 for non-existent friendship or peer', async () => {
    const res = await request(app)
      .delete('/api/friends/nonexistent-id')
      .set('Authorization', `Bearer ${token('ua')}`);
    expect(res.status).toBe(404);
  });

  it('returns 403 if requester tries a legacy row id for somebody else friendship', async () => {
    const f = await mockDb.friendships.insert({ userId: 'ub', friendId: 'uc', status: 'accepted', createdAt: Date.now() });
    const res = await request(app)
      .delete(`/api/friends/${f._id}`)
      .set('Authorization', `Bearer ${token('ua')}`);
    expect(res.status).toBe(403);
  });
});
