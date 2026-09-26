// server/tests/messages.test.ts
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

import { recordOf } from './helpers/narrow';
import request from 'supertest';
import express from 'express';
const jwt     = require('jsonwebtoken');
import { createMockDb, makeChannel, makeMessage, makeServer, makeUser, requireDoc } from './helpers/mockDb';
import type { ChannelFixture, MessageFixture, MockDb, ServerFixture, UserFixture } from './helpers/mockDb';

let db: MockDb;

jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/index', () => {
  const { createMockDb } = require('./helpers/mockDb');
  db = createMockDb();
  return db;
});

jest.mock('../routes/roles', () => ({
  getMemberPerms: async () => 0,
  hasPermission:  (perms: number, permission: number) => (perms & permission) === permission,
  PERMS: { MANAGE_MESSAGES: 32, SEND_MESSAGES: 16 },
}));

jest.mock('../middleware/rateLimit', () => ({
  limits: { general: () => (_req: unknown, _res: unknown, next: () => void) => next(), messages: () => (_req: unknown, _res: unknown, next: () => void) => next(), react: () => (_req: unknown, _res: unknown, next: () => void) => next(), moderation: () => (_req: unknown, _res: unknown, next: () => void) => next() },
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import messagesRouter from '../routes/messages';
import { PERMS as CANONICAL_PERMS } from '../lib/permissions';

function makeToken(userId: string, username = 'tester') {
  return jwt.sign({ id: userId, username, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/channels', messagesRouter);
  app.use('/api/messages', messagesRouter);
  app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(500).json({ error: err.message }));
  return app;
}

let app: express.Express;
let token: string;
let otherToken: string;
let user: UserFixture;
let otherUser: UserFixture;
let server: ServerFixture;
let channel: ChannelFixture;

beforeEach(async () => {
  db = createMockDb();
  Object.assign(require('../db/loader'), db);
  Object.assign(require('../db/index'), db);

  user      = makeUser({ username: 'user1' });
  otherUser = makeUser({ username: 'user2' });
  server    = makeServer(user._id);
  channel   = makeChannel(server._id);

  await db.users.insert(user);
  await db.users.insert(otherUser);
  await db.servers.insert(server);
  await db.channels.insert(channel);
  await db.members.insert({ userId: user._id, serverId: server._id, joinedAt: Date.now() });

  token      = makeToken(user._id, user.username);
  otherToken = makeToken(otherUser._id, otherUser.username);

  app = buildApp();
});

// ══════════════════════════════════════════════════════════════
// MESAJ REAKSİYONLARI
// ══════════════════════════════════════════════════════════════
describe('POST /api/messages/:id/react — reaksiyon', () => {
  let msg: MessageFixture;

  beforeEach(async () => {
    msg = makeMessage(channel._id, server._id, user._id, { content: 'hello' });
    await db.messages.insert(msg);
  });

  it('reaksiyon ekler', async () => {
    const res = await request(app)
      .post(`/api/messages/${msg._id}/react`)
      .set('Authorization', `Bearer ${token}`)
      .send({ emoji: '👍' });

    if (res.status !== 200) console.error('DBG', res.status, JSON.stringify(res.body));
    expect(res.status).toBe(200);
    const updated = await requireDoc(db.messages, { _id: msg._id });
    expect(recordOf(updated.reactions, 'reaksiyonlar')['👍']).toContain(user._id);
  });

  it('aynı reaksiyona tekrar basmak kaldırır (toggle)', async () => {
    await request(app)
      .post(`/api/messages/${msg._id}/react`)
      .set('Authorization', `Bearer ${token}`)
      .send({ emoji: '👍' });

    const res = await request(app)
      .post(`/api/messages/${msg._id}/react`)
      .set('Authorization', `Bearer ${token}`)
      .send({ emoji: '👍' });

    expect(res.status).toBe(200);
    const updated = await requireDoc(db.messages, { _id: msg._id });
    expect(recordOf(updated.reactions, 'reaksiyonlar')['👍']).toBeFalsy();
  });

  it('boş emoji 400 döner', async () => {
    const res = await request(app)
      .post(`/api/messages/${msg._id}/react`)
      .set('Authorization', `Bearer ${token}`)
      .send({ emoji: '' });

    expect(res.status).toBe(400);
  });

  it('üye olmayan kullanıcı reaksiyon ekleyemez', async () => {
    const res = await request(app)
      .post(`/api/messages/${msg._id}/react`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ emoji: '❤️' });

    expect(res.status).toBe(403);
  });

  it('mevcut olmayan mesaj 404 döner', async () => {
    const res = await request(app)
      .post('/api/messages/nonexistent/react')
      .set('Authorization', `Bearer ${token}`)
      .send({ emoji: '👍' });

    expect(res.status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════
// MESAJ DÜZENLEME
// ══════════════════════════════════════════════════════════════
describe('PATCH /api/messages/:id — mesaj düzenle', () => {
  let msg: MessageFixture;

  beforeEach(async () => {
    msg = makeMessage(channel._id, server._id, user._id, { content: 'orijinal içerik' });
    await db.messages.insert(msg);
  });

  it('kendi mesajını düzenler', async () => {
    const res = await request(app)
      .patch(`/api/messages/${msg._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'düzenlenmiş içerik' });

    expect(res.status).toBe(200);
    const updated = await requireDoc(db.messages, { _id: msg._id });
    expect(updated.content).toBe('düzenlenmiş içerik');
    expect(updated.editedAt).toBeDefined();
  });

  it('başkasının mesajını düzenleyemez', async () => {
    await db.members.insert({ userId: otherUser._id, serverId: server._id, joinedAt: Date.now() });

    const res = await request(app)
      .patch(`/api/messages/${msg._id}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ content: 'hack denemesi' });

    expect(res.status).toBe(403);
  });

  it('boş içerik 400 döner', async () => {
    const res = await request(app)
      .patch(`/api/messages/${msg._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content: '' });

    expect(res.status).toBe(400);
  });

  it('mevcut olmayan mesaj 404 döner', async () => {
    const res = await request(app)
      .patch('/api/messages/nonexistent')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'test' });

    expect(res.status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════
// MESAJ SİLME
// ══════════════════════════════════════════════════════════════
describe('DELETE /api/messages/:id — mesaj sil', () => {
  let msg: MessageFixture;

  beforeEach(async () => {
    msg = makeMessage(channel._id, server._id, user._id);
    await db.messages.insert(msg);
  });

  it('kendi mesajını siler', async () => {
    const res = await request(app)
      .delete(`/api/messages/${msg._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const deleted = await requireDoc(db.messages, { _id: msg._id });
    expect(deleted).toMatchObject({ content: '[Mesaj silindi]', deletedBy: user._id });
    expect(deleted.deletedAt).toBeDefined();
  });

  it('başkasının mesajını silemez', async () => {
    await db.members.insert({ userId: otherUser._id, serverId: server._id, joinedAt: Date.now() });

    const res = await request(app)
      .delete(`/api/messages/${msg._id}`)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(403);
  });

  it('mevcut olmayan mesaj 404 döner', async () => {
    const res = await request(app)
      .delete('/api/messages/nonexistent')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════
// TOPLU MODERASYON — TENANT / KANAL AUTHORITY
// ══════════════════════════════════════════════════════════════
describe('DELETE /api/messages/bulk — authoritative message scope', () => {
  it('aynı sunucudaki mesajları owner/mod yetkisiyle toplu soft-delete eder', async () => {
    const a = makeMessage(channel._id, server._id, user._id, { content: 'spam-a' });
    const b = makeMessage(channel._id, server._id, user._id, { content: 'spam-b' });
    await db.messages.insert(a);
    await db.messages.insert(b);

    const res = await request(app)
      .delete('/api/messages/bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({ serverId: server._id, ids: [a._id, b._id] });

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(2);
    expect((await requireDoc(db.messages, { _id: a._id })).content).toBe('[Mesaj silindi]');
    expect((await requireDoc(db.messages, { _id: b._id })).content).toBe('[Mesaj silindi]');
  });

  it('Server B yetkisiyle Server A mesaj kimliklerini silmeyi reddeder', async () => {
    const foreignOwner = otherUser;
    const foreignServer = makeServer(foreignOwner._id);
    const foreignChannel = makeChannel(foreignServer._id);
    const foreignMessage = makeMessage(foreignChannel._id, foreignServer._id, foreignOwner._id, { content: 'foreign' });
    await db.servers.insert(foreignServer);
    await db.channels.insert(foreignChannel);
    await db.members.insert({ userId: foreignOwner._id, serverId: foreignServer._id, joinedAt: Date.now() });
    await db.messages.insert(foreignMessage);

    const res = await request(app)
      .delete('/api/messages/bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({ serverId: server._id, ids: [foreignMessage._id] });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/scope/i);
    expect((await requireDoc(db.messages, { _id: foreignMessage._id })).content).toBe('foreign');
  });

  it('/bulk route parametreli /:id rotasına düşmez', async () => {
    const res = await request(app)
      .delete('/api/messages/bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({ serverId: server._id, ids: ['missing-id'] });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/one or more messages/i);
  });
});


// ══════════════════════════════════════════════════════════════
// REVOKED CHANNEL VISIBILITY / REACTION PERMISSION
// ══════════════════════════════════════════════════════════════
describe('message mutation authorization follows the real message channel', () => {
  async function seedRevocableMessage(deny: number) {
    const scopedServer = makeServer(otherUser._id);
    const scopedChannel = makeChannel(scopedServer._id);
    const scopedMessage = makeMessage(scopedChannel._id, scopedServer._id, user._id, { content: 'before' });
    await db.servers.insert(scopedServer);
    await db.channels.insert(scopedChannel);
    await db.members.insert({ userId: otherUser._id, serverId: scopedServer._id, joinedAt: Date.now() });
    await db.members.insert({ userId: user._id, serverId: scopedServer._id, roles: [], joinedAt: Date.now() });
    await db.channelOverrides.insert({
      _id: `ovr-${deny}-${Date.now()}`,
      channelId: scopedChannel._id,
      serverId: scopedServer._id,
      targetType: 'user',
      targetId: user._id,
      allow: 0,
      deny,
    });
    await db.messages.insert(scopedMessage);
    return { scopedServer, scopedChannel, scopedMessage };
  }

  it('kanal görünürlüğü revoke edilmiş eski mesaj sahibi edit yapamaz', async () => {
    const { scopedMessage } = await seedRevocableMessage(CANONICAL_PERMS.VIEW_CHANNELS);
    const res = await request(app)
      .patch(`/api/messages/${scopedMessage._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'after' });
    expect(res.status).toBe(403);
    expect((await requireDoc(db.messages, { _id: scopedMessage._id })).content).toBe('before');
  });

  it('kanal görünürlüğü revoke edilmiş eski mesaj sahibi delete yapamaz', async () => {
    const { scopedMessage } = await seedRevocableMessage(CANONICAL_PERMS.VIEW_CHANNELS);
    const res = await request(app)
      .delete(`/api/messages/${scopedMessage._id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect((await requireDoc(db.messages, { _id: scopedMessage._id })).deletedAt).toBeUndefined();
  });

  it('ADD_REACTIONS deny edilmiş kanalda reaction mutation yapamaz', async () => {
    const { scopedMessage } = await seedRevocableMessage(CANONICAL_PERMS.ADD_REACTIONS);
    const res = await request(app)
      .post(`/api/messages/${scopedMessage._id}/react`)
      .set('Authorization', `Bearer ${token}`)
      .send({ emoji: '👍' });
    expect(res.status).toBe(403);
    expect((await requireDoc(db.messages, { _id: scopedMessage._id })).reactions ?? {}).toEqual({});
  });
});


describe('message route strict pagination and atomic reaction branches', () => {
  it.each(['-5', '0', '3x', '1.5', '101', '9007199254740992'])(
    'rejects malformed/out-of-range message limit %s before repository access', async (badLimit) => {
      const { Messages } = require('../db/repositories');
      const findSpy = jest.spyOn(Messages, 'findByChannel');
      const res = await request(app)
        .get(`/api/channels/${channel._id}/messages?limit=${encodeURIComponent(badLimit)}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/limit/i);
      expect(findSpy).not.toHaveBeenCalled();
      findSpy.mockRestore();
    },
  );

  it.each([
    'not-base64-json',
    Buffer.from(JSON.stringify({})).toString('base64'),
    Buffer.from(JSON.stringify({ ts: -1, id: 'm1', dir: 'before' })).toString('base64'),
    Buffer.from(JSON.stringify({ ts: 1, id: '', dir: 'before' })).toString('base64'),
    Buffer.from(JSON.stringify({ ts: 1, id: 'm1', dir: 'sideways' })).toString('base64'),
  ])('rejects malformed cursor %s before message query', async (cursor) => {
    const { Messages } = require('../db/repositories');
    const findSpy = jest.spyOn(Messages, 'findByChannel');
    const res = await request(app)
      .get(`/api/channels/${channel._id}/messages?cursor=${encodeURIComponent(cursor)}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cursor/i);
    expect(findSpy).not.toHaveBeenCalled();
    findSpy.mockRestore();
  });

  it.each(['abc', '-1', '1.5', '9007199254740992'])(
    'rejects malformed legacy before timestamp %s before repository access', async (value) => {
      const { Messages } = require('../db/repositories');
      const findSpy = jest.spyOn(Messages, 'findByChannel');
      const res = await request(app)
        .get(`/api/channels/${channel._id}/messages?before=${encodeURIComponent(value)}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/before\/after/i);
      expect(findSpy).not.toHaveBeenCalled();
      findSpy.mockRestore();
    },
  );

  it.each(['abc', '-1', '1.5', '9007199254740992'])(
    'rejects malformed legacy after timestamp %s before repository access', async (value) => {
      const { Messages } = require('../db/repositories');
      const findSpy = jest.spyOn(Messages, 'findByChannel');
      const res = await request(app)
        .get(`/api/channels/${channel._id}/messages?after=${encodeURIComponent(value)}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(findSpy).not.toHaveBeenCalled();
      findSpy.mockRestore();
    },
  );

  it('treats legacy after=0 as an explicit after cursor, not a cacheable first page', async () => {
    const { Messages } = require('../db/repositories');
    const raw = Array.from({ length: 6 }, (_, i) => makeMessage(channel._id, server._id, user._id, {
      _id: `after-zero-${i}`, createdAt: i + 1, ackId: `ack-${i}`,
    }));
    const findSpy = jest.spyOn(Messages, 'findByChannel').mockResolvedValueOnce(raw);
    const res = await request(app)
      .get(`/api/channels/${channel._id}/messages?after=0&limit=5`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(findSpy).toHaveBeenCalledWith(channel._id, expect.objectContaining({ after: 0, limit: 6 }));
    expect(res.body.messages.map((m: Record<string, unknown>) => m._id)).toEqual(raw.slice(0, 5).map((m) => m._id));
    expect(res.body.messages.every((m: Record<string, unknown>) => m.ackId === undefined)).toBe(true);
    findSpy.mockRestore();
  });

  it('legacy before pagination keeps the newest contiguous page when limit+1 rows exist', async () => {
    const { Messages } = require('../db/repositories');
    const raw = Array.from({ length: 6 }, (_, i) => makeMessage(channel._id, server._id, user._id, {
      _id: `before-page-${i}`, createdAt: i + 1,
    }));
    const findSpy = jest.spyOn(Messages, 'findByChannel').mockResolvedValueOnce(raw);
    const res = await request(app)
      .get(`/api/channels/${channel._id}/messages?before=999&limit=5`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.messages.map((m: Record<string, unknown>) => m._id)).toEqual(raw.slice(1).map((m) => m._id));
    findSpy.mockRestore();
  });

  it('accepts a canonical cursor and keeps ackId private', async () => {
    const m = makeMessage(channel._id, server._id, user._id, { createdAt: 20, ackId: 'private-ack' });
    await db.messages.insert(m);
    const { Messages } = require('../db/repositories');
    const findSpy = jest.spyOn(Messages, 'findByChannel');
    const cursor = Buffer.from(JSON.stringify({ ts: 10, id: 'older', dir: 'after' })).toString('base64');
    const res = await request(app)
      .get(`/api/channels/${channel._id}/messages?cursor=${encodeURIComponent(cursor)}&limit=10`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(findSpy).toHaveBeenCalledWith(channel._id, expect.objectContaining({
      after: 10,
      afterId: 'older',
      before: undefined,
      beforeId: undefined,
    }));
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].ackId).toBeUndefined();
    findSpy.mockRestore();
  });

  it('passes before cursor ids and rejects empty/oversized cursor inputs', async () => {
    const { Messages } = require('../db/repositories');
    const findSpy = jest.spyOn(Messages, 'findByChannel').mockResolvedValueOnce([]);
    const cursor = Buffer.from(JSON.stringify({ ts: 10, id: 'same-ms-boundary', dir: 'before' })).toString('base64');
    const good = await request(app)
      .get(`/api/channels/${channel._id}/messages?cursor=${encodeURIComponent(cursor)}&limit=10`)
      .set('Authorization', `Bearer ${token}`);
    expect(good.status).toBe(200);
    expect(findSpy).toHaveBeenCalledWith(channel._id, expect.objectContaining({
      before: 10,
      beforeId: 'same-ms-boundary',
      after: undefined,
      afterId: undefined,
    }));
    findSpy.mockClear();

    for (const raw of ['', 'x'.repeat(513)]) {
      const bad = await request(app)
        .get(`/api/channels/${channel._id}/messages?cursor=${encodeURIComponent(raw)}`)
        .set('Authorization', `Bearer ${token}`);
      expect(bad.status).toBe(400);
      expect(findSpy).not.toHaveBeenCalled();
    }
    findSpy.mockRestore();
  });

  it('rejects malformed bulk-delete bodies before permission or mutation', async () => {
    for (const body of [
      { serverId: server._id, ids: [] },
      { serverId: server._id, ids: Array.from({ length: 101 }, (_, i) => `m${i}`) },
      { serverId: server._id, ids: ['ok', 7] },
      { ids: ['m1'] },
    ]) {
      const r = await request(app)
        .delete('/api/messages/bulk')
        .set('Authorization', `Bearer ${token}`)
        .send(body);
      expect(r.status).toBe(400);
    }
  });

  it('requires server-level MANAGE_MESSAGES before resolving target rows', async () => {
    await db.members.insert({ userId: otherUser._id, serverId: server._id, roles: [], joinedAt: Date.now() });
    const msg = makeMessage(channel._id, server._id, user._id);
    await db.messages.insert(msg);
    const { Messages } = require('../db/repositories');
    const findSpy = jest.spyOn(Messages, 'findWhere');
    const r = await request(app)
      .delete('/api/messages/bulk')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ serverId: server._id, ids: [msg._id] });
    expect(r.status).toBe(403);
    expect(findSpy).not.toHaveBeenCalled();
    findSpy.mockRestore();
  });

  it('maps atomic unique-reaction cap to 400', async () => {
    const msg = makeMessage(channel._id, server._id, user._id, { content: 'atomic-cap' });
    await db.messages.insert(msg);
    const { Messages } = require('../db/repositories');
    const spy = jest.spyOn(Messages, 'toggleReactionAtomic').mockResolvedValueOnce(false);
    const r = await request(app)
      .post(`/api/messages/${msg._id}/react`)
      .set('Authorization', `Bearer ${token}`)
      .send({ emoji: '🔥' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/20 unique/i);
    spy.mockRestore();
  });

  it('returns refreshed message when atomic reaction path succeeds', async () => {
    const msg = makeMessage(channel._id, server._id, user._id, { content: 'atomic-ok' });
    await db.messages.insert(msg);
    const { Messages } = require('../db/repositories');
    const spy = jest.spyOn(Messages, 'toggleReactionAtomic').mockResolvedValueOnce(true);
    const r = await request(app)
      .post(`/api/messages/${msg._id}/react`)
      .set('Authorization', `Bearer ${token}`)
      .send({ emoji: '✅' });
    expect(r.status).toBe(200);
    expect(r.body._id).toBe(msg._id);
    spy.mockRestore();
  });

  it('fallback adapter enforces the same 20-unique-emoji cap', async () => {
    const reactions = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`e${i}`, ['other']]));
    const msg = makeMessage(channel._id, server._id, user._id, { content: 'fallback-cap', reactions });
    await db.messages.insert(msg);
    const { Messages } = require('../db/repositories');
    const spy = jest.spyOn(Messages, 'toggleReactionAtomic').mockResolvedValueOnce(null);
    const r = await request(app)
      .post(`/api/messages/${msg._id}/react`)
      .set('Authorization', `Bearer ${token}`)
      .send({ emoji: 'new' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/20 unique/i);
    spy.mockRestore();
  });

  it('fallback reaction path adds and then removes the current user without leaving an empty key', async () => {
    const msg = makeMessage(channel._id, server._id, user._id, { content: 'fallback-toggle', reactions: {} });
    await db.messages.insert(msg);
    const { Messages } = require('../db/repositories');
    const spy = jest.spyOn(Messages, 'toggleReactionAtomic').mockResolvedValue(null);
    try {
      const add = await request(app).post(`/api/messages/${msg._id}/react`)
        .set('Authorization', `Bearer ${token}`).send({ emoji: '🧪' });
      expect(add.status).toBe(200);
      expect(recordOf((await requireDoc(db.messages, { _id: msg._id })).reactions, 'reaksiyonlar')['🧪']).toContain(user._id);
      const remove = await request(app).post(`/api/messages/${msg._id}/react`)
        .set('Authorization', `Bearer ${token}`).send({ emoji: '🧪' });
      expect(remove.status).toBe(200);
      expect(recordOf((await requireDoc(db.messages, { _id: msg._id })).reactions, 'reaksiyonlar')['🧪']).toBeUndefined();
    } finally { spy.mockRestore(); }
  });

  it('refuses editing non-normal message types even for the message owner', async () => {
    const msg = makeMessage(channel._id, server._id, user._id, { content: 'file', type: 'file' });
    await db.messages.insert(msg);
    const res = await request(app).patch(`/api/messages/${msg._id}`)
      .set('Authorization', `Bearer ${token}`).send({ content: 'edited' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/message type/i);
  });

});
