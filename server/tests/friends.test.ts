// server/tests/friends.test.ts
// Tests for POST /request, GET /, GET /pending, POST /:id/accept, DELETE /:id

process.env.JWT_SECRET = 'test-jwt-secret';
process.env.NODE_ENV   = 'test';

import { createMockDb } from './helpers/mockDb';
const mockDb = createMockDb();

jest.mock('../db/index', () => mockDb);
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req, res, next) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const jwt = require('jsonwebtoken');
    try { req.user = jwt.verify(h.slice(7), 'test-jwt-secret'); next(); }
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
app.use((req, _res, next) => {
  // inject authMiddleware-style req.user from JWT
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) {
    try { req.user = jwt.verify(h.slice(7), 'test-jwt-secret'); } catch {}
  }
  next();
});
app.use('/api/friends', router);
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

function token(id, username = 'user') {
  return jwt.sign({ id, username, v: 0 }, 'test-jwt-secret', { expiresIn: '1h' });
}

const USER_A = { _id: 'ua', username: 'alice', displayName: 'Alice', avatarColor: '#fff', status: 'online' };
const USER_B = { _id: 'ub', username: 'bob',   displayName: 'Bob',   avatarColor: '#fff', status: 'online' };
const USER_C = { _id: 'uc', username: 'carol', displayName: 'Carol', avatarColor: '#fff', status: 'online' };

beforeAll(async () => {
  await mockDb.users.insert(USER_A);
  await mockDb.users.insert(USER_B);
  await mockDb.users.insert(USER_C);
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
    expect(res.body.error).toMatch(/yourself/i);
  });

  it('rejects unknown user', async () => {
    const res = await request(app)
      .post('/api/friends/request')
      .set('Authorization', `Bearer ${token('ua')}`)
      .send({ username: 'nobody' });
    expect(res.status).toBe(404);
  });

  it('rejects duplicate request', async () => {
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
  let friendshipId;

  beforeAll(async () => {
    const rows = await mockDb.friendships.find({ userId: 'ua', friendId: 'ub', status: 'pending' });
    friendshipId = rows[0]?._id;
  });

  it('accepts the friend request', async () => {
    expect(friendshipId).toBeDefined();
    const res = await request(app)
      .post(`/api/friends/${friendshipId}/accept`)
      .set('Authorization', `Bearer ${token('ub')}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const updated = await mockDb.friendships.findOne({ _id: friendshipId });
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
});

describe('GET /api/friends', () => {
  it('lists accepted friends', async () => {
    const res = await request(app)
      .get('/api/friends')
      .set('Authorization', `Bearer ${token('ua')}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const names = res.body.map(u => u.username);
    expect(names).toContain('bob');
  });

  it('does not include pending requests in friends list', async () => {
    const res = await request(app)
      .get('/api/friends')
      .set('Authorization', `Bearer ${token('ua')}`);
    // carol request is still pending
    const names = res.body.map(u => u.username);
    expect(names).not.toContain('carol');
  });
});

describe('DELETE /api/friends/:id', () => {
  let friendshipId;

  beforeAll(async () => {
    const rows = await mockDb.friendships.find({ userId: 'ua', friendId: 'ub', status: 'accepted' });
    friendshipId = rows[0]?._id;
  });

  it('removes an accepted friendship', async () => {
    const res = await request(app)
      .delete(`/api/friends/${friendshipId}`)
      .set('Authorization', `Bearer ${token('ua')}`);
    expect(res.status).toBe(200);
    const gone = await mockDb.friendships.findOne({ _id: friendshipId });
    expect(gone).toBeNull();
  });

  it('returns 404 for non-existent friendship', async () => {
    const res = await request(app)
      .delete('/api/friends/nonexistent-id')
      .set('Authorization', `Bearer ${token('ua')}`);
    expect(res.status).toBe(404);
  });

  it('returns 403 if requester is not party to friendship', async () => {
    // Create a friendship between ub and uc
    const f = await mockDb.friendships.insert({ userId: 'ub', friendId: 'uc', status: 'accepted', createdAt: Date.now() });
    const res = await request(app)
      .delete(`/api/friends/${f._id}`)
      .set('Authorization', `Bearer ${token('ua')}`); // alice is not involved
    expect(res.status).toBe(403);
  });
});
