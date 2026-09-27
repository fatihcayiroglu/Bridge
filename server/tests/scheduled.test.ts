// server/tests/scheduled.test.ts
'use strict';

process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';

import { createMockDb, makeUser, makeServer, makeChannel, requireDoc } from './helpers/mockDb';
import type { ChannelFixture, ServerFixture, UserFixture } from './helpers/mockDb';
let db = createMockDb();
jest.mock('../db/index', () => { const { createMockDb } = require('./helpers/mockDb'); return createMockDb(); });
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../middleware/rateLimit', () => ({
  limits: { write: () => (_req: unknown, _res: unknown, next: () => void) => next() },
}));

// Canonical channel-aware permission resolver used by production scheduled route.
jest.mock('../lib/permissions', () => ({
  PERMS: { VIEW_CHANNELS: 1 << 0, SEND_MESSAGES: 1 << 8, ADMINISTRATOR: 1 << 30 },
  hasPermission: (perms: number, flag: number) => (perms & (1 << 30)) !== 0 || (perms & flag) !== 0,
  resolvePermissions: async (userId: string, serverId: string, channelId: string) => {
    const dbMod = require('../db/index');
    const srv = await dbMod.servers.findOne({ _id: serverId });
    if (srv?.ownerId === userId) return 0x7fffffff;
    const member = await dbMod.members.findOne({ userId, serverId });
    if (!member) return 0;
    const channel = await dbMod.channels.findOne({ _id: channelId, serverId });
    if (!channel || channel.permissionTestDeny === true) return 0;
    return (1 << 0) | (1 << 8);
  },
}));

import request from 'supertest';
import express from 'express';
const jwt     = require('jsonwebtoken');
const router  = require('../routes/scheduled');

function token(userId: string, extra = {}) {
  return jwt.sign({ id: userId, username: 'user', displayName: 'User', v: 0, ...extra }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/scheduled', router);
  app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

const FUTURE = Date.now() + 60 * 60 * 1000; // 1 hour from now

let app: express.Express;
let owner: UserFixture;
let member: UserFixture;
let outsider: UserFixture;
let server: ServerFixture;
let channel: ChannelFixture;

beforeEach(async () => {
  db = createMockDb();
  Object.assign(require('../db/loader'), db);
  Object.assign(require('../db/index'), db);

  owner    = makeUser({ username: 'owner' });
  member   = makeUser({ username: 'member' });
  outsider = makeUser({ username: 'outsider' });
  server   = makeServer(owner._id);
  channel  = makeChannel(server._id);

  await db.users.insert(owner);
  await db.users.insert(member);
  await db.users.insert(outsider);
  await db.servers.insert(server);
  await db.channels.insert(channel);
  await db.members.insert({ userId: owner._id,  serverId: server._id, roles: '[]', joinedAt: Date.now() });
  await db.members.insert({ userId: member._id, serverId: server._id, roles: '[]', joinedAt: Date.now() });

  app = buildApp();
});

// ═══════════════════════════════════════════════════════
// POST /api/scheduled
// ═══════════════════════════════════════════════════════
describe('POST /api/scheduled', () => {
  it('üye mesaj zamanlayabilir', async () => {
    const res = await request(app)
      .post('/api/scheduled')
      .set('Authorization', `Bearer ${token(member._id)}`)
      .send({ channelId: channel._id, serverId: server._id, content: 'Merhaba!', sendAt: new Date(FUTURE).toISOString() });
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('Merhaba!');
    expect(res.body.sent).toBe(false);
    expect(res.body.sendAt).toBeGreaterThan(Date.now());
  });

  it('2000 karakterden uzun içerik kısaltılır', async () => {
    const long = 'x'.repeat(3000);
    const res = await request(app)
      .post('/api/scheduled')
      .set('Authorization', `Bearer ${token(member._id)}`)
      .send({ channelId: channel._id, serverId: server._id, content: long, sendAt: new Date(FUTURE).toISOString() });
    expect(res.status).toBe(200);
    expect(res.body.content.length).toBe(2000);
  });

  it('geçmişte sendAt 400 döner', async () => {
    const past = Date.now() - 60000;
    const res = await request(app)
      .post('/api/scheduled')
      .set('Authorization', `Bearer ${token(member._id)}`)
      .send({ channelId: channel._id, serverId: server._id, content: 'test', sendAt: new Date(past).toISOString() });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/future/i);
  });

  it('30 günden fazla ilerisi 400 döner', async () => {
    const tooFar = Date.now() + 31 * 24 * 60 * 60 * 1000;
    const res = await request(app)
      .post('/api/scheduled')
      .set('Authorization', `Bearer ${token(member._id)}`)
      .send({ channelId: channel._id, serverId: server._id, content: 'test', sendAt: new Date(tooFar).toISOString() });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/30 days/i);
  });

  it('üye olmayan 403 alır', async () => {
    const res = await request(app)
      .post('/api/scheduled')
      .set('Authorization', `Bearer ${token(outsider._id)}`)
      .send({ channelId: channel._id, serverId: server._id, content: 'test', sendAt: new Date(FUTURE).toISOString() });
    expect(res.status).toBe(403);
  });

  it('channelId eksikse 400 döner', async () => {
    const res = await request(app)
      .post('/api/scheduled')
      .set('Authorization', `Bearer ${token(member._id)}`)
      .send({ serverId: server._id, content: 'test', sendAt: new Date(FUTURE).toISOString() });
    expect(res.status).toBe(400);
  });

  it('boş içerik 400 döner', async () => {
    const res = await request(app)
      .post('/api/scheduled')
      .set('Authorization', `Bearer ${token(member._id)}`)
      .send({ channelId: channel._id, serverId: server._id, content: '   ', sendAt: new Date(FUTURE).toISOString() });
    expect(res.status).toBe(400);
  });

  it('yanlış tipli scheduling alanlarını coercion yerine 400 ile reddeder', async () => {
    const invalidBodies = [
      { channelId: {}, serverId: server._id, content: 'x', sendAt: new Date(FUTURE).toISOString() },
      { channelId: channel._id, serverId: [], content: 'x', sendAt: new Date(FUTURE).toISOString() },
      { channelId: channel._id, serverId: server._id, content: {}, sendAt: new Date(FUTURE).toISOString() },
      { channelId: channel._id, serverId: server._id, content: 'x', sendAt: { valueOf: () => FUTURE } },
    ];
    for (const body of invalidBodies) {
      const res = await request(app)
        .post('/api/scheduled')
        .set('Authorization', `Bearer ${token(member._id)}`)
        .send(body);
      expect(res.status).toBe(400);
    }
  });

  it('başka sunucuya ait channelId ile mesaj zamanlanamaz', async () => {
    const otherServer = makeServer(owner._id);
    const otherChannel = makeChannel(otherServer._id);
    await db.servers.insert(otherServer);
    await db.channels.insert(otherChannel);
    const res = await request(app)
      .post('/api/scheduled')
      .set('Authorization', `Bearer ${token(member._id)}`)
      .send({ channelId: otherChannel._id, serverId: server._id, content: 'cross-tenant', sendAt: new Date(FUTURE).toISOString() });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mismatch/i);
  });

  it('channel override görünürlüğü/SEND_MESSAGES iznini kaldırdıysa 403 döner', async () => {
    await db.channels.update({ _id: channel._id }, { $set: { permissionTestDeny: true } });
    const res = await request(app)
      .post('/api/scheduled')
      .set('Authorization', `Bearer ${token(member._id)}`)
      .send({ channelId: channel._id, serverId: server._id, content: 'private', sendAt: new Date(FUTURE).toISOString() });
    expect(res.status).toBe(403);
  });

  it('token olmadan 401 döner', async () => {
    const res = await request(app)
      .post('/api/scheduled')
      .send({ channelId: channel._id, serverId: server._id, content: 'test', sendAt: new Date(FUTURE).toISOString() });
    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════
// GET /api/scheduled
// ═══════════════════════════════════════════════════════
describe('GET /api/scheduled', () => {
  it('kullanıcının bekleyen mesajlarını listeler', async () => {
    await db.scheduledMsgs.insert({ _id: 'sm1', userId: member._id, serverId: server._id, channelId: channel._id, content: 'test', sendAt: FUTURE, sent: false, createdAt: Date.now() });
    await db.scheduledMsgs.insert({ _id: 'sm2', userId: member._id, serverId: server._id, channelId: channel._id, content: 'sent', sendAt: FUTURE - 1000, sent: true,  createdAt: Date.now() });

    const res = await request(app)
      .get('/api/scheduled')
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Should not include already-sent messages
    expect(res.body.every((m: Record<string, unknown>) => m.sent === false)).toBe(true);
  });

  it('cancelled/failed satırları pending listesinde göstermez', async () => {
    await db.scheduledMsgs.insert({ _id: 'smCancelled', userId: member._id, serverId: server._id, channelId: channel._id, content: 'cancelled', sendAt: FUTURE, sent: false, cancelledAt: Date.now(), createdAt: Date.now() });
    await db.scheduledMsgs.insert({ _id: 'smFailed', userId: member._id, serverId: server._id, channelId: channel._id, content: 'failed', sendAt: FUTURE, sent: false, failedAt: Date.now(), createdAt: Date.now() });

    const res = await request(app)
      .get('/api/scheduled')
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(200);
    expect(res.body.map((m: Record<string, unknown>) => m._id)).not.toEqual(expect.arrayContaining(['smCancelled', 'smFailed']));
  });

  it('başka kullanıcının mesajlarını göstermez', async () => {
    await db.scheduledMsgs.insert({ _id: 'sm3', userId: owner._id, serverId: server._id, channelId: channel._id, content: 'owner msg', sendAt: FUTURE, sent: false, createdAt: Date.now() });

    const res = await request(app)
      .get('/api/scheduled')
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(200);
    expect(res.body.every((m: Record<string, unknown>) => m.userId === member._id)).toBe(true);
  });

  it('başka sunucuya ait channelId ile mesaj zamanlanamaz', async () => {
    const otherServer = makeServer(owner._id);
    const otherChannel = makeChannel(otherServer._id);
    await db.servers.insert(otherServer);
    await db.channels.insert(otherChannel);
    const res = await request(app)
      .post('/api/scheduled')
      .set('Authorization', `Bearer ${token(member._id)}`)
      .send({ channelId: otherChannel._id, serverId: server._id, content: 'cross-tenant', sendAt: new Date(FUTURE).toISOString() });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mismatch/i);
  });

  it('channel override görünürlüğü/SEND_MESSAGES iznini kaldırdıysa 403 döner', async () => {
    await db.channels.update({ _id: channel._id }, { $set: { permissionTestDeny: true } });
    const res = await request(app)
      .post('/api/scheduled')
      .set('Authorization', `Bearer ${token(member._id)}`)
      .send({ channelId: channel._id, serverId: server._id, content: 'private', sendAt: new Date(FUTURE).toISOString() });
    expect(res.status).toBe(403);
  });

  it('token olmadan 401 döner', async () => {
    const res = await request(app).get('/api/scheduled');
    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════
// DELETE /api/scheduled/:id
// ═══════════════════════════════════════════════════════
describe('DELETE /api/scheduled/:id', () => {
  it('bekleyen mesajı iptal eder', async () => {
    await db.scheduledMsgs.insert({ _id: 'smDel', userId: member._id, serverId: server._id, channelId: channel._id, content: 'cancel me', sendAt: FUTURE, sent: false, createdAt: Date.now() });

    const res = await request(app)
      .delete('/api/scheduled/smDel')
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(200);
    expect(res.body.cancelled).toBe(true);
  });

  it('aktif dispatcher lease varsa sahte cancellation success döndürmez', async () => {
    await db.scheduledMsgs.insert({
      _id: 'smClaimed', userId: member._id, serverId: server._id, channelId: channel._id,
      content: 'in flight', sendAt: FUTURE, sent: false, claimOwner: 'worker-a',
      claimUntil: Date.now() + 60_000, createdAt: Date.now(),
    });

    const res = await request(app)
      .delete('/api/scheduled/smClaimed')
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(409);
    const row = await requireDoc(db.scheduledMsgs, { _id: 'smClaimed' });
    expect(row.cancelledAt).toBeUndefined();
    expect(row.claimOwner).toBe('worker-a');
  });

  it('expired lease cancellation marks cancelledAt instead of deleting the durable row', async () => {
    await db.scheduledMsgs.insert({
      _id: 'smExpiredClaim', userId: member._id, serverId: server._id, channelId: channel._id,
      content: 'cancel after crash', sendAt: FUTURE, sent: false, claimOwner: 'dead-worker',
      claimUntil: Date.now() - 1, createdAt: Date.now(),
    });

    const res = await request(app)
      .delete('/api/scheduled/smExpiredClaim')
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(200);
    const row = await requireDoc(db.scheduledMsgs, { _id: 'smExpiredClaim' });
    expect(row.cancelledAt).toBeGreaterThan(0);
    expect(row.claimOwner).toBeNull();
  });

  it('gönderilmiş mesajı iptal edemez', async () => {
    await db.scheduledMsgs.insert({ _id: 'smSent', userId: member._id, serverId: server._id, channelId: channel._id, content: 'already sent', sendAt: FUTURE - 1000, sent: true, createdAt: Date.now() });

    const res = await request(app)
      .delete('/api/scheduled/smSent')
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already sent/i);
  });

  it('başka kullanıcının mesajını iptal edemez', async () => {
    await db.scheduledMsgs.insert({ _id: 'smOther', userId: owner._id, serverId: server._id, channelId: channel._id, content: 'owner msg', sendAt: FUTURE, sent: false, createdAt: Date.now() });

    const res = await request(app)
      .delete('/api/scheduled/smOther')
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(404);
  });

  it('mevcut olmayan mesaj 404 döner', async () => {
    const res = await request(app)
      .delete('/api/scheduled/nonexistent')
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(404);
  });
});
