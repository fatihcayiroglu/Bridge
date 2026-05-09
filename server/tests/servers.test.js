// server/tests/servers.test.js
// Sunucu CRUD, davet sistemi, kanal yönetimi

process.env.JWT_SECRET     = 'test-jwt-secret';
process.env.REFRESH_SECRET = 'test-refresh-secret';
process.env.NODE_ENV       = 'test';

const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { createMockDb, makeUser, makeServer, makeChannel } = require('./helpers/mockDb');

// ── Mock kurulumu ────────────────────────────────────────────
let mockDb;

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
    servers:  () => (req, res, next) => next(),
    channels: () => (req, res, next) => next(),
    invite:   () => (req, res, next) => next(),
  },
  rateLimit: () => (req, res, next) => next(),
}));

const serversRouter = require('../routes/servers');

function makeToken(userId, username = 'tester') {
  return jwt.sign({ id: userId, username, v: 0 }, 'test-jwt-secret', { expiresIn: '1h' });
}

function buildApp() {
  const app = express();
  app.set('io', null); // explicit null — no global leak, routes guard with if (io)
  app.use(express.json());
  app.use('/api/servers', serversRouter);
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return app;
}

// ── Ortak setup ───────────────────────────────────────────────
let app, db;
let ownerUser, otherUser;
let ownerToken, otherToken;

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
  let server;

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
// SUNUCUDAN AYRILMA
// ══════════════════════════════════════════════════════════════
describe('POST /api/servers/:sid/leave', () => {
  let server;

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
  let server;

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
  let server, channel;

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
    expect(res.body.some(c => c._id === channel._id)).toBe(true);
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

    expect(res.status).toBe(200);
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
  let server, channel;

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
  let server;

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
    expect(res.body.some(u => u._id === ownerUser._id)).toBe(true);
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
  let server, inviteCode;

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
    expect(res.text).toContain('<svg');
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
