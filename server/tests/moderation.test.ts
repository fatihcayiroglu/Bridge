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
  canActOn: async () => true,
  PERMS: {
    MANAGE_MESSAGES: 32,
    TIMEOUT_MEMBERS: 64,
    ADMIN: 8,
    MANAGE_CHANNELS: 16,
    SEND_MESSAGES: 16,
  },
}));
jest.mock('../lib/permCache', () => ({
  invalidatePerms: jest.fn(),
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
  await mockDb.auditLogs.insert({
    _id: 'seed-audit',
    serverId: SERVER_ID,
    actorId: MOD_ID,
    actorName: 'Moderator',
    action: 'timeout',
    targetId: TARGET_ID,
    targetName: 'victim',
    detail: 'seed',
    createdAt: Date.now(),
  });
});

beforeEach(() => {
  mockHasPermission.mockReset();
  mockHasPermission.mockReturnValue(true);
});

describe('POST /api/servers/:serverId/members/:userId/timeout', () => {
  it('applies a valid timeout (60s)', async () => {
    const before = Date.now();
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/members/${TARGET_ID}/timeout`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({ durationMs: 60_000 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Date.parse(res.body.until)).toBeGreaterThan(before);

    // member row should have timeoutUntil set
    const member = await mockDb.members.findOne({ userId: TARGET_ID, serverId: SERVER_ID });
    expect(member.timeoutUntil).toBeDefined();
    expect(member.timeoutUntil).toBeGreaterThan(before);
  });

  it('applies a 1-week timeout (604800s)', async () => {
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/members/${TARGET_ID}/timeout`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({ durationMs: 604_800_000 });
    expect(res.status).toBe(200);
  });

  it('accepts millisecond duration values', async () => {
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/members/${TARGET_ID}/timeout`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({ durationMs: 9_999 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 404 for non-existent user', async () => {
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/members/ghost-user/timeout`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({ durationMs: 60_000 });
    expect(res.status).toBe(404);
  });

  it('rejects without permission', async () => {
    mockHasPermission.mockReturnValue(false);
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/members/${TARGET_ID}/timeout`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({ durationMs: 60_000 });
    expect(res.status).toBe(403);
  });

  it('writes an audit log entry', async () => {
    await request(app)
      .post(`/api/servers/${SERVER_ID}/members/${TARGET_ID}/timeout`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({ durationMs: 300_000, reason: 'manual test' });
    const logs = await mockDb.auditLogs.find({ serverId: SERVER_ID, action: 'timeout' });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[logs.length - 1].targetId).toBe(TARGET_ID);
    expect(logs[logs.length - 1].detail).toContain('manual test');
  });
});

describe('POST /api/servers/:serverId/members/:userId/timeout with durationMs=0', () => {
  it('removes a timeout', async () => {
    // first set a timeout
    await mockDb.members.update({ userId: TARGET_ID, serverId: SERVER_ID }, { $set: { timeoutUntil: Date.now() + 60000 } });

    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/members/${TARGET_ID}/timeout`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({ durationMs: 0 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const member = await mockDb.members.findOne({ userId: TARGET_ID, serverId: SERVER_ID });
    expect(member.timeoutUntil).toBeNull();
  });

  it('rejects without permission', async () => {
    mockHasPermission.mockReturnValue(false);
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/members/${TARGET_ID}/timeout`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({ durationMs: 0 });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/servers/:serverId/audit-log', () => {
  it('returns audit log entries (moderator)', async () => {
    const res = await request(app)
      .get(`/api/servers/${SERVER_ID}/audit-log`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(res.body.entries.length).toBeGreaterThan(0);
    expect(typeof res.body.total).toBe('number');
    if (res.body.entries.length > 1) {
      expect(res.body.entries[0].createdAt).toBeGreaterThanOrEqual(res.body.entries[1].createdAt);
    }
  });

  it('includes TIMEOUT entries', async () => {
    const res = await request(app)
      .get(`/api/servers/${SERVER_ID}/audit-log`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);
    const timeoutEntries = res.body.entries.filter(e => e.action === 'timeout');
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
