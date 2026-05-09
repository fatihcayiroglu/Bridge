// server/tests/health.test.js
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';

const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { createMockDb, makeUser, makeServer, makeChannel, makeMessage } = require('./helpers/mockDb');

let db;
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/index', () => {
  const { createMockDb } = require('./helpers/mockDb');
  db = createMockDb();
  return db;
});
jest.mock('../socket', () => ({
  getSocketStats: () => ({ connectedSockets: 5, activeTyping: 1, voiceRooms: 2, voicePeers: 4 }),
}));

const healthRouter = require('../routes/health');

function makeToken(userId) {
  return jwt.sign({ id: userId, username: 'tester', v: 0 }, 'test-jwt-secret', { expiresIn: '1h' });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/health', healthRouter);
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return app;
}

let app, owner, member, outsider, server, channel;
let ownerToken, memberToken, outsiderToken;

beforeEach(async () => {
  db = createMockDb();
  Object.assign(require('../db/loader'), db);
  Object.assign(require('../db/index'), db);

  owner    = makeUser({ username: 'owner' });
  member   = makeUser({ username: 'member' });
  outsider = makeUser({ username: 'outsider' });
  server   = makeServer(owner._id, { name: 'Test Sunucu' });
  channel  = makeChannel(server._id, { name: 'general' });

  await db.users.insert(owner);
  await db.users.insert(member);
  await db.users.insert(outsider);
  await db.servers.insert(server);
  await db.channels.insert(channel);
  await db.members.insert({ userId: owner._id,  serverId: server._id, joinedAt: Date.now() });
  await db.members.insert({ userId: member._id, serverId: server._id, joinedAt: Date.now() });

  ownerToken    = makeToken(owner._id);
  memberToken   = makeToken(member._id);
  outsiderToken = makeToken(outsider._id);

  app = buildApp();
});

// ══════════════════════════════════════════════════════════════
// TEMEL SAĞLIK
// ══════════════════════════════════════════════════════════════
describe('GET /api/health', () => {
  it('ok döner', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.version).toBeDefined();
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
    expect(res.body.ts).toBeDefined();
    expect(['sqlite', 'postgresql']).toContain(res.body.db);
  });

  it('DB hatası 503 döner', async () => {
    const dbMod = require('../db/index');
    const origCount = dbMod.users.count;
    dbMod.users.count = async () => { throw new Error('DB down'); };

    const res = await request(app).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');

    dbMod.users.count = origCount;
  });
});

// ══════════════════════════════════════════════════════════════
// SİSTEM İSTATİSTİKLERİ
// ══════════════════════════════════════════════════════════════
describe('GET /api/health/stats', () => {
  it('test ortamında stats döner', async () => {
    const res = await request(app).get('/api/health/stats');
    expect(res.status).toBe(200);
    expect(res.body.memory).toBeDefined();
    expect(res.body.memory.heapUsed).toMatch(/MB/);
    expect(res.body.counts).toBeDefined();
    expect(typeof res.body.counts.users).toBe('number');
  });

  it('socket stats dahil edilir', async () => {
    const res = await request(app).get('/api/health/stats');
    expect(res.status).toBe(200);
    expect(res.body.socket.connectedSockets).toBe(5);
    expect(res.body.socket.voiceRooms).toBe(2);
  });
});

// ══════════════════════════════════════════════════════════════
// SUNUCU İSTATİSTİK DASHBOARD
// ══════════════════════════════════════════════════════════════
describe('GET /api/health/server/:sid — sunucu dashboard', () => {
  beforeEach(async () => {
    // 5 mesaj ekle — son 7 gün içinde
    for (let i = 0; i < 5; i++) {
      await db.messages.insert(
        makeMessage(channel._id, server._id, owner._id, {
          content: `Mesaj ${i}`,
          createdAt: Date.now() - i * 3600000,
        })
      );
    }
  });

  it('üye temel istatistikleri alır', async () => {
    const res = await request(app)
      .get(`/api/health/server/${server._id}`)
      .set('Authorization', `Bearer ${memberToken}`);

    expect(res.status).toBe(200);
    expect(res.body.serverId).toBe(server._id);
    expect(res.body.serverName).toBe('Test Sunucu');
    expect(res.body.members).toBe(2);
    expect(res.body.channels).toBeGreaterThanOrEqual(1);
    expect(res.body.last7Days).toBeDefined();
    expect(res.body.last7Days.messages).toBe(5);
    expect(res.body.topChannels).toBeDefined();
  });

  it('sahip ek verileri görür (invites + topMembers)', async () => {
    // Bir davet ekle
    await db.invites.insert({
      _id: 'inv1', code: 'testcode', serverId: server._id,
      createdBy: owner._id, expiresAt: Date.now() + 99999,
      maxUses: 0, uses: 3,
    });

    const res = await request(app)
      .get(`/api/health/server/${server._id}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.invites).toBeDefined();
    expect(res.body.invites.total).toBe(1);
    expect(res.body.invites.active).toBe(1);
    expect(res.body.invites.totalUses).toBe(3);
    expect(res.body.topMembers).toBeDefined();
    expect(res.body.topMembers.length).toBeGreaterThan(0);
  });

  it('normal üye topMembers göremez', async () => {
    const res = await request(app)
      .get(`/api/health/server/${server._id}`)
      .set('Authorization', `Bearer ${memberToken}`);

    expect(res.status).toBe(200);
    expect(res.body.topMembers).toBeUndefined();
    expect(res.body.invites).toBeUndefined();
  });

  it('üye olmayan 403 alır', async () => {
    const res = await request(app)
      .get(`/api/health/server/${server._id}`)
      .set('Authorization', `Bearer ${outsiderToken}`);

    expect(res.status).toBe(403);
  });

  it('token olmadan 401 döner', async () => {
    const res = await request(app)
      .get(`/api/health/server/${server._id}`);

    expect(res.status).toBe(401);
  });

  it('mevcut olmayan sunucu 404 döner', async () => {
    const res = await request(app)
      .get('/api/health/server/nonexistent')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(404);
  });

  it('günlük dağılım 7 gün içerir', async () => {
    const res = await request(app)
      .get(`/api/health/server/${server._id}`)
      .set('Authorization', `Bearer ${memberToken}`);

    expect(res.status).toBe(200);
    expect(res.body.last7Days.daily).toBeDefined();
    expect(Object.keys(res.body.last7Days.daily).length).toBe(7);
  });
});

// ══════════════════════════════════════════════════════════════
// ICE CONFIG ENDPOINT
// ══════════════════════════════════════════════════════════════
describe('GET /api/health/ice-config', () => {
  it('auth olmadan 401 döner', async () => {
    const res = await request(app).get('/api/health/ice-config');
    expect(res.status).toBe(401);
  });

  it('auth ile STUN sunucularını döner', async () => {
    const res = await request(app)
      .get('/api/health/ice-config')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.iceServers)).toBe(true);
    expect(res.body.iceServers.length).toBeGreaterThanOrEqual(2);
    // Google STUN sunucuları varsayılan olarak var
    const stunUrls = res.body.iceServers.map(s => s.urls);
    expect(stunUrls.some(u => u.includes('stun.l.google.com'))).toBe(true);
  });

  it('TURN env değişkenleri yokken sadece STUN döner', async () => {
    delete process.env.TURN_URL;
    delete process.env.TURN_USERNAME;
    delete process.env.TURN_CREDENTIAL;

    const res = await request(app)
      .get('/api/health/ice-config')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const turnEntries = res.body.iceServers.filter(s => s.urls?.startsWith('turn:'));
    expect(turnEntries.length).toBe(0);
  });

  it('TURN env ayarlıyken TURN sunucusu döner', async () => {
    process.env.TURN_URL        = 'turn:turn.example.com:3478';
    process.env.TURN_USERNAME   = 'testuser';
    process.env.TURN_CREDENTIAL = 'testpass';

    const res = await request(app)
      .get('/api/health/ice-config')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const turnEntries = res.body.iceServers.filter(s => s.urls?.startsWith('turn:'));
    expect(turnEntries.length).toBeGreaterThanOrEqual(1);
    expect(turnEntries[0].username).toBe('testuser');
    expect(turnEntries[0].credential).toBe('testpass');

    delete process.env.TURN_URL;
    delete process.env.TURN_USERNAME;
    delete process.env.TURN_CREDENTIAL;
  });

  it('TURN_URL_TLS ayarlıyken TLS entry de döner', async () => {
    process.env.TURN_URL        = 'turn:turn.example.com:3478';
    process.env.TURN_USERNAME   = 'testuser';
    process.env.TURN_CREDENTIAL = 'testpass';
    process.env.TURN_URL_TLS    = 'turns:turn.example.com:5349';

    const res = await request(app)
      .get('/api/health/ice-config')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const tlsEntries = res.body.iceServers.filter(s => s.urls?.startsWith('turns:'));
    expect(tlsEntries.length).toBeGreaterThanOrEqual(1);

    delete process.env.TURN_URL;
    delete process.env.TURN_USERNAME;
    delete process.env.TURN_CREDENTIAL;
    delete process.env.TURN_URL_TLS;
  });
});
