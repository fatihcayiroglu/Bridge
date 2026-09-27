// server/tests/threads.test.ts
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

import { stringOf } from './helpers/narrow';
import request from 'supertest';
import express from 'express';
const jwt     = require('jsonwebtoken');
import { createMockDb, makeChannel, makeMessage, makeServer, makeUser, requireDoc } from './helpers/mockDb';
import type { ChannelFixture, MessageFixture, MockDb, ServerFixture, ThreadFixture, UserFixture } from './helpers/mockDb';

let db: MockDb;
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/index', () => {
  const { createMockDb } = require('./helpers/mockDb');
  db = createMockDb();
  return db;
});
jest.mock('../middleware/rateLimit', () => ({
  limits: { messages: () => (_req: unknown, _res: unknown, next: () => void) => next() },
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../lib/notifications', () => ({ processNotifications: jest.fn().mockResolvedValue(undefined) }));
// ── IZOLASYON SINIRI: IZIN COZUMU ──────────────────────────────────────────
// Bu suit THREAD MANTIGINI olcer; izin cozumunun KENDISI `channelPerms*` ve
// `permissions` suitlerinin isidir. Bu yuzden `routes/roles` stub'lanir ve
// karar `hasPermission` mock'u uzerinden yonlendirilir.
//
// EKSIK OLAN: `routes/threads.ts` kanonik cozumleyiciye gectiginde
// (`resolvePermissions`, satir 8/19) bu mock GUNCELLENMEDI. Sonuc her istekte
//     TypeError: (0 , roles_1.resolvePermissions) is not a function
// yani 500 -> bu dosyadaki 9 test dusuyordu. Eksik ad eklendi; karar yolu
// (asagidaki `hasPermission` mock'u) DEGISMEDI.
jest.mock('../routes/roles', () => ({
  getMemberPerms: async () => 0xFFFFFFFF,
  resolvePermissions: jest.fn(async () => 0xFFFFFFFF),
  hasPermission:  jest.fn(() => true),
  PERMS: { VIEW_CHANNELS: 1, SEND_MESSAGES: 2, READ_HISTORY: 8, MANAGE_MESSAGES: 4, ADMINISTRATOR: 64 },
}));

import threadsRouter from '../routes/threads';
const mockedRoles = require('../routes/roles');

function makeToken(userId: string) {
  return jwt.sign({ id: userId, username: 'tester', v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });
}

let app: express.Express;
let token: string;
let otherToken: string;
let user: UserFixture;
let otherUser: UserFixture;
let server: ServerFixture;
let channel: ChannelFixture;
let parentMsg: MessageFixture;

beforeEach(async () => {
  mockedRoles.hasPermission.mockReset();
  mockedRoles.hasPermission.mockReturnValue(true);
  mockedRoles.resolvePermissions.mockReset();
  mockedRoles.resolvePermissions.mockResolvedValue(0xFFFFFFFF);
  const { createMockDb, makeUser, makeServer, makeChannel, makeMessage } = require('./helpers/mockDb');
  db = createMockDb();
  Object.assign(require('../db/loader'), db);
  Object.assign(require('../db/index'), db);

  user      = makeUser();
  otherUser = makeUser();
  server    = makeServer(user._id);
  channel   = makeChannel(server._id);
  parentMsg = makeMessage(channel._id, server._id, user._id, { content: 'Thread başlangıcı' });

  await db.users.insert(user);
  await db.users.insert(otherUser);
  await db.servers.insert(server);
  await db.channels.insert(channel);
  await db.messages.insert(parentMsg);
  await db.members.insert({ userId: user._id, serverId: server._id, joinedAt: Date.now() });
  await db.members.insert({ userId: otherUser._id, serverId: server._id, joinedAt: Date.now() });

  token      = makeToken(user._id);
  otherToken = makeToken(otherUser._id);

  app = express();
  app.set('io', null); // explicit null — no global leak, routes guard with if (io)
  app.use(express.json());
  app.use('/api/threads', threadsRouter);
  app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(500).json({ error: err.message }));
});

// ══════════════════════════════════════════════════════════════
// THREAD OLUŞTURMA
// ══════════════════════════════════════════════════════════════
describe('POST /api/threads — thread oluştur', () => {
  it('mesajdan thread oluşturur', async () => {
    const res = await request(app)
      .post('/api/threads')
      .set('Authorization', `Bearer ${token}`)
      .send({ parentMessageId: parentMsg._id, name: 'Tartışma' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Tartışma');
    expect(res.body.parentMessageId).toBe(parentMsg._id);
    expect(res.body.channelId).toBe(channel._id);
    expect(res.body.serverId).toBe(server._id);
    expect(res.body.messageCount).toBe(0);
  });

  it('isim verilmezse mesaj içeriğinden isim alır', async () => {
    const res = await request(app)
      .post('/api/threads')
      .set('Authorization', `Bearer ${token}`)
      .send({ parentMessageId: parentMsg._id });

    expect(res.status).toBe(200);
    expect(res.body.name).toContain('Thread başlangıcı');
  });

  it('parentMessageId olmadan 400 döner', async () => {
    const res = await request(app)
      .post('/api/threads')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Test' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/parentMessageId/i);
  });

  it('mevcut olmayan mesaj 404 döner', async () => {
    const res = await request(app)
      .post('/api/threads')
      .set('Authorization', `Bearer ${token}`)
      .send({ parentMessageId: 'nonexistent' });

    expect(res.status).toBe(404);
  });

  it('aynı mesajdan ikinci thread 409 döner', async () => {
    await request(app)
      .post('/api/threads')
      .set('Authorization', `Bearer ${token}`)
      .send({ parentMessageId: parentMsg._id, name: 'İlk Thread' });

    const res = await request(app)
      .post('/api/threads')
      .set('Authorization', `Bearer ${token}`)
      .send({ parentMessageId: parentMsg._id, name: 'İkinci Thread' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it('eşzamanlı parent-thread create isteklerinden yalnız biri oluşturur', async () => {
    const make = () => request(app)
      .post('/api/threads')
      .set('Authorization', `Bearer ${token}`)
      .send({ parentMessageId: parentMsg._id, name: 'Race thread' });
    const results = await Promise.all([make(), make()]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    const rows = await db.threads.find({ parentMessageId: parentMsg._id });
    expect(rows).toHaveLength(1);
    const storedParent = await db.messages.findOne({ _id: parentMsg._id });
    expect(storedParent?.threadId).toBe(rows[0]?._id);
  });

  it('üye olmayan kullanıcı thread oluşturamaz', async () => {
    const outsider = makeUser();
    await db.users.insert(outsider);
    const outsiderToken = makeToken(outsider._id);

    const res = await request(app)
      .post('/api/threads')
      .set('Authorization', `Bearer ${outsiderToken}`)
      .send({ parentMessageId: parentMsg._id });

    expect(res.status).toBe(403);
  });

  it('parent-message thread creation fails closed when channel permissions disappear', async () => {
    mockedRoles.resolvePermissions.mockRejectedValueOnce(new Error('permission backend down'));
    mockedRoles.hasPermission.mockImplementation((perms: number) => perms !== 0);
    const res = await request(app).post('/api/threads').set('Authorization', `Bearer ${token}`).send({ parentMessageId: parentMsg._id });
    expect(res.status).toBe(403);
  });

  it('thread oluşturulunca orijinal mesaj threadId ile güncellenir', async () => {
    const res = await request(app)
      .post('/api/threads')
      .set('Authorization', `Bearer ${token}`)
      .send({ parentMessageId: parentMsg._id, name: 'Test' });

    const updatedMsg = await requireDoc(db.messages, { _id: parentMsg._id });
    expect(updatedMsg.threadId).toBe(res.body._id);
  });
});

// ══════════════════════════════════════════════════════════════
// THREAD BİLGİSİ
// ══════════════════════════════════════════════════════════════
describe('GET /api/threads/:threadId — thread bilgisi', () => {
  let thread: ThreadFixture;

  beforeEach(async () => {
    thread = {
      _id: 'thread1', channelId: channel._id, serverId: server._id,
      parentMessageId: parentMsg._id, name: 'Test Thread',
      createdBy: user._id, createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
    };
    await db.threads.insert(thread);
  });

  it('thread bilgisini döner', async () => {
    const res = await request(app)
      .get(`/api/threads/${thread._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body._id).toBe(thread._id);
    expect(res.body.name).toBe('Test Thread');
  });

  it('mevcut olmayan thread 404 döner', async () => {
    const res = await request(app)
      .get('/api/threads/nonexistent')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it('üye olmayan kullanıcı 403 alır', async () => {
    const outsider = makeUser();
    await db.users.insert(outsider);
    const outsiderToken = makeToken(outsider._id);

    const res = await request(app)
      .get(`/api/threads/${thread._id}`)
      .set('Authorization', `Bearer ${outsiderToken}`);

    expect(res.status).toBe(403);
  });
});

// ══════════════════════════════════════════════════════════════
// THREAD MESAJLARI
// ══════════════════════════════════════════════════════════════
describe('Thread mesajları', () => {
  let thread: ThreadFixture;

  beforeEach(async () => {
    thread = {
      _id: 'thread-msg-test', channelId: channel._id, serverId: server._id,
      parentMessageId: parentMsg._id, name: 'Mesaj Testi',
      createdBy: user._id, createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
    };
    await db.threads.insert(thread);
  });

  it('thread\'e mesaj gönderir', async () => {
    const res = await request(app)
      .post(`/api/threads/${thread._id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'Thread mesajı' });

    expect(res.status).toBe(200);
    expect(res.body.content).toBe('Thread mesajı');
    expect(res.body.threadId).toBe(thread._id);
  });

  it('boş mesaj 400 döner', async () => {
    const res = await request(app)
      .post(`/api/threads/${thread._id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content: '' });

    expect(res.status).toBe(400);
  });

  it('2000+ karakter mesaj reddedilir', async () => {
    const res = await request(app)
      .post(`/api/threads/${thread._id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'a'.repeat(2001) });

    expect(res.status).toBe(400);
  });

  it('thread mesajlarını listeler', async () => {
    await db.threadMessages.insert({
      _id: 'tm1', threadId: thread._id, channelId: channel._id, serverId: server._id,
      userId: user._id, username: user.username, displayName: user.displayName,
      avatarColor: '#2d9cdb', content: 'İlk mesaj', type: 'normal',
      reactions: {}, createdAt: Date.now(),
    });

    const res = await request(app)
      .get(`/api/threads/${thread._id}/messages`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('mevcut olmayan thread\'e mesaj gönderilemez', async () => {
    const res = await request(app)
      .post('/api/threads/nonexistent/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'Test' });

    expect(res.status).toBe(404);
  });

  it('timeout olan kullanıcı mesaj gönderemez', async () => {
    await db.members.update(
      { userId: user._id, serverId: server._id },
      { $set: { timeoutUntil: Date.now() + 60_000 } }
    );

    const res = await request(app)
      .post(`/api/threads/${thread._id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'Test' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/timed out/i);
  });
});


describe('Thread management visibility invariant', () => {
  let thread: ThreadFixture;
  beforeEach(async () => {
    thread = {
      _id: 'thread-manage-visibility', channelId: channel._id, serverId: server._id,
      parentMessageId: parentMsg._id, name: 'Hidden Thread',
      createdBy: user._id, createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
      pinned: false, locked: false,
    };
    await db.threads.insert(thread);
  });

  it.each([
    ['patch', 'pin', { pinned: true }],
    ['patch', 'lock', { locked: true }],
    ['delete', '', undefined],
  ])('%s management rejects MANAGE_MESSAGES when VIEW_CHANNELS is revoked', async (method, suffix, body) => {
    mockedRoles.hasPermission.mockImplementation((_perms: number, flag: number) => flag !== 1);
    const path = `/api/threads/${thread._id}${suffix ? `/${suffix}` : ''}`;
    // `request(app)[method]` DIZGE ile indeksleniyordu; supertest ajaninda
    // indeks imzasi yok. Yontem ACIKCA secilir.
    let req = method === 'patch'
      ? request(app).patch(path).set('Authorization', `Bearer ${token}`)
      : request(app).delete(path).set('Authorization', `Bearer ${token}`);
    if (body) req = req.send(body);
    const res = await req;
    expect(res.status).toBe(403);
    expect(await db.threads.findOne({ _id: thread._id })).toBeTruthy();
  });
});

// ══════════════════════════════════════════════════════════════
// PHASE 3 — forum, management, listing and failure branches
// ══════════════════════════════════════════════════════════════
describe('forum thread creation authority', () => {
  beforeEach(async () => {
    await db.channels.update({ _id: channel._id }, { $set: { type: 'forum' } });
    channel.type = 'forum';
  });

  it('creates a forum thread, sanitizes tags, persists first message and broadcasts', async () => {
    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));
    app.set('io', { to });
    const res = await request(app).post('/api/threads').set('Authorization', `Bearer ${token}`).send({
      channelId: channel._id,
      name: `  ${'N'.repeat(120)}  `,
      firstMessage: '  hello forum  ',
      tags: ['a', 'b', 'c', 'd', 'e', 'ignored', 'x'.repeat(30)],
    });
    expect(res.status).toBe(201);
    expect(res.body.thread.name).toHaveLength(100);
    expect(JSON.parse(res.body.thread.tags)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(res.body.thread.messageCount).toBe(1);
    const messages = await db.threadMessages.find({ threadId: res.body.thread._id });
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('hello forum');
    expect(to).toHaveBeenCalledWith(`channel:${channel._id}`);
    expect(emit).toHaveBeenCalledWith('forum:thread:created', expect.objectContaining({ _id: res.body.thread._id }));
  });

  it('creates a forum thread without firstMessage without inserting a thread message', async () => {
    const res = await request(app).post('/api/threads').set('Authorization', `Bearer ${token}`).send({ channelId: channel._id, name: 'No message' });
    expect(res.status).toBe(201);
    expect(res.body.thread.messageCount).toBe(0);
    expect(await db.threadMessages.find({ threadId: res.body.thread._id })).toHaveLength(0);
  });

  it('rejects missing name, missing channel and non-forum channel', async () => {
    expect((await request(app).post('/api/threads').set('Authorization', `Bearer ${token}`).send({ channelId: channel._id })).status).toBe(400);
    expect((await request(app).post('/api/threads').set('Authorization', `Bearer ${token}`).send({ channelId: 'missing', name: 'x' })).status).toBe(404);
    await db.channels.update({ _id: channel._id }, { $set: { type: 'text' } });
    expect((await request(app).post('/api/threads').set('Authorization', `Bearer ${token}`).send({ channelId: channel._id, name: 'x' })).status).toBe(400);
  });

  it('rejects non-member, timed-out member and permission resolution failure', async () => {
    const outsider = makeUser();
    await db.users.insert(outsider);
    expect((await request(app).post('/api/threads').set('Authorization', `Bearer ${makeToken(outsider._id)}`).send({ channelId: channel._id, name: 'x' })).status).toBe(403);

    await db.members.update({ userId: user._id, serverId: server._id }, { $set: { timeoutUntil: Date.now() + 60000 } });
    const timed = await request(app).post('/api/threads').set('Authorization', `Bearer ${token}`).send({ channelId: channel._id, name: 'x' });
    expect(timed.status).toBe(403);
    await db.members.update({ userId: user._id, serverId: server._id }, { $set: { timeoutUntil: 0 } });

    mockedRoles.resolvePermissions.mockRejectedValueOnce(new Error('permission backend down'));
    mockedRoles.hasPermission.mockImplementation((perms: number) => perms !== 0);
    const denied = await request(app).post('/api/threads').set('Authorization', `Bearer ${token}`).send({ channelId: channel._id, name: 'x' });
    expect(denied.status).toBe(403);
  });
});

describe('thread message read/write authority and realtime side effects', () => {
  let thread: ThreadFixture;
  beforeEach(async () => {
    thread = {
      _id: 'thread-extra-msg', channelId: channel._id, serverId: server._id,
      parentMessageId: parentMsg._id, name: 'Extra Messages', createdBy: otherUser._id,
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0, locked: false,
    };
    await db.threads.insert(thread);
  });

  it('GET messages clamps limit to 100, honors before, and reverses repository order', async () => {
    const now = Date.now();
    await db.threadMessages.insert({ _id: 'extra-a', threadId: thread._id, channelId: channel._id, serverId: server._id, userId: user._id, content: 'older', createdAt: now - 20 });
    await db.threadMessages.insert({ _id: 'extra-b', threadId: thread._id, channelId: channel._id, serverId: server._id, userId: user._id, content: 'newer', createdAt: now - 10 });
    const res = await request(app).get(`/api/threads/${thread._id}/messages?limit=999&before=${now}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.map((m: Record<string, unknown>) => m._id)).toEqual(['extra-a', 'extra-b']);
  });

  it('GET messages rejects negative, fractional and unsafe pagination input', async () => {
    for (const query of ['limit=-1', 'limit=1.5', 'limit=9007199254740992', 'before=-1', 'before=1.5', 'before=9007199254740992']) {
      const res = await request(app).get(`/api/threads/${thread._id}/messages?${query}`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
    }
  });

  it('GET messages rejects missing thread, non-member and revoked read permission', async () => {
    expect((await request(app).get('/api/threads/missing/messages').set('Authorization', `Bearer ${token}`)).status).toBe(404);
    const outsider = makeUser(); await db.users.insert(outsider);
    expect((await request(app).get(`/api/threads/${thread._id}/messages`).set('Authorization', `Bearer ${makeToken(outsider._id)}`)).status).toBe(403);
    mockedRoles.hasPermission.mockReturnValue(false);
    expect((await request(app).get(`/api/threads/${thread._id}/messages`).set('Authorization', `Bearer ${token}`)).status).toBe(403);
  });

  it('POST rejects locked thread, non-member and revoked channel permission', async () => {
    await db.threads.update({ _id: thread._id }, { $set: { locked: true } });
    expect((await request(app).post(`/api/threads/${thread._id}/messages`).set('Authorization', `Bearer ${token}`).send({ content: 'x' })).status).toBe(423);
    await db.threads.update({ _id: thread._id }, { $set: { locked: false } });
    const outsider = makeUser(); await db.users.insert(outsider);
    expect((await request(app).post(`/api/threads/${thread._id}/messages`).set('Authorization', `Bearer ${makeToken(outsider._id)}`).send({ content: 'x' })).status).toBe(403);
    mockedRoles.hasPermission.mockReturnValue(false);
    expect((await request(app).post(`/api/threads/${thread._id}/messages`).set('Authorization', `Bearer ${token}`).send({ content: 'x' })).status).toBe(403);
  });

  it('POST adds the thread creator as a notification participant when they have not posted yet', async () => {
    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));
    app.set('io', { to });
    app.set('socketUsers', new Map([['socket-creator', { id: otherUser._id }]]));
    const res = await request(app).post(`/api/threads/${thread._id}/messages`).set('Authorization', `Bearer ${token}`).send({ content: 'creator notify' });
    expect(res.status).toBe(200);
    expect(to).toHaveBeenCalledWith(`user:${otherUser._id}`);
    expect(emit).toHaveBeenCalledWith('notification:thread_reply', expect.objectContaining({ threadId: thread._id }));
  });

  it('POST broadcasts persisted message and notifies current readable participants only', async () => {
    await db.threadMessages.insert({ _id: 'old-participant', threadId: thread._id, channelId: channel._id, serverId: server._id, userId: otherUser._id, content: 'old', createdAt: Date.now() - 1 });
    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));
    app.set('io', { to });
    app.set('socketUsers', new Map([['socket-other', { _id: otherUser._id }], ['socket-self', { id: user._id }]]));
    const notifications = require('../lib/notifications');
    notifications.processNotifications.mockRejectedValueOnce(new Error('notification transport down'));

    const res = await request(app).post(`/api/threads/${thread._id}/messages`).set('Authorization', `Bearer ${token}`).send({ content: '  realtime reply  ' });
    expect(res.status).toBe(200);
    expect(to).toHaveBeenCalledWith(`thread:${thread._id}`);
    expect(emit).toHaveBeenCalledWith('thread:message:new', expect.objectContaining({ threadId: thread._id }));
    expect(to).toHaveBeenCalledWith(`user:${otherUser._id}`);
    expect(emit).toHaveBeenCalledWith('notification:thread_reply', expect.objectContaining({ fromUserId: user._id, preview: 'realtime reply' }));
    expect(notifications.processNotifications).toHaveBeenCalled();
  });
});

describe('forum listing and thread management branches', () => {
  async function seedThread(id: string, overrides = {}) {
    const t = {
      _id: id, channelId: channel._id, serverId: server._id, parentMessageId: parentMsg._id,
      name: id, createdBy: user._id, createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
      tags: '[]', pinned: false, locked: false, ...overrides,
    };
    await db.threads.insert(t); return t;
  }

  it('channel listing filters tag/search, parses malformed tags and supports top/new/latest sort with pinned first', async () => {
    await seedThread('alpha', { name: 'Alpha topic', tags: '["help"]', messageCount: 2, createdAt: 10, lastMessageAt: 30 });
    await seedThread('beta', { name: 'Beta topic', tags: 'not-json', messageCount: 9, createdAt: 20, lastMessageAt: 20, pinned: true });
    await seedThread('gamma', { name: 'Gamma help', tags: '["help"]', messageCount: 4, createdAt: 30, lastMessageAt: 40 });

    const tagged = await request(app).get(`/api/threads/channel/${channel._id}?tag=help&sort=top`).set('Authorization', `Bearer ${token}`);
    expect(tagged.status).toBe(200);
    expect(tagged.body.map((t: Record<string, unknown>) => t._id)).toEqual(['gamma', 'alpha']);
    expect(tagged.body[0].tags).toEqual(['help']);

    const searched = await request(app).get(`/api/threads/channel/${channel._id}?search=beta&sort=new`).set('Authorization', `Bearer ${token}`);
    expect(searched.body.map((t: Record<string, unknown>) => t._id)).toEqual(['beta']);
    expect(searched.body[0].tags).toEqual([]);

    const latest = await request(app).get(`/api/threads/channel/${channel._id}`).set('Authorization', `Bearer ${token}`);
    expect(latest.body[0]._id).toBe('beta'); // pinned wins after latest sort
  });

  it('channel listing rejects missing channel, non-member and revoked history permission', async () => {
    expect((await request(app).get('/api/threads/channel/missing').set('Authorization', `Bearer ${token}`)).status).toBe(404);
    const outsider = makeUser(); await db.users.insert(outsider);
    expect((await request(app).get(`/api/threads/channel/${channel._id}`).set('Authorization', `Bearer ${makeToken(outsider._id)}`)).status).toBe(403);
    mockedRoles.hasPermission.mockReturnValue(false);
    expect((await request(app).get(`/api/threads/channel/${channel._id}`).set('Authorization', `Bearer ${token}`)).status).toBe(403);
  });

  it('pin and lock mutate state and broadcast both true and false forms', async () => {
    const t = await seedThread('manage-thread');
    const emit = jest.fn(); const to = jest.fn(() => ({ emit })); app.set('io', { to });
    for (const [suffix, field] of [['pin', 'pinned'], ['lock', 'locked']]) {
      const on = await request(app).patch(`/api/threads/${t._id}/${suffix}`).set('Authorization', `Bearer ${token}`).send({ [field]: true });
      expect(on.status).toBe(200); expect(on.body[field]).toBe(1);
      const off = await request(app).patch(`/api/threads/${t._id}/${suffix}`).set('Authorization', `Bearer ${token}`).send({ [field]: false });
      expect(off.status).toBe(200); expect(off.body[field]).toBe(0);
    }
    expect(to).toHaveBeenCalledWith(`channel:${channel._id}`);
    expect(emit).toHaveBeenCalledWith('forum:thread:updated', expect.any(Object));
  });

  it('pin/lock validate boolean bodies and return 404 for a missing thread', async () => {
    const thread = await seedThread('pin-lock-validation');
    for (const body of [{ pinned: 'false' }, { pinned: 0 }, { pinned: 1 }, {}]) {
      const res = await request(app).patch(`/api/threads/${thread._id}/pin`).set('Authorization', `Bearer ${token}`).send(body);
      expect(res.status).toBe(400);
    }
    for (const body of [{ locked: 'false' }, { locked: 0 }, { locked: 1 }, {}]) {
      const res = await request(app).patch(`/api/threads/${thread._id}/lock`).set('Authorization', `Bearer ${token}`).send(body);
      expect(res.status).toBe(400);
    }

    expect((await request(app).patch('/api/threads/missing/pin').set('Authorization', `Bearer ${token}`).send({ pinned: true })).status).toBe(404);
    expect((await request(app).patch('/api/threads/missing/lock').set('Authorization', `Bearer ${token}`).send({ locked: true })).status).toBe(404);
  });

  it('creator edits name and bounded tags, empty patch is rejected, non-editor is denied', async () => {
    const t = await seedThread('edit-thread');
    const ok = await request(app).patch(`/api/threads/${t._id}`).set('Authorization', `Bearer ${token}`).send({ name: `  ${'X'.repeat(120)}  `, tags: ['a','b','c','d','e','f'] });
    expect(ok.status).toBe(200);
    const stored = await requireDoc(db.threads, { _id: t._id });
    expect(stringOf(stored.name, 'baslik').length).toBe(100);
    expect(JSON.parse(stringOf(stored.tags, 'etiketler'))).toEqual(['a','b','c','d','e']);
    expect((await request(app).patch(`/api/threads/${t._id}`).set('Authorization', `Bearer ${token}`).send({})).status).toBe(400);
    mockedRoles.hasPermission.mockReturnValue(false);
    expect((await request(app).patch(`/api/threads/${t._id}`).set('Authorization', `Bearer ${otherToken}`).send({ name: 'no' })).status).toBe(403);
  });

  it('DELETE removes thread and clears parent link; missing and unauthorized are rejected', async () => {
    const t = await seedThread('delete-thread');
    const ok = await request(app).delete(`/api/threads/${t._id}`).set('Authorization', `Bearer ${token}`);
    expect(ok.status).toBe(200);
    expect(await db.threads.findOne({ _id: t._id })).toBeNull();
    expect((await request(app).delete('/api/threads/missing').set('Authorization', `Bearer ${token}`)).status).toBe(404);
    const t2 = await seedThread('delete-thread-2');
    mockedRoles.hasPermission.mockReturnValue(false);
    expect((await request(app).delete(`/api/threads/${t2._id}`).set('Authorization', `Bearer ${token}`)).status).toBe(403);
  });
});

describe('thread runtime body type validation', () => {
  it.each([
    [{ parentMessageId: 7, name: 'x' }, 'parentMessageId'],
    [{ parentMessageId: parentMsg?._id, name: 7 }, 'name'],
    [{ parentMessageId: parentMsg?._id, firstMessage: { text: 'x' } }, 'firstMessage'],
    [{ channelId: channel?._id, name: 'forum', tags: 'help' }, 'tags'],
    [{ channelId: channel?._id, name: 'forum', tags: ['ok', 7] }, 'tags'],
  ])('rejects malformed create body %# instead of throwing', async (body, field) => {
    // Gövde her satirda FARKLI sekildedir; sozluk olarak ele alinir.
    const source = body as Record<string, unknown>;
    const concrete = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
    if (concrete.parentMessageId === undefined && source.parentMessageId === parentMsg?._id) concrete.parentMessageId = parentMsg._id;
    if (concrete.channelId === undefined && source.channelId === channel?._id) concrete.channelId = channel._id;
    const res = await request(app).post('/api/threads').set('Authorization', `Bearer ${token}`).send(concrete);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(new RegExp(field, 'i'));
  });

  it('rejects ambiguous parent/channel creation without touching either owner path', async () => {
    const res = await request(app).post('/api/threads').set('Authorization', `Bearer ${token}`).send({
      parentMessageId: parentMsg._id,
      channelId: channel._id,
      name: 'ambiguous',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/choose/i);
  });

  it('rejects non-string thread-message content as a 400', async () => {
    const thread = {
      _id: 'runtime-thread-message', channelId: channel._id, serverId: server._id,
      parentMessageId: parentMsg._id, name: 'runtime', createdBy: user._id,
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0,
    };
    await db.threads.insert(thread);
    for (const content of [7, { text: 'x' }, ['x']]) {
      const res = await request(app).post(`/api/threads/${thread._id}/messages`)
        .set('Authorization', `Bearer ${token}`).send({ content });
      expect(res.status).toBe(400);
    }
  });

  it('rejects malformed edit name/tags while preserving the existing truncation contract', async () => {
    const thread = {
      _id: 'runtime-thread-edit', channelId: channel._id, serverId: server._id,
      parentMessageId: parentMsg._id, name: 'runtime', createdBy: user._id,
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0, tags: '[]',
    };
    await db.threads.insert(thread);

    for (const body of [{ name: 7 }, { name: '   ' }, { tags: 'help' }, { tags: ['ok', 7] }]) {
      const res = await request(app).patch(`/api/threads/${thread._id}`)
        .set('Authorization', `Bearer ${token}`).send(body);
      expect(res.status).toBe(400);
    }

    const longName = `  ${'N'.repeat(120)}  `;
    const ok = await request(app).patch(`/api/threads/${thread._id}`)
      .set('Authorization', `Bearer ${token}`).send({ name: longName });
    expect(ok.status).toBe(200);
    expect((await requireDoc(db.threads, { _id: thread._id })).name).toHaveLength(100);
  });

  it('search tolerates a corrupted persisted null thread name instead of 500ing the channel', async () => {
    await db.threads.insert({
      _id: 'runtime-null-name', channelId: channel._id, serverId: server._id,
      parentMessageId: parentMsg._id, name: null, createdBy: user._id,
      createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0, tags: '[]',
    });
    const res = await request(app).get(`/api/threads/channel/${channel._id}?search=needle`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
