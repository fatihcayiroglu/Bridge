// server/tests/servers.test.ts
// Sunucu CRUD, davet sistemi, kanal yönetimi

process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV       = 'test';

import request from 'supertest';
import express from 'express';
const jwt     = require('jsonwebtoken');
import { createMockDb, makeChannel, makeServer, makeUser, requireDoc } from './helpers/mockDb';
import type { MockDb, MockCollection, UserFixture, ServerFixture, ChannelFixture } from './helpers/mockDb';

// ── Mock kurulumu ────────────────────────────────────────────
let mockDb: MockDb;

jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/index', () => {
  const { createMockDb } = require('./helpers/mockDb');
  mockDb = createMockDb();
  return mockDb;
});

jest.mock('../routes/roles', () => ({
  getMemberPerms:     async () => 0xFFFFFFFF,
  hasPermission:      () => true,
  PERMS: {
    MANAGE_CHANNELS: 32,
    ADMINISTRATOR:   64,
    SEND_MESSAGES:   2,
    KICK_MEMBERS:    8,
    BAN_MEMBERS:     16,
  },
}));

jest.mock('../middleware/rateLimit', () => ({
  limits: {
    servers:  () => (_req: unknown, _res: unknown, next: () => void) => next(),
    channels: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    invite:   () => (_req: unknown, _res: unknown, next: () => void) => next(),
    write:    () => (_req: unknown, _res: unknown, next: () => void) => next(),
    moderation: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  },
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import serversRouter from '../routes/servers';

function makeToken(userId: string, username = 'tester') {
  return jwt.sign({ id: userId, username, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });
}

function buildApp() {
  const app = express();
  app.set('io', null); // explicit null — no global leak, routes guard with if (io)
  app.use(express.json());
  app.use('/api/servers', serversRouter);
  app.use((err: Error, _req: express.Request, res: express.Response,
           _next: express.NextFunction) => res.status(500).json({ error: err.message }));
  return app;
}

// ── Ortak setup ───────────────────────────────────────────────
let app: express.Express;
let db: MockDb;
let ownerUser: UserFixture, otherUser: UserFixture;
let ownerToken: string, otherToken: string;

beforeEach(async () => {
  const { createMockDb, makeUser } = require('./helpers/mockDb');
  db = createMockDb();

  // index + loader mock'larını güncelle (repositories db/loader kullanır)
  const dbMod = require('../db/index');
  Object.assign(dbMod, db);
  Object.assign(require('../db/loader'), db);

  ownerUser = makeUser({ username: 'owner', displayName: 'Owner' });
  otherUser = makeUser({ username: 'other', displayName: 'Other' });
  await db.users.insert(ownerUser);
  await db.users.insert(otherUser);

  ownerToken = makeToken(ownerUser._id, ownerUser.username);
  otherToken = makeToken(otherUser._id, otherUser.username);

  app = buildApp();
});

// ══════════════════════════════════════════════════════════════
// SUNUCU OLUŞTURMA
// ══════════════════════════════════════════════════════════════
describe('POST /api/servers — sunucu oluştur', () => {
  it('geçerli isimle sunucu oluşturur', async () => {
    const res = await request(app)
      .post('/api/servers')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'My Server', icon: '🎮' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('My Server');
    expect(res.body.icon).toBe('🎮');
    expect(res.body.ownerId).toBe(ownerUser._id);
    expect(res.body._id).toBeDefined();
  });

  it('varsayılan ikon kullanır', async () => {
    const res = await request(app)
      .post('/api/servers')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Ikonlu' });

    expect(res.status).toBe(200);
    expect(res.body.icon).toBe('🌐');
  });

  it('isim olmadan 400 döner', async () => {
    const res = await request(app)
      .post('/api/servers')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name required/i);
  });

  it('50 karakterden uzun isim reddedilir', async () => {
    const res = await request(app)
      .post('/api/servers')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'a'.repeat(51) });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too long/i);
  });

  it('token olmadan 401 döner', async () => {
    const res = await request(app)
      .post('/api/servers')
      .send({ name: 'No Auth' });

    expect(res.status).toBe(401);
  });

  it('sunucu oluşturulunca genel ve voice kanallar eklenir', async () => {
    const res = await request(app)
      .post('/api/servers')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Kanal Test' });

    expect(res.status).toBe(200);
    const channels = await db.channels.find({ serverId: res.body._id });
    expect(channels.length).toBeGreaterThanOrEqual(2);
    expect(channels.some(c => c.type === 'text')).toBe(true);
    expect(channels.some(c => c.type === 'voice')).toBe(true);
  });

  it('oluşturucu otomatik üye olur', async () => {
    const res = await request(app)
      .post('/api/servers')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Üyelik Test' });

    const membership = await db.members.findOne({ userId: ownerUser._id, serverId: res.body._id });
    expect(membership).not.toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════
// SUNUCU GÜNCELLEME
// ══════════════════════════════════════════════════════════════
describe('PATCH /api/servers/:sid — sunucu güncelle', () => {
  let server: ServerFixture;

  beforeEach(async () => {
    server = makeServer(ownerUser._id, { name: 'Eski İsim' });
    await db.servers.insert(server);
    await db.members.insert({ userId: ownerUser._id, serverId: server._id, joinedAt: Date.now() });
  });

  it('sahip ismi günceller', async () => {
    const res = await request(app)
      .patch(`/api/servers/${server._id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Yeni İsim' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Yeni İsim');
  });

  it('sahip olmayan kullanıcı 403 alır', async () => {
    await db.members.insert({ userId: otherUser._id, serverId: server._id, joinedAt: Date.now() });
    const res = await request(app)
      .patch(`/api/servers/${server._id}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ name: 'Hack' });

    expect(res.status).toBe(403);
  });

  it('mevcut olmayan sunucu 404 döner', async () => {
    const res = await request(app)
      .patch('/api/servers/nonexistent')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Test' });

    expect(res.status).toBe(404);
  });

  it('boş update 400 döner', async () => {
    const res = await request(app)
      .patch(`/api/servers/${server._id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({});

    expect(res.status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════
// PUBLIC SUNUCUYA DOĞRUDAN KATILMA
// ══════════════════════════════════════════════════════════════
describe('POST /api/servers/:sid/join', () => {
  let server: ServerFixture;

  beforeEach(async () => {
    server = makeServer(ownerUser._id);
    await db.servers.insert(server);
    await db.members.insert({ userId: ownerUser._id, serverId: server._id, joinedAt: Date.now() });
  });

  it('banlı kullanıcıyı yeniden katılmış gibi göstermeden reddeder', async () => {
    await db.members.insert({ userId: otherUser._id, serverId: server._id, banned: true, joinedAt: Date.now() });

    const res = await request(app)
      .post(`/api/servers/${server._id}/join`)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('BANNED');
    const row = await db.members.findOne({ userId: otherUser._id, serverId: server._id });
    expect(row?.banned).toBe(true);
  });


  it('private sunucuya ID bilinerek davetsiz katılımı reddeder', async () => {
    const res = await request(app)
      .post(`/api/servers/${server._id}/join`)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('INVITE_REQUIRED');
    expect(await db.members.findOne({ userId: otherUser._id, serverId: server._id })).toBeNull();
  });

  it('discoverable sunucuya doğrudan katılıma izin verir', async () => {
    await db.servers.update({ _id: server._id }, { $set: { discoverable: true } });

    const res = await request(app)
      .post(`/api/servers/${server._id}/join`)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(200);
    expect(await db.members.findOne({ userId: otherUser._id, serverId: server._id })).not.toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════
// SUNUCUDAN AYRILMA
// ══════════════════════════════════════════════════════════════
describe('POST /api/servers/:sid/leave', () => {
  let server: ServerFixture;

  beforeEach(async () => {
    server = makeServer(ownerUser._id);
    await db.servers.insert(server);
    await db.members.insert({ userId: ownerUser._id, serverId: server._id, joinedAt: Date.now() });
    await db.members.insert({ userId: otherUser._id, serverId: server._id, joinedAt: Date.now() });
  });

  it('üye sunucudan ayrılır', async () => {
    const res = await request(app)
      .post(`/api/servers/${server._id}/leave`)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(200);
    expect(res.body.left).toBe(true);

    const membership = await db.members.findOne({ userId: otherUser._id, serverId: server._id });
    expect(membership).toBeNull();
  });

  it('sahip ayrılamaz', async () => {
    const res = await request(app)
      .post(`/api/servers/${server._id}/leave`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/owner/i);
  });

  it('üye olmayan kullanıcı 400 alır', async () => {
    const stranger = makeUser();
    await db.users.insert(stranger);
    const strangerToken = makeToken(stranger._id);

    const res = await request(app)
      .post(`/api/servers/${server._id}/leave`)
      .set('Authorization', `Bearer ${strangerToken}`);

    expect(res.status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════
// DAVET SİSTEMİ
// ══════════════════════════════════════════════════════════════
describe('Davet sistemi', () => {
  let server: ServerFixture;

  beforeEach(async () => {
    server = makeServer(ownerUser._id);
    await db.servers.insert(server);
    await db.members.insert({ userId: ownerUser._id, serverId: server._id, joinedAt: Date.now() });
  });

  it('davet kodu oluşturur', async () => {
    const res = await request(app)
      .post('/api/servers/invites')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ serverId: server._id });

    expect(res.status).toBe(200);
    expect(res.body.code).toBeDefined();
    expect(res.body.expiresAt).toBeGreaterThan(Date.now());
    expect(res.body.serverName).toBe(server.name);
  });

  it('geçerli kodla sunucuya katılır', async () => {
    const createRes = await request(app)
      .post('/api/servers/invites')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ serverId: server._id });

    const { code } = createRes.body;

    const joinRes = await request(app)
      .post(`/api/servers/invites/${code}/use`)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(joinRes.status).toBe(200);
    const membership = await db.members.findOne({ userId: otherUser._id, serverId: server._id });
    expect(membership).not.toBeNull();
  });

  it('geçersiz kod 404 döner', async () => {
    const res = await request(app)
      .post('/api/servers/invites/invalidcode/use')
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(404);
  });

  it('süresi dolmuş davet 410 döner', async () => {
    await db.invites.insert({
      _id: 'inv1', code: 'expired', serverId: server._id,
      createdBy: ownerUser._id, expiresAt: Date.now() - 1000,
      maxUses: 0, uses: 0,
    });

    const res = await request(app)
      .post('/api/servers/invites/expired/use')
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/expired/i);
  });

  it('maxUses dolunca 410 döner', async () => {
    await db.invites.insert({
      _id: 'inv2', code: 'full', serverId: server._id,
      createdBy: ownerUser._id, expiresAt: Date.now() + 99999,
      maxUses: 3, uses: 3,
    });

    const res = await request(app)
      .post('/api/servers/invites/full/use')
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/maximum/i);
  });

  it('zaten üye olanlar tekrar katılamaz', async () => {
    await db.invites.insert({
      _id: 'inv3', code: 'valid', serverId: server._id,
      createdBy: ownerUser._id, expiresAt: Date.now() + 99999,
      maxUses: 0, uses: 0,
    });
    await db.members.insert({ userId: otherUser._id, serverId: server._id, joinedAt: Date.now() });

    const res = await request(app)
      .post('/api/servers/invites/valid/use')
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already a member/i);
  });

  it('üye olmayan kullanıcı davet oluşturamaz', async () => {
    const res = await request(app)
      .post('/api/servers/invites')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ serverId: server._id });

    expect(res.status).toBe(403);
  });
});

// ══════════════════════════════════════════════════════════════
// KANAL YÖNETİMİ
// ══════════════════════════════════════════════════════════════
describe('Kanal yönetimi', () => {
  let server: ServerFixture, channel: ChannelFixture;

  beforeEach(async () => {
    server  = makeServer(ownerUser._id);
    channel = makeChannel(server._id);
    await db.servers.insert(server);
    await db.channels.insert(channel);
    await db.members.insert({ userId: ownerUser._id, serverId: server._id, joinedAt: Date.now() });
  });

  it('üye kanal listesini alır', async () => {
    const res = await request(app)
      .get(`/api/servers/${server._id}/channels`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((c: { _id: string }) => c._id === channel._id)).toBe(true);
  });

  it('üye olmayan kanal listesini alamaz', async () => {
    const res = await request(app)
      .get(`/api/servers/${server._id}/channels`)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(403);
  });

  it('izni olan kullanıcı kanal oluşturur', async () => {
    const res = await request(app)
      .post(`/api/servers/${server._id}/channels`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'yeni-kanal', type: 'text' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('yeni-kanal');
    expect(res.body.serverId).toBe(server._id);
  });

  it('geçersiz kanal türü reddedilir', async () => {
    const res = await request(app)
      .post(`/api/servers/${server._id}/channels`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'test', type: 'invalid' });

    expect(res.status).toBe(400);
  });

  it('kanal silinir', async () => {
    // The route deliberately protects the final server channel.  Seed a
    // second channel so this case proves an ordinary graph deletion instead
    // of weakening that invariant.
    await db.channels.insert(makeChannel(server._id));
    const res = await request(app)
      .delete(`/api/servers/${server._id}/channels/${channel._id}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  it('mevcut olmayan kanal silinmeye çalışılınca 404 döner', async () => {
    const res = await request(app)
      .delete(`/api/servers/${server._id}/channels/nonexistent`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════
// SUNUCU SİLME — KASKAD
// ══════════════════════════════════════════════════════════════
describe('DELETE /api/servers/:sid — sunucu sil', () => {
  let server: ServerFixture, channel: ChannelFixture;

  beforeEach(async () => {
    server  = makeServer(ownerUser._id, { name: 'Silinecek Sunucu' });
    channel = makeChannel(server._id);
    await db.servers.insert(server);
    await db.channels.insert(channel);
    await db.members.insert({ userId: ownerUser._id, serverId: server._id, joinedAt: Date.now() });
    await db.members.insert({ userId: otherUser._id, serverId: server._id, joinedAt: Date.now() });
  });

  it('sahip sunucuyu silebilir', async () => {
    const res = await request(app)
      .delete(`/api/servers/${server._id}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    const deleted = await db.servers.findOne({ _id: server._id });
    expect(deleted).toBeNull();
  });

  it('canonical graph delete removes server/channel-scoped durable rows and preserves another tenant', async () => {
    const otherServer = makeServer(ownerUser._id, { name: 'Korunacak Sunucu' });
    const otherChannel = makeChannel(otherServer._id);
    await db.servers.insert(otherServer);
    await db.channels.insert(otherChannel);

    const sid = server._id;
    const cid = channel._id;
    const now = Date.now();
    await db.messages.insert({ _id:'del-msg-graph', serverId:sid, channelId:cid, userId:ownerUser._id, content:'x', createdAt:now });
    await db.polls.insert({ _id:'del-poll', serverId:sid, channelId:cid, createdBy:ownerUser._id, question:'q', options:[], createdAt:now });
    await db.automodRules.insert({ _id:'del-rule', serverId:sid, type:'blocked_words', enabled:true, config:{ words:['x'] }, createdBy:ownerUser._id, createdAt:now });
    await db.channelPermissions.insert({ _id:'del-perm', serverId:sid, channelId:cid, roleId:'__everyone__', allow:0, deny:1, createdAt:now });
    await db.notificationPrefs.insert({ _id:'del-pref', userId:ownerUser._id, channelId:cid, level:'mute', createdAt:now });
    await db.notificationPrefs.insert({ _id:'del-server-pref', userId:ownerUser._id, channelId:`server:${sid}`, level:'mentions', createdAt:now });
    await db.savedMessages.insert({ _id:'del-saved', userId:ownerUser._id, destinationType:'channel', destinationId:cid, messageId:'del-msg-graph', createdAt:now });
    await db.outgoingWebhooks.insert({ _id:'del-hook', serverId:sid, name:'h', url:'https://example.test', events:['message:new'], enabled:true, createdBy:ownerUser._id, createdAt:now });
    await db.outgoingWebhookDeliveries.insert({ _id:'del-delivery', webhookId:'del-hook', serverId:sid, eventName:'message:new', payload:{}, attempts:0, nextAt:now, createdAt:now });
    await db.serverOnboarding.insert({ _id:'del-onboarding', serverId:sid, enabled:true, createdAt:now });
    await db.onboardingCompletions.insert({ _id:'del-onboarding-user', serverId:sid, userId:ownerUser._id, completedAt:now, answers:{} });
    await db.bots.insert({ _id:'del-bot', serverId:sid, ownerId:ownerUser._id, username:'bot', active:true, createdAt:now });
    await db.botRatings.insert({ _id:'del-rating', botId:'del-bot', userId:otherUser._id, rating:5, createdAt:now });
    await db.serverBots.insert({ _id:'del-install', botId:'del-bot', serverId:otherServer._id, addedBy:otherUser._id, addedAt:now });

    await db.messages.insert({ _id:'keep-msg', serverId:otherServer._id, channelId:otherChannel._id, userId:ownerUser._id, content:'keep', createdAt:now });
    await db.automodRules.insert({ _id:'keep-rule', serverId:otherServer._id, type:'blocked_words', enabled:true, config:{}, createdBy:ownerUser._id, createdAt:now });

    const res = await request(app).delete(`/api/servers/${sid}`).set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);

    // Cift elemanli diziler, aciklama olmadan `(MockCollection | {...})[][]`
    // olarak cikarilir ve `.find` cagrilamaz hale gelir. Demet tipi gercek
    // sekli soyler.
    const cleanupChecks: Array<[MockCollection, Record<string, unknown>]> = [
      [db.messages, { serverId:sid }],
      [db.polls, { serverId:sid }],
      [db.automodRules, { serverId:sid }],
      [db.channelPermissions, { serverId:sid }],
      [db.outgoingWebhooks, { serverId:sid }],
      [db.outgoingWebhookDeliveries, { serverId:sid }],
      [db.serverOnboarding, { serverId:sid }],
      [db.onboardingCompletions, { serverId:sid }],
      [db.bots, { serverId:sid }],
    ];
    for (const [collection, query] of cleanupChecks)
      expect(await collection.find(query)).toHaveLength(0);
    expect(await db.notificationPrefs.find({ channelId:cid })).toHaveLength(0);
    expect(await db.notificationPrefs.find({ channelId:`server:${sid}` })).toHaveLength(0);
    expect(await db.savedMessages.find({ destinationId:cid })).toHaveLength(0);
    expect(await db.botRatings.find({ botId:'del-bot' })).toHaveLength(0);
    expect(await db.serverBots.find({ botId:'del-bot' })).toHaveLength(0);

    expect(await db.servers.findOne({ _id:otherServer._id })).not.toBeNull();
    expect(await db.messages.findOne({ _id:'keep-msg' })).not.toBeNull();
    expect(await db.automodRules.findOne({ _id:'keep-rule' })).not.toBeNull();
  });

  it('sahiplik transaction kilidinden önce değişirse eski owner silemez', async () => {
    const spy = jest.spyOn(require('../db/repositories').Servers, 'deleteGraphAtomic').mockResolvedValueOnce('owner_mismatch');
    const res = await request(app)
      .delete(`/api/servers/${server._id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(403);
    expect(spy).toHaveBeenCalledWith(server._id, ownerUser._id);
    spy.mockRestore();
  });

  it('sahip olmayan kullanıcı silemez', async () => {
    const res = await request(app)
      .delete(`/api/servers/${server._id}`)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(403);
    const still = await db.servers.findOne({ _id: server._id });
    expect(still).not.toBeNull();
  });

  it('mevcut olmayan sunucu 404 döner', async () => {
    const res = await request(app)
      .delete('/api/servers/nonexistent')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(404);
  });
});
describe('GET /api/servers/:sid/members', () => {
  let server: ServerFixture;

  beforeEach(async () => {
    server = makeServer(ownerUser._id);
    await db.servers.insert(server);
    await db.members.insert({ userId: ownerUser._id, serverId: server._id, joinedAt: Date.now() });
  });

  it('üye listesini döner', async () => {
    const res = await request(app)
      .get(`/api/servers/${server._id}/members`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((u: { _id: string }) => u._id === ownerUser._id)).toBe(true);
  });

  it('limit/cursor ile aynı joinedAt değerlerinde kayıpsız yapılandırılmış sayfa döner', async () => {
    await db.members.update(
      { userId: ownerUser._id, serverId: server._id },
      { $set: { joinedAt: 100, nickname: 'Owner nick' } },
    );
    await db.members.insert({
      userId: otherUser._id,
      serverId: server._id,
      joinedAt: 100,
      nickname: 'Other nick',
      banned: false,
    });
    const expectedIds = [ownerUser._id, otherUser._id].sort();

    const first = await request(app)
      .get(`/api/servers/${server._id}/members?limit=1`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(first.status).toBe(200);
    expect(first.body).toEqual(expect.objectContaining({
      members: [expect.objectContaining({ _id: expectedIds[0] })],
      hasMore: true,
      limit: 1,
      count: 1,
      nextCursor: expect.any(String),
    }));
    expect(first.body.members[0].password).toBeUndefined();
    expect(first.body.members[0].nickname).toBe(
      expectedIds[0] === ownerUser._id ? 'Owner nick' : 'Other nick',
    );
    expect(JSON.parse(Buffer.from(first.body.nextCursor, 'base64').toString('utf8'))).toEqual({
      joinedAt: 100,
      userId: expectedIds[0],
    });

    const second = await request(app)
      .get(`/api/servers/${server._id}/members?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(expect.objectContaining({
      members: [expect.objectContaining({ _id: expectedIds[1] })],
      hasMore: false,
      nextCursor: null,
      limit: 1,
      count: 1,
    }));
  });

  it.each(['', '0', '101', '1.5', 'abc', '9007199254740992'])(
    'pagination rejects invalid member limit %s before page access',
    async (badLimit) => {
      const { Members } = require('../db/repositories');
      const pageSpy = jest.spyOn(Members, 'findPageByServer');
      const res = await request(app)
        .get(`/api/servers/${server._id}/members?limit=${encodeURIComponent(badLimit)}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/limit/i);
      expect(pageSpy).not.toHaveBeenCalled();
      pageSpy.mockRestore();
    },
  );

  it.each([
    '',
    'not-base64-json',
    Buffer.from(JSON.stringify({})).toString('base64'),
    Buffer.from(JSON.stringify({ joinedAt: -1, userId: 'u' })).toString('base64'),
    Buffer.from(JSON.stringify({ joinedAt: 1, userId: '' })).toString('base64'),
    'x'.repeat(513),
  ])('pagination rejects invalid member cursor %s before page access', async (badCursor) => {
    const { Members } = require('../db/repositories');
    const pageSpy = jest.spyOn(Members, 'findPageByServer');
    const res = await request(app)
      .get(`/api/servers/${server._id}/members?cursor=${encodeURIComponent(badCursor)}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cursor/i);
    expect(pageSpy).not.toHaveBeenCalled();
    pageSpy.mockRestore();
  });

  it('şifreyi dışarı sızdırmaz', async () => {
    const res = await request(app)
      .get(`/api/servers/${server._id}/members`)
      .set('Authorization', `Bearer ${ownerToken}`);

    for (const user of res.body) {
      expect(user.password).toBeUndefined();
    }
  });

  it('üye olmayan kullanıcı 403 alır', async () => {
    const res = await request(app)
      .get(`/api/servers/${server._id}/members`)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(403);
  });
});

// ══════════════════════════════════════════════════════════════
// QR KOD DAVET
// ══════════════════════════════════════════════════════════════
describe('QR kod davet endpoint\'leri', () => {
  let server: ServerFixture, inviteCode: string;

  beforeEach(async () => {
    server = makeServer(ownerUser._id);
    await db.servers.insert(server);
    await db.members.insert({ userId: ownerUser._id, serverId: server._id, joinedAt: Date.now() });

    // Davet oluştur
    const createRes = await request(app)
      .post('/api/servers/invites')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ serverId: server._id });

    inviteCode = createRes.body.code;
  });

  it('SVG QR kod döner', async () => {
    const res = await request(app)
      .get(`/api/servers/invites/${inviteCode}/qr`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/svg/);
    expect(res.text ?? res.body?.toString('utf8')).toContain('<svg');
  });

  it('QR data URL JSON döner', async () => {
    const res = await request(app)
      .get(`/api/servers/invites/${inviteCode}/qr/data`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(inviteCode);
    expect(res.body.inviteUrl).toContain(inviteCode);
    expect(res.body.qrDataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(res.body.serverName).toBe(server.name);
    expect(res.body.expiresAt).toBeGreaterThan(Date.now());
  });

  it('geçersiz kod 404 döner', async () => {
    const res = await request(app)
      .get('/api/servers/invites/invalidcode123/qr')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(404);
  });

  it('süresi dolmuş davet QR 410 döner', async () => {
    await db.invites.insert({
      _id: 'expired-qr', code: 'expiredqr', serverId: server._id,
      createdBy: ownerUser._id, expiresAt: Date.now() - 1000,
      maxUses: 0, uses: 0,
    });

    const res = await request(app)
      .get('/api/servers/invites/expiredqr/qr')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(410);
  });

  it('token olmadan 401 döner', async () => {
    const res = await request(app)
      .get(`/api/servers/invites/${inviteCode}/qr`);

    expect(res.status).toBe(401);
  });
});
