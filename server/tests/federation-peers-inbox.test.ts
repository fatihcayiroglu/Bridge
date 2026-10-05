// server/tests/federation-peers-inbox.test.ts
// Kapsanan boşluklar:
//   peers.js     → /ping, /stats, /health, /join-remote, /fetch-remote
//   inbox-handlers.js → handleApReject, handleApLike, handleApAnnounce, handleApUpdate
//
// Test sayısı: 42
import type { Request, Response, NextFunction } from 'express';
import { fetchMock, installFetchMock } from './helpers/fetchDouble';

process.env.JWT_SECRET   = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV     = 'test';
process.env.INSTANCE_URL = 'https://bridge.example.com';
process.env.INSTANCE_NAME = 'Test Bridge';

import { createMockDb, makeUser, makeServer } from './helpers/mockDb';
const mockDb = createMockDb();

jest.mock('../db/index',  () => mockDb);
jest.mock('../db/loader', () => require('../db/index'));

jest.mock('../middleware/auth', () => ({
  authMiddleware: (
    req: { headers: { authorization?: string }; user?: unknown },
    res: { status: (c: number) => { json: (b: unknown) => unknown } },
    next: () => void,
  ) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const jwt = require('jsonwebtoken');
    try { req.user = jwt.verify(h.slice(7), 'test-jwt-secret-long-enough-32chars!!'); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
  },
}));

// federationAuth middleware — Sprint 108: V1 httpSignature yerine V2 middleware mock'la
let _mockFederationAuthFail = false;
jest.mock('../middleware/federationAuth', () => ({
  federationAuth: jest.fn().mockImplementation((req: Request, res: Response, next: NextFunction) => {
    if (_mockFederationAuthFail) {
      return res.status(401).json({ error: 'Federation authentication failed' });
    }
    req.federationPeerUrl = req.headers['x-bridge-instance-url'] || req.body?.url || req.body?.instanceUrl || '';
    req.federationMethod  = 'rsa';
    req.federationPeerId  = 'peer-1';
    next();
  }),
  federationAuthRsaRequired: jest.fn().mockImplementation((req: Request, res: Response, next: NextFunction) => {
    if (_mockFederationAuthFail) {
      return res.status(401).json({ error: 'Federation authentication failed' });
    }
    req.federationPeerUrl = req.headers['x-bridge-instance-url'] || req.body?.url || req.body?.instanceUrl || '';
    req.federationMethod  = 'rsa';
    req.federationPeerId  = 'peer-1';
    next();
  }),
}));
// V1 httpSignature — activitypub inbox için korunuyor (peers router'ında kullanılmıyor)
jest.mock('../lib/httpSignature', () => ({
  verifyHttpSignature:          jest.fn().mockResolvedValue({ ok: true }),
  verifyFederationRequest:      jest.fn().mockResolvedValue(true),
  _resetSignatureReplayCache:   jest.fn(),
}));

// delivery — inbox-handlers içinde kullanılıyor
jest.mock('../routes/federation/delivery', () => ({
  deliverApActivity:  jest.fn().mockResolvedValue(undefined),
  deliverToFollowers: jest.fn().mockResolvedValue(undefined),
  sendFollowRequest:  jest.fn().mockResolvedValue({}),
  sendUnfollow:       jest.fn().mockResolvedValue(undefined),
  sendLike:           jest.fn().mockResolvedValue({}),
  sendAnnounce:       jest.fn().mockResolvedValue({}),
  signRequest:        jest.fn(),
}));

installFetchMock();

jest.mock('../lib/fetch', () => ({
  fetchT: jest.fn((url: string, opts?: RequestInit) => fetchMock()(url, opts)),
}));

import request from 'supertest';
import express from 'express';
const jwt     = require('jsonwebtoken');

import { deliverApActivity } from '../routes/federation/delivery';
import inboxHandlers from '../routes/federation/inbox-handlers';
import type { ApActivity } from '../routes/federation/inbox-handlers';
const peersRouter   = require('../routes/federation/peers');
import { requireDoc } from './helpers/mockDb';

// ── App sadece peers router'ını mount eder ──────────────────────
const app = express();
app.use(express.json());
app.use('/api/federation', peersRouter);
app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(err.status || 500).json({ error: err.message }));

// ══════════════════════════════════════════════════════════════════════════
// AKTIVITE FABRIKASI — URUN SOZLESMESINE UYAR
// ══════════════════════════════════════════════════════════════════════════
// `ApActivity` `id` ISTER (ActivityPub'da her aktivitenin kalici bir kimligi
// vardir ve urun bunu tekrar-teslim ayiklamasinda kullanir). Testler `id`siz
// nesne edebileri yaziyordu; bu hem 11 strict hatasi uretiyor hem de urunun
// gercekte aldigi yuku eksik temsil ediyordu.
function makeActivity(activity: Omit<ApActivity, 'id'> & { id?: string }): ApActivity {
  return {
    id: activity.id ?? `https://remote.example/activities/${activity.type.toLowerCase()}-${Math.random().toString(36).slice(2)}`,
    ...activity,
  };
}

// ── Sabit ID'ler ────────────────────────────────────────────────
const ADMIN_ID  = 'peers-admin-id';
const USER_ID   = 'peers-user-id';
const SERVER_ID = 'peers-server-id';
const PEER_URL  = 'https://other.bridge.example.com';

function token(id: string) {
  return jwt.sign({ id, username: 'tester', displayName: 'Tester', v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });
}

// ── Fixtures ────────────────────────────────────────────────────
const ADMIN_USER = makeUser({ _id: ADMIN_ID, username: 'admin', isAdmin: 1 });
const PLAIN_USER = makeUser({ _id: USER_ID,  username: 'plainuser', isAdmin: 0 });

// Inbox-handlers testleri için AP kullanıcısı
const AP_USER = makeUser({
  _id:          'ap-target-user',
  username:     'apuser',
  apPublicKey:  '-----BEGIN PUBLIC KEY-----\nMIIBIjAN...\n-----END PUBLIC KEY-----',
  apPrivateKey: '-----BEGIN PRIVATE KEY-----\nMIIEvAIB...\n-----END PRIVATE KEY-----',
});

const REMOTE_ACTOR  = 'https://mastodon.social/users/remote';
const REMOTE_NOTE   = 'https://mastodon.social/users/remote/statuses/999';

beforeAll(async () => {
  await mockDb.users.insert(ADMIN_USER);
  await mockDb.users.insert(PLAIN_USER);
  await mockDb.users.insert(AP_USER);
  await mockDb.servers.insert(makeServer(ADMIN_ID, { _id: SERVER_ID, discoverable: 1 }));
  await mockDb.federationPeers.insert({
    _id: 'peer-1', url: PEER_URL, name: 'Other Bridge',
    verified: true, lastSeen: Date.now() - 60_000, createdAt: Date.now(),
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(deliverApActivity).mockResolvedValue(undefined);
  fetchMock().mockReset();
});

// ════════════════════════════════════════════════════════════════
// PEERS.JS — /stats
// ════════════════════════════════════════════════════════════════
describe('GET /api/federation/stats', () => {
  it('200 — herkese açık, auth gerektirmez', async () => {
    const res = await request(app).get('/api/federation/stats');
    expect(res.status).toBe(200);
  });

  it('peerCount, verifiedPeerCount, userCount, instance alanlarını döner', async () => {
    const res = await request(app).get('/api/federation/stats');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('peerCount');
    expect(res.body).toHaveProperty('verifiedPeerCount');
    expect(res.body).toHaveProperty('userCount');
    expect(res.body).toHaveProperty('instance');
    expect(res.body.federation).toBe(true);
  });

  it('verifiedPeerCount <= peerCount', async () => {
    const res = await request(app).get('/api/federation/stats');
    expect(res.body.verifiedPeerCount).toBeLessThanOrEqual(res.body.peerCount);
  });

  it('instanceName env değişkenini yansıtır', async () => {
    const res = await request(app).get('/api/federation/stats');
    expect(res.body.instanceName).toBe('Test Bridge');
  });
});

// ════════════════════════════════════════════════════════════════
// PEERS.JS — /ping
// ════════════════════════════════════════════════════════════════
describe('POST /api/federation/ping', () => {
  it('401 — federation imzası geçersizse reddeder', async () => {
    _mockFederationAuthFail = true;
    const res = await request(app).post('/api/federation/ping').send({ url: PEER_URL });
    _mockFederationAuthFail = false;
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/federation/i);
  });

  it('400 — url eksikse hata döner', async () => {
    const res = await request(app).post('/api/federation/ping').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/url/);
  });

  it('200 — geçerli ping peer lastSeen günceller ve ts döner', async () => {
    const before = Date.now();
    const res = await request(app).post('/api/federation/ping').send({ url: PEER_URL });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.ts).toBeGreaterThanOrEqual(before);
  });

  it('403 — imzalanan peer kimliği body içindeki başka peer hedefini değiştiremez', async () => {
    const res = await request(app)
      .post('/api/federation/ping')
      .set('x-bridge-instance-url', PEER_URL)
      .send({ url: 'https://victim-peer.example.com' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/signed peer identity/i);
  });
});

// ════════════════════════════════════════════════════════════════
// PEERS.JS — /health
// ════════════════════════════════════════════════════════════════
describe('GET /api/federation/health', () => {
  it('401 — kimlik doğrulaması gerekli', async () => {
    const res = await request(app).get('/api/federation/health');
    expect(res.status).toBe(401);
  });

  it('403 — admin olmayan kullanıcı erişemez', async () => {
    const res = await request(app)
      .get('/api/federation/health')
      .set('Authorization', `Bearer ${token(USER_ID)}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/[Aa]dmin/);
  });

  it('200 — admin peers listesini health bilgisiyle döner', async () => {
    const res = await request(app)
      .get('/api/federation/health')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('peers');
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('online');
    expect(Array.isArray(res.body.peers)).toBe(true);
  });

  it('peer kayıtları id, url, online, ageMins alanlarına sahip', async () => {
    const res = await request(app)
      .get('/api/federation/health')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`);
    const peer = res.body.peers.find((p: Record<string, unknown>) => p.url === PEER_URL);
    expect(peer).toBeDefined();
    expect(peer).toHaveProperty('id');
    expect(peer).toHaveProperty('online');
    expect(typeof peer.ageMins).toBe('number');
  });

  it('lastSeen 10 dk içindeyse online: true döner', async () => {
    // peer-1'in lastSeen'i 60s önce — stale threshold 10 dk → online olmalı
    const res = await request(app)
      .get('/api/federation/health')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`);
    const peer = res.body.peers.find((p: Record<string, unknown>) => p.url === PEER_URL);
    expect(peer.online).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
// PEERS.JS — /join-remote
// ════════════════════════════════════════════════════════════════
describe('POST /api/federation/join-remote', () => {
  it('401 — kimlik doğrulaması gerekli', async () => {
    const res = await request(app).post('/api/federation/join-remote').send({});
    expect(res.status).toBe(401);
  });

  it('400 — instanceUrl eksikse hata döner', async () => {
    const res = await request(app)
      .post('/api/federation/join-remote')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .send({ serverId: 'some-id' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/instanceUrl/);
  });

  it('400 — serverId eksikse hata döner', async () => {
    const res = await request(app)
      .post('/api/federation/join-remote')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .send({ instanceUrl: PEER_URL });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/serverId/);
  });

  it('404 — remote sunucuda server bulunamazsa 404 döner', async () => {
    fetchMock().mockResolvedValueOnce({
      ok:   true,
      json: async () => ({ servers: [] }),
    });
    const res = await request(app)
      .post('/api/federation/join-remote')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .send({ instanceUrl: PEER_URL, serverId: 'nonexistent-id' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('200 — remote sunucuda server bulunursa inviteUrl ile döner', async () => {
    const remoteServer = { id: 'remote-srv-1', name: 'Remote Server', inviteUrl: `${PEER_URL}/invite/abc` };
    fetchMock().mockResolvedValueOnce({
      ok:   true,
      json: async () => ({ servers: [remoteServer] }),
    });
    const res = await request(app)
      .post('/api/federation/join-remote')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .send({ instanceUrl: PEER_URL, serverId: 'remote-srv-1' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.server).toBeDefined();
    expect(res.body.inviteUrl).toContain('invite');
  });

  it('502 — remote instance erişilemezse hata döner', async () => {
    fetchMock().mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await request(app)
      .post('/api/federation/join-remote')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .send({ instanceUrl: 'https://down.example.com', serverId: 'any' });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Remote instance error/);
  });
});

// ════════════════════════════════════════════════════════════════
// PEERS.JS — /fetch-remote
// ════════════════════════════════════════════════════════════════
describe('GET /api/federation/fetch-remote', () => {
  it('401 — kimlik doğrulaması gerekli', async () => {
    const res = await request(app).get('/api/federation/fetch-remote').query({ url: PEER_URL });
    expect(res.status).toBe(401);
  });

  it('400 — url parametresi eksikse hata döner', async () => {
    const res = await request(app)
      .get('/api/federation/fetch-remote')
      .set('Authorization', `Bearer ${token(USER_ID)}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/url/);
  });

  it('400 — geçersiz URL formatı reddedilir', async () => {
    const res = await request(app)
      .get('/api/federation/fetch-remote')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .query({ url: 'not-a-url' });
    expect(res.status).toBe(400);
  });

  it('400 — http/https dışı protokol reddedilir', async () => {
    const res = await request(app)
      .get('/api/federation/fetch-remote')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .query({ url: 'ftp://evil.example.com/data' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/http/);
  });

  it('200 — geçerli URL ile remote JSON döner', async () => {
    const remoteData = { id: REMOTE_ACTOR, type: 'Person', preferredUsername: 'remote' };
    fetchMock().mockResolvedValueOnce({
      ok:   true,
      json: async () => remoteData,
    });
    const res = await request(app)
      .get('/api/federation/fetch-remote')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .query({ url: `${REMOTE_ACTOR}` });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('Person');
  });

  it('502 — remote 4xx/5xx dönerse hata döner', async () => {
    fetchMock().mockResolvedValueOnce({ ok: false, status: 404 });
    const res = await request(app)
      .get('/api/federation/fetch-remote')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .query({ url: 'https://mastodon.social/users/gone' });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/404/);
  });

  it('502 — ağ hatası olursa hata döner', async () => {
    fetchMock().mockRejectedValueOnce(new Error('Network timeout'));
    const res = await request(app)
      .get('/api/federation/fetch-remote')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .query({ url: 'https://unreachable.example.com/actor' });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Could not reach/);
  });
});

// ════════════════════════════════════════════════════════════════
// INBOX-HANDLERS — handleApReject
// ════════════════════════════════════════════════════════════════
describe('handleApReject', () => {
  it('outgoing follow kaydını kaldırır', async () => {
    await mockDb.apOutgoingFollows.insert({
      _id:            'out-f-reject',
      fromUserId:     AP_USER._id,
      targetActorUrl: REMOTE_ACTOR,
      accepted:       false,
      createdAt:      Date.now(),
    });

    const activity = makeActivity({
      type:   'Reject',
      actor:  REMOTE_ACTOR,
      object: { type: 'Follow', actor: `https://bridge.example.com/api/federation/users/${AP_USER.username}` },
    });

    await inboxHandlers.handleApReject(AP_USER, activity);

    const remaining = await mockDb.apOutgoingFollows.findOne({
      _id: 'out-f-reject',
    });
    expect(remaining).toBeNull();
  });

  it('kaydı olmayan reject sessizce geçer (hata fırlatmaz)', async () => {
    const activity = makeActivity({
      type:  'Reject',
      actor: 'https://other.social/users/nobody',
      object: { type: 'Follow' },
    });
    await expect(inboxHandlers.handleApReject(AP_USER, activity)).resolves.toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════
// INBOX-HANDLERS — handleApLike
// ════════════════════════════════════════════════════════════════
describe('handleApLike', () => {
  it('like kaydı oluşturur', async () => {
    const activity = makeActivity({
      type:   'Like',
      actor:  REMOTE_ACTOR,
      object: REMOTE_NOTE,
    });

    await inboxHandlers.handleApLike(AP_USER, activity);

    // `requireDoc` hem daraltir hem de satir yoksa HANGI sorgunun
    // karsiliksiz kaldigini soyler; `expect(...).not.toBeNull()` sonrasi
    // dogrudan alan okumak strict altinda derlenmiyordu.
    const like = await requireDoc(mockDb.apLikes, { actorUrl: REMOTE_ACTOR, objectUrl: REMOTE_NOTE });
    expect(like.targetUserId).toBe(AP_USER._id);
  });

  it('hedef kullanıcıya ap_like bildirimi oluşturur', async () => {
    const activity = makeActivity({
      type:   'Like',
      actor:  'https://mastodon.social/users/liker',
      object: 'https://bridge.example.com/notes/xyz',
    });

    await inboxHandlers.handleApLike(AP_USER, activity);

    const notif = await requireDoc(mockDb.notifications, {
      userId: AP_USER._id,
      type:   'ap_like',
    });
    expect(notif).not.toBeNull();
    expect(notif.read).toBe(false);
  });

  it('objectUrl yoksa sessizce döner', async () => {
    const activity = makeActivity({ type: 'Like', actor: REMOTE_ACTOR, object: null });
    await expect(inboxHandlers.handleApLike(AP_USER, activity)).resolves.toBeUndefined();
  });

  it('targetUser null olsa bile like kaydı oluşturur', async () => {
    const activity = makeActivity({
      type:   'Like',
      actor:  REMOTE_ACTOR,
      object: 'https://other.example.com/notes/public',
    });
    await expect(inboxHandlers.handleApLike(null, activity)).resolves.toBeUndefined();
    const like = await requireDoc(mockDb.apLikes, {
      actorUrl: REMOTE_ACTOR, objectUrl: 'https://other.example.com/notes/public',
    });
    expect(like).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════
// INBOX-HANDLERS — handleApAnnounce
// ════════════════════════════════════════════════════════════════
describe('handleApAnnounce', () => {
  it('announce kaydı oluşturur', async () => {
    const activity = makeActivity({
      type:   'Announce',
      actor:  REMOTE_ACTOR,
      object: REMOTE_NOTE,
    });

    await inboxHandlers.handleApAnnounce(AP_USER, activity);

    const ann = await requireDoc(mockDb.apAnnounces, { actorUrl: REMOTE_ACTOR, objectUrl: REMOTE_NOTE });
    expect(ann.targetUserId).toBe(AP_USER._id);
  });

  it('hedef kullanıcıya ap_announce bildirimi oluşturur', async () => {
    const noteUrl = 'https://bridge.example.com/notes/boosted';
    const activity = makeActivity({
      type:   'Announce',
      actor:  'https://mastodon.social/users/booster',
      object: noteUrl,
    });

    await inboxHandlers.handleApAnnounce(AP_USER, activity);

    const notif = await requireDoc(mockDb.notifications, {
      userId: AP_USER._id, type: 'ap_announce',
    });
    expect(notif).not.toBeNull();
  });

  it('objectUrl yoksa sessizce döner', async () => {
    const activity = makeActivity({ type: 'Announce', actor: REMOTE_ACTOR, object: '' });
    await expect(inboxHandlers.handleApAnnounce(AP_USER, activity)).resolves.toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════
// INBOX-HANDLERS — handleApUpdate
// ════════════════════════════════════════════════════════════════
describe('handleApUpdate', () => {
  it('timestamp içermeyen legacy Update arrival order ile içeriği günceller', async () => {
    const createdAt = Date.now();
    await mockDb.apMessages.insert({
      _id:      'ap-msg-upd-1',
      apId:     REMOTE_NOTE,
      actorUrl: REMOTE_ACTOR,
      content:  'Eski içerik',
      createdAt,
    });

    const activity = makeActivity({
      type:  'Update',
      actor: REMOTE_ACTOR,
      object: {
        id:      REMOTE_NOTE,
        type:    'Note',
        content: 'Yeni içerik',
      },
    });

    await inboxHandlers.handleApUpdate(AP_USER, activity);

    const updated = await mockDb.apMessages.findOne({ apId: REMOTE_NOTE, actorUrl: REMOTE_ACTOR });
    expect(updated?.content).toBe('Yeni içerik');
    expect(Number(updated?.updatedAt)).toBeGreaterThan(createdAt);

    await mockDb.apMessages.remove({ _id: 'ap-msg-upd-1' });
  });

  it('object.id yoksa sessizce döner', async () => {
    const activity = makeActivity({ type: 'Update', actor: REMOTE_ACTOR, object: { type: 'Note' } });
    await expect(inboxHandlers.handleApUpdate(AP_USER, activity)).resolves.toBeUndefined();
  });

  it('var olmayan apId ile update çağrısı hata fırlatmaz', async () => {
    const activity = makeActivity({
      type:  'Update',
      actor: REMOTE_ACTOR,
      object: { id: 'https://mastodon.social/notes/ghost', content: 'New' },
    });
    await expect(inboxHandlers.handleApUpdate(AP_USER, activity)).resolves.toBeUndefined();
  });
});
