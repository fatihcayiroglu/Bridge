// server/tests/search.test.ts
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
    try {
      req.user = jwt.verify(h.slice(7), 'test-jwt-secret');
      next();
    } catch { res.status(401).json({ error: 'Invalid token' }); }
  },
  verifyToken: (t) => { try { return require('jsonwebtoken').verify(t, 'test-jwt-secret'); } catch { return null; } },
}));

import request from 'supertest';
import express from 'express';
const jwt     = require('jsonwebtoken');

// Wire up _ftsSearch on the mock — simple JS filter
const _msgStore: Record<string, unknown> = {};
mockDb._ftsSearch = (_table, query, serverIds, limit = 20) => {
  return Object.values(_msgStore)
    .filter(m => serverIds.includes(m.serverId) && m.content?.toLowerCase().includes(query.toLowerCase()))
    .slice(0, limit);
};
// intercept messages.insert to also update _msgStore
const origInsert = mockDb.messages.insert.bind(mockDb.messages);
mockDb.messages.insert = async (doc) => {
  const result = await origInsert(doc);
  _msgStore[result._id] = result;
  return result;
};

import searchRouter from '../routes/search';
const pinsRouter   = require('../routes/pins');

const app = express();
app.use(express.json());
app.use('/api/search',   searchRouter);
app.use('/api/channels', pinsRouter);
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

function token(id = 'u1') {
  return jwt.sign({ id, username: 'searcher', v: 0 }, 'test-jwt-secret', { expiresIn: '1h' });
}

const USER_ID   = 'u1';
const SERVER_ID = 'srv1';
const CHAN_ID   = 'ch1';

beforeAll(async () => {
  await mockDb.members.insert({ userId: USER_ID, serverId: SERVER_ID, roles: '[]', joinedAt: Date.now() });
  await mockDb.channels.insert({ _id: CHAN_ID,  serverId: SERVER_ID, name: 'general',       type: 'text', createdAt: Date.now() });
  await mockDb.channels.insert({ _id: 'ch2',    serverId: SERVER_ID, name: 'announcements', type: 'text', createdAt: Date.now() });
  await mockDb.users.insert({ _id: USER_ID, username: 'searcher', displayName: 'Searcher', avatarColor: '#fff', status: 'online' });
  await mockDb.messages.insert({ _id: 'm1', channelId: CHAN_ID, serverId: SERVER_ID, userId: USER_ID, displayName: 'U', content: 'hello world',   type: 'normal', pinned: false, reactions: {}, createdAt: 1000 });
  await mockDb.messages.insert({ _id: 'm2', channelId: CHAN_ID, serverId: SERVER_ID, userId: USER_ID, displayName: 'U', content: 'goodbye friend', type: 'normal', pinned: false, reactions: {}, createdAt: 2000 });
  await mockDb.messages.insert({ _id: 'm3', channelId: CHAN_ID, serverId: SERVER_ID, userId: USER_ID, displayName: 'U', content: 'hello again',   type: 'normal', pinned: true,  reactions: {}, createdAt: 3000 });
  await mockDb.messages.insert({ _id: 'm4', channelId: CHAN_ID, serverId: SERVER_ID, userId: USER_ID, displayName: 'U', content: '',             type: 'file',   pinned: false, fileUrl: '/uploads/f.pdf', fileName: 'f.pdf', reactions: {}, createdAt: 4000 });
});

describe('GET /api/search', () => {
  it('finds messages by keyword', async () => {
    const res = await request(app).get('/api/search?q=hello').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.messages.length).toBe(2);
  });

  it('finds channels by name', async () => {
    const res = await request(app).get('/api/search?q=announce').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.channels.length).toBe(1);
    expect(res.body.channels[0].name).toBe('announcements');
  });

  it('finds users by displayName', async () => {
    const res = await request(app).get('/api/search?q=Search').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.users.length).toBe(1);
    expect(res.body.users[0].username).toBe('searcher');
  });

  it('returns empty for short query (< 2 chars)', async () => {
    const res = await request(app).get('/api/search?q=h').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(res.body.channels).toEqual([]);
    expect(res.body.users).toEqual([]);
  });

  it('scopes to serverId — hides messages from other servers', async () => {
    await mockDb.messages.insert({ _id: 'mx', channelId: 'chx', serverId: 'other-srv', userId: 'ux', displayName: 'X', content: 'hello hidden', type: 'normal', pinned: false, reactions: {}, createdAt: 9000 });
    const res = await request(app).get(`/api/search?q=hello&serverId=${SERVER_ID}`).set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.messages.map(m => m._id)).not.toContain('mx');
  });

  it('type=channels returns only channels', async () => {
    const res = await request(app).get('/api/search?q=general&type=channels').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.channels).toBeDefined();
    expect(res.body.messages).toBeUndefined();
  });

  it('rejects unauthenticated', async () => {
    const res = await request(app).get('/api/search?q=hello');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/channels/:cid/pins', () => {
  it('returns only pinned messages', async () => {
    const res = await request(app).get(`/api/channels/${CHAN_ID}/pins`).set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.every(m => m.pinned)).toBe(true);
    expect(res.body.find(m => m._id === 'm3')).toBeDefined();
  });

  it('excludes non-pinned messages', async () => {
    const res = await request(app).get(`/api/channels/${CHAN_ID}/pins`).set('Authorization', `Bearer ${token()}`);
    expect(res.body.find(m => m._id === 'm1')).toBeUndefined();
  });

  it('returns 403 for non-members', async () => {
    const res = await request(app).get(`/api/channels/${CHAN_ID}/pins`).set('Authorization', `Bearer ${token('outsider')}`);
    expect(res.status).toBe(403);
  });

  it('returns 404 for missing channel', async () => {
    const res = await request(app).get('/api/channels/ghost/pins').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/channels/:cid/files', () => {
  it('returns only file messages', async () => {
    const res = await request(app).get(`/api/channels/${CHAN_ID}/files`).set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.every(m => m.type === 'file')).toBe(true);
    expect(res.body.find(m => m._id === 'm4')).toBeDefined();
  });

  it('respects the limit param', async () => {
    for (let i = 0; i < 5; i++) {
      await mockDb.messages.insert({ _id: `xf${i}`, channelId: CHAN_ID, serverId: SERVER_ID, userId: USER_ID, displayName: 'U', content: '', type: 'file', fileUrl: `/uploads/xf${i}.pdf`, fileName: `xf${i}.pdf`, pinned: false, reactions: {}, createdAt: 6000 + i });
    }
    const res = await request(app).get(`/api/channels/${CHAN_ID}/files?limit=3`).set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(3);
  });

  it('returns 403 for non-members', async () => {
    const res = await request(app).get(`/api/channels/${CHAN_ID}/files`).set('Authorization', `Bearer ${token('outsider')}`);
    expect(res.status).toBe(403);
  });
});
