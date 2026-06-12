// server/tests/moderation.test.ts
// Tests for timeout, remove-timeout, audit-log endpoints

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

// Default: full permissions
const mockHasPermission = jest.fn(() => true);
jest.mock('../routes/roles', () => ({
  getMemberPerms: async () => 0xFFFFFFFF,
  hasPermission: (...args) => mockHasPermission(...args),
  PERMS: { MANAGE_MESSAGES: 32, ADMIN: 8, MANAGE_CHANNELS: 16, SEND_MESSAGES: 16 },
}));

import request from 'supertest';
import express from 'express';
const jwt     = require('jsonwebtoken');

import router from '../routes/moderation';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) {
    try { req.user = jwt.verify(h.slice(7), 'test-jwt-secret'); } catch {}
  }
  next();
});
// mergeParams-style mounting
app.use('/api/servers/:serverId', router);
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

function token(id) {
  return jwt.sign({ id, username: 'mod', displayName: 'Moderator', v: 0 }, 'test-jwt-secret', { expiresIn: '1h' });
}

const MOD_ID    = 'mod1';
const TARGET_ID = 'target1';
const SERVER_ID = 'srv1';

beforeAll(async () => {
  await mockDb.users.insert({ _id: MOD_ID,    username: 'mod',    displayName: 'Moderator', avatarColor: '#fff', status: 'online' });
  await mockDb.users.insert({ _id: TARGET_ID, username: 'victim', displayName: 'Victim',    avatarColor: '#fff', status: 'online' });
  await mockDb.servers.insert({ _id: SERVER_ID, name: 'TestServer', ownerId: MOD_ID, createdAt: Date.now() });
  await mockDb.members.insert({ userId: MOD_ID,    serverId: SERVER_ID, roles: '[]', joinedAt: Date.now() });
  await mockDb.members.insert({ userId: TARGET_ID, serverId: SERVER_ID, roles: '[]', joinedAt: Date.now() });
});

describe('POST /api/servers/:serverId/timeout/:userId', () => {
  it('applies a valid timeout (60s)', async () => {
    const before = Date.now();
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/timeout/${TARGET_ID}`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({ duration: 60 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.until).toBeGreaterThan(before);

    // member row should have timeoutUntil set
    const member = await mockDb.members.findOne({ userId: TARGET_ID, serverId: SERVER_ID });
    expect(member.timeoutUntil).toBeDefined();
    expect(member.timeoutUntil).toBeGreaterThan(before);
  });

  it('applies a 1-week timeout (604800s)', async () => {
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/timeout/${TARGET_ID}`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({ duration: 604800 });
    expect(res.status).toBe(200);
  });

  it('rejects invalid duration', async () => {
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/timeout/${TARGET_ID}`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({ duration: 9999 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid duration/i);
  });

  it('returns 404 for non-existent user', async () => {
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/timeout/ghost-user`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({ duration: 60 });
    expect(res.status).toBe(404);
  });

  it('rejects without permission', async () => {
    mockHasPermission.mockReturnValueOnce(false);
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/timeout/${TARGET_ID}`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({ duration: 60 });
    expect(res.status).toBe(403);
  });

  it('writes an audit log entry', async () => {
    await request(app)
      .post(`/api/servers/${SERVER_ID}/timeout/${TARGET_ID}`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({ duration: 300 });
    const logs = await mockDb.auditLogs.find({ serverId: SERVER_ID, action: 'TIMEOUT' });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[logs.length - 1].targetId).toBe(TARGET_ID);
    expect(logs[logs.length - 1].detail).toContain('300s');
  });
});

describe('DELETE /api/servers/:serverId/timeout/:userId', () => {
  it('removes a timeout', async () => {
    // first set a timeout
    await mockDb.members.update({ userId: TARGET_ID, serverId: SERVER_ID }, { $set: { timeoutUntil: Date.now() + 60000 } });

    const res = await request(app)
      .delete(`/api/servers/${SERVER_ID}/timeout/${TARGET_ID}`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const member = await mockDb.members.findOne({ userId: TARGET_ID, serverId: SERVER_ID });
    expect(member.timeoutUntil).toBeNull();
  });

  it('rejects without permission', async () => {
    mockHasPermission.mockReturnValueOnce(false);
    const res = await request(app)
      .delete(`/api/servers/${SERVER_ID}/timeout/${TARGET_ID}`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/servers/:serverId/audit-log', () => {
  it('returns audit log entries (moderator)', async () => {
    const res = await request(app)
      .get(`/api/servers/${SERVER_ID}/audit-log`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    // most recent first
    if (res.body.length > 1) {
      expect(res.body[0].createdAt).toBeGreaterThanOrEqual(res.body[1].createdAt);
    }
  });

  it('includes TIMEOUT entries', async () => {
    const res = await request(app)
      .get(`/api/servers/${SERVER_ID}/audit-log`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);
    const timeoutEntries = res.body.filter(e => e.action === 'TIMEOUT');
    expect(timeoutEntries.length).toBeGreaterThan(0);
  });

  it('returns 403 without permission', async () => {
    mockHasPermission.mockReturnValue(false);
    const res = await request(app)
      .get(`/api/servers/${SERVER_ID}/audit-log`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);
    expect(res.status).toBe(403);
    mockHasPermission.mockReturnValue(true);
  });
});
