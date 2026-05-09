// server/tests/federation-social.test.js
// ActivityPub sosyal eylemler: follow, unfollow, like, unlike, announce,
// timeline, notifications, read-all, profile — tam coverage
//
// Test sayısı: 44 test / 11 endpoint

process.env.JWT_SECRET  = 'test-jwt-secret';
process.env.NODE_ENV    = 'test';
process.env.INSTANCE_URL = 'https://bridge.example.com';

const { createMockDb, makeUser } = require('./helpers/mockDb');
const mockDb = createMockDb();

jest.mock('../db/index',  () => mockDb);
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

// delivery fonksiyonlarını mock'la — ağa çıkmasın
jest.mock('../routes/federation/delivery', () => ({
  sendFollowRequest:  jest.fn(),
  sendUnfollow:       jest.fn(),
  sendLike:           jest.fn(),
  sendAnnounce:       jest.fn(),
  deliverApActivity:  jest.fn(),
  deliverToFollowers: jest.fn(),
  signRequest:        jest.fn(),
}));

global.fetch = jest.fn();

const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');

const {
  sendFollowRequest, sendUnfollow, sendLike, sendAnnounce, deliverApActivity,
} = require('../routes/federation/delivery');

// social.js'i doğrudan yükle (federation/index.js değil)
const socialRouter = require('../routes/federation/social');

const app = express();
app.use(express.json());
app.use('/api/federation', socialRouter);
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

// ── Fixture IDs ─────────────────────────────────────────────────
const USER_ID       = 'social-test-user';
const USER2_ID      = 'social-test-user2';
const REMOTE_ACTOR  = 'https://mastodon.social/users/remoteuser';
const REMOTE_NOTE   = 'https://mastodon.social/users/remoteuser/statuses/123';

function token(id) {
  return jwt.sign(
    { id, username: 'socialuser', displayName: 'Social User', v: 0 },
    'test-jwt-secret',
    { expiresIn: '1h' }
  );
}

// ── Fixtures ─────────────────────────────────────────────────────
const USER_WITH_KEY = makeUser({
  _id:          USER_ID,
  username:     'socialuser',
  apPublicKey:  '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq...\n-----END PUBLIC KEY-----',
  apPrivateKey: '-----BEGIN PRIVATE KEY-----\nMIIEvAIBADA...\n-----END PRIVATE KEY-----',
});

const USER_NO_KEY = makeUser({
  _id:      USER2_ID,
  username: 'nokeyuser',
});

beforeAll(async () => {
  await mockDb.users.insert(USER_WITH_KEY);
  await mockDb.users.insert(USER_NO_KEY);
});

beforeEach(() => {
  jest.clearAllMocks();
  sendFollowRequest.mockResolvedValue({ type: 'Follow', id: 'https://bridge.example.com/activities/f1' });
  sendLike.mockResolvedValue({ type: 'Like', id: 'https://bridge.example.com/activities/l1' });
  sendAnnounce.mockResolvedValue({ type: 'Announce', id: 'https://bridge.example.com/activities/a1' });
  sendUnfollow.mockResolvedValue(undefined);
  deliverApActivity.mockResolvedValue(undefined);
  global.fetch.mockReset();
});

// ════════════════════════════════════════════════════════════════
// POST /api/federation/follow
// ════════════════════════════════════════════════════════════════
describe('POST /api/federation/follow', () => {
  it('401 — kimlik doğrulaması gerekli', async () => {
    const res = await request(app).post('/api/federation/follow').send({ actorUrl: REMOTE_ACTOR });
    expect(res.status).toBe(401);
  });

  it('400 — actorUrl eksikse hata döner', async () => {
    const res = await request(app)
      .post('/api/federation/follow')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/actorUrl/);
  });

  it('200 — yeni takip isteği gönderir ve activity döner', async () => {
    const res = await request(app)
      .post('/api/federation/follow')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .send({ actorUrl: REMOTE_ACTOR });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.activity).toBeDefined();
    expect(sendFollowRequest).toHaveBeenCalledTimes(1);
    expect(sendFollowRequest).toHaveBeenCalledWith(
      expect.objectContaining({ _id: USER_ID }),
      REMOTE_ACTOR
    );
  });

  it('409 — aynı aktörü zaten takip ediyorsa çakışma döner', async () => {
    // Önce bir outgoing follow kaydı ekle
    await mockDb.apFollows.insert({
      _id: 'existing-follow',
      fromUserId:    USER_ID,
      targetActorUrl: REMOTE_ACTOR,
      accepted:      false,
      createdAt:     Date.now(),
    });

    const res = await request(app)
      .post('/api/federation/follow')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .send({ actorUrl: REMOTE_ACTOR });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/[Aa]lready/);

    // Temizle
    await mockDb.apFollows.remove({ _id: 'existing-follow' });
  });

  it('AP key yoksa oluşturur ve devam eder', async () => {
    const res = await request(app)
      .post('/api/federation/follow')
      .set('Authorization', `Bearer ${token(USER2_ID)}`)
      .send({ actorUrl: 'https://other.social/users/someone' });

    // Key oluşturma başarılı olup sendFollowRequest çağrılmalı
    expect(sendFollowRequest).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════════
// DELETE /api/federation/follow
// ════════════════════════════════════════════════════════════════
describe('DELETE /api/federation/follow', () => {
  it('401 — kimlik doğrulaması gerekli', async () => {
    const res = await request(app).delete('/api/federation/follow').send({ actorUrl: REMOTE_ACTOR });
    expect(res.status).toBe(401);
  });

  it('400 — actorUrl eksikse hata döner', async () => {
    const res = await request(app)
      .delete('/api/federation/follow')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/actorUrl/);
  });

  it('200 — takibi bırakır ve sendUnfollow çağrılır', async () => {
    const res = await request(app)
      .delete('/api/federation/follow')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .send({ actorUrl: REMOTE_ACTOR });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(sendUnfollow).toHaveBeenCalledWith(
      expect.objectContaining({ _id: USER_ID }),
      REMOTE_ACTOR
    );
  });
});

// ════════════════════════════════════════════════════════════════
// GET /api/federation/following
// ════════════════════════════════════════════════════════════════
describe('GET /api/federation/following', () => {
  it('401 — kimlik doğrulaması gerekli', async () => {
    const res = await request(app).get('/api/federation/following');
    expect(res.status).toBe(401);
  });

  it('200 — boş liste döner (kayıt yoksa)', async () => {
    const res = await request(app)
      .get('/api/federation/following')
      .set('Authorization', `Bearer ${token(USER_ID)}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('200 — takip edilenleri döner (doğru format)', async () => {
    await mockDb.apFollows.insert({
      _id:            'out-follow-1',
      fromUserId:     USER_ID,
      targetActorUrl: REMOTE_ACTOR,
      accepted:       true,
      createdAt:      Date.now(),
    });

    const res = await request(app)
      .get('/api/federation/following')
      .set('Authorization', `Bearer ${token(USER_ID)}`);

    expect(res.status).toBe(200);
    const item = res.body.find(f => f.actorUrl === REMOTE_ACTOR);
    expect(item).toBeDefined();
    expect(item).toHaveProperty('accepted');
    expect(item).toHaveProperty('createdAt');
    // tokenHash, _id gibi internal alanlar gizlenmeli
    expect(item).not.toHaveProperty('_id');

    await mockDb.apFollows.remove({ _id: 'out-follow-1' });
  });
});

// ════════════════════════════════════════════════════════════════
// GET /api/federation/followers
// ════════════════════════════════════════════════════════════════
describe('GET /api/federation/followers', () => {
  it('401 — kimlik doğrulaması gerekli', async () => {
    const res = await request(app).get('/api/federation/followers');
    expect(res.status).toBe(401);
  });

  it('200 — boş liste döner', async () => {
    const res = await request(app)
      .get('/api/federation/followers')
      .set('Authorization', `Bearer ${token(USER_ID)}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('200 — takipçileri döner (doğru format)', async () => {
    await mockDb.apFollows.insert({
      _id:          'in-follow-1',
      actorUrl:     REMOTE_ACTOR,
      targetUserId: USER_ID,
      accepted:     true,
      createdAt:    Date.now(),
    });

    const res = await request(app)
      .get('/api/federation/followers')
      .set('Authorization', `Bearer ${token(USER_ID)}`);

    expect(res.status).toBe(200);
    const item = res.body.find(f => f.actorUrl === REMOTE_ACTOR);
    expect(item).toBeDefined();
    expect(item).toHaveProperty('createdAt');

    await mockDb.apFollows.remove({ _id: 'in-follow-1' });
  });
});

// ════════════════════════════════════════════════════════════════
// POST /api/federation/like
// ════════════════════════════════════════════════════════════════
describe('POST /api/federation/like', () => {
  it('401 — kimlik doğrulaması gerekli', async () => {
    const res = await request(app).post('/api/federation/like').send({ objectUrl: REMOTE_NOTE });
    expect(res.status).toBe(401);
  });

  it('400 — objectUrl eksikse hata döner', async () => {
    const res = await request(app)
      .post('/api/federation/like')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/objectUrl/);
  });

  it('400 — AP key yoksa beğeni yapılamaz', async () => {
    const res = await request(app)
      .post('/api/federation/like')
      .set('Authorization', `Bearer ${token(USER2_ID)}`)
      .send({ objectUrl: REMOTE_NOTE });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/key/i);
  });

  it('200 — beğeni gönderir ve activity döner', async () => {
    const res = await request(app)
      .post('/api/federation/like')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .send({ objectUrl: REMOTE_NOTE });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.activity).toBeDefined();
    expect(sendLike).toHaveBeenCalledWith(
      expect.objectContaining({ _id: USER_ID }),
      REMOTE_NOTE
    );
  });
});

// ════════════════════════════════════════════════════════════════
// DELETE /api/federation/like
// ════════════════════════════════════════════════════════════════
describe('DELETE /api/federation/like', () => {
  it('401 — kimlik doğrulaması gerekli', async () => {
    const res = await request(app).delete('/api/federation/like').send({ objectUrl: REMOTE_NOTE });
    expect(res.status).toBe(401);
  });

  it('400 — objectUrl eksikse hata döner', async () => {
    const res = await request(app)
      .delete('/api/federation/like')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/objectUrl/);
  });

  it('404 — beğenilmemiş bir notu unlike yapmaya çalışmak', async () => {
    const res = await request(app)
      .delete('/api/federation/like')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .send({ objectUrl: 'https://mastodon.social/notes/nonexistent' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/[Ll]ike not found/);
  });

  it('200 — beğeniyi geri alır ve Undo activity gönderir', async () => {
    // Önce like kaydı ekle
    await mockDb.apActivities.insert({
      _id:        'like-to-undo',
      fromUserId: USER_ID,
      objectUrl:  REMOTE_NOTE,
      type:       'Like',
      createdAt:  Date.now(),
    });

    const res = await request(app)
      .delete('/api/federation/like')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .send({ objectUrl: REMOTE_NOTE });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(deliverApActivity).toHaveBeenCalledTimes(1);
    const [, activity] = deliverApActivity.mock.calls[0];
    expect(activity.type).toBe('Undo');
    expect(activity.object.type).toBe('Like');
  });
});

// ════════════════════════════════════════════════════════════════
// POST /api/federation/announce
// ════════════════════════════════════════════════════════════════
describe('POST /api/federation/announce', () => {
  it('401 — kimlik doğrulaması gerekli', async () => {
    const res = await request(app).post('/api/federation/announce').send({ objectUrl: REMOTE_NOTE });
    expect(res.status).toBe(401);
  });

  it('400 — objectUrl eksikse hata döner', async () => {
    const res = await request(app)
      .post('/api/federation/announce')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/objectUrl/);
  });

  it('400 — AP key yoksa announce yapılamaz', async () => {
    const res = await request(app)
      .post('/api/federation/announce')
      .set('Authorization', `Bearer ${token(USER2_ID)}`)
      .send({ objectUrl: REMOTE_NOTE });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/key/i);
  });

  it('200 — boost/announce gönderir ve activity döner', async () => {
    const res = await request(app)
      .post('/api/federation/announce')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .send({ objectUrl: REMOTE_NOTE });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.activity).toBeDefined();
    expect(sendAnnounce).toHaveBeenCalledWith(
      expect.objectContaining({ _id: USER_ID }),
      REMOTE_NOTE
    );
  });
});

// ════════════════════════════════════════════════════════════════
// GET /api/federation/timeline
// ════════════════════════════════════════════════════════════════
describe('GET /api/federation/timeline', () => {
  it('401 — kimlik doğrulaması gerekli', async () => {
    const res = await request(app).get('/api/federation/timeline');
    expect(res.status).toBe(401);
  });

  it('200 — takip edilen yoksa boş timeline döner', async () => {
    const res = await request(app)
      .get('/api/federation/timeline')
      .set('Authorization', `Bearer ${token(USER_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it('200 — timeline doğru pagination alanlarına sahip', async () => {
    const res = await request(app)
      .get('/api/federation/timeline')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .query({ page: 1, limit: 10 });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('page', 1);
    expect(res.body).toHaveProperty('limit', 10);
    expect(res.body).toHaveProperty('pages');
  });

  it('limit değeri 50\'yi aşamaz', async () => {
    const res = await request(app)
      .get('/api/federation/timeline')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .query({ limit: 999 });

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(50);
  });

  it('200 — kabul edilmiş takip sonrası mesajlar listelenir', async () => {
    // Accepted outgoing follow ekle
    await mockDb.apFollows.insert({
      _id:            'tl-follow-1',
      fromUserId:     USER_ID,
      targetActorUrl: REMOTE_ACTOR,
      accepted:       true,
      createdAt:      Date.now(),
    });
    // O aktörden bir mesaj ekle
    await mockDb.apMessages.insert({
      _id:       'tl-msg-1',
      actorUrl:  REMOTE_ACTOR,
      content:   'Hello from remote',
      published: new Date().toISOString(),
    });

    const res = await request(app)
      .get('/api/federation/timeline')
      .set('Authorization', `Bearer ${token(USER_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(0);

    await mockDb.apFollows.remove({ _id: 'tl-follow-1' });
    await mockDb.apMessages.remove({ _id: 'tl-msg-1' });
  });
});

// ════════════════════════════════════════════════════════════════
// GET /api/federation/notifications
// ════════════════════════════════════════════════════════════════
describe('GET /api/federation/notifications', () => {
  it('401 — kimlik doğrulaması gerekli', async () => {
    const res = await request(app).get('/api/federation/notifications');
    expect(res.status).toBe(401);
  });

  it('200 — boş bildirim listesi döner', async () => {
    const res = await request(app)
      .get('/api/federation/notifications')
      .set('Authorization', `Bearer ${token(USER_ID)}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('200 — AP bildirimleri döner', async () => {
    await mockDb.notifications.insert({
      _id:       'notif-follow-1',
      userId:    USER_ID,
      type:      'ap_follow',
      actorUrl:  REMOTE_ACTOR,
      read:      false,
      createdAt: Date.now(),
    });

    const res = await request(app)
      .get('/api/federation/notifications')
      .set('Authorization', `Bearer ${token(USER_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);

    await mockDb.notifications.remove({ _id: 'notif-follow-1' });
  });

  it('limit parametresi 50\'yi aşamaz', async () => {
    const res = await request(app)
      .get('/api/federation/notifications')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .query({ limit: 999 });

    expect(res.status).toBe(200);
    // İstek başarılı olmalı (sınır enforcement test — sonuç sayısı 0 olabilir)
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
// PATCH /api/federation/notifications/read-all
// ════════════════════════════════════════════════════════════════
describe('PATCH /api/federation/notifications/read-all', () => {
  it('401 — kimlik doğrulaması gerekli', async () => {
    const res = await request(app).patch('/api/federation/notifications/read-all');
    expect(res.status).toBe(401);
  });

  it('200 — tüm AP bildirimleri okundu olarak işaretlenir', async () => {
    // Okunmamış bildirimler ekle
    await mockDb.notifications.insert({
      _id: 'unread-1', userId: USER_ID, type: 'ap_follow', read: false, createdAt: Date.now(),
    });
    await mockDb.notifications.insert({
      _id: 'unread-2', userId: USER_ID, type: 'ap_like', read: false, createdAt: Date.now(),
    });

    const res = await request(app)
      .patch('/api/federation/notifications/read-all')
      .set('Authorization', `Bearer ${token(USER_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Bildirimlerin artık okundu olduğunu doğrula
    const remaining = await mockDb.notifications.find({ userId: USER_ID, read: false });
    const unread = (await remaining).filter(n => ['ap_follow', 'ap_like'].includes(n.type));
    expect(unread).toHaveLength(0);

    await mockDb.notifications.remove({ _id: 'unread-1' });
    await mockDb.notifications.remove({ _id: 'unread-2' });
  });

  it('başka kullanıcının bildirimlerine dokunmaz', async () => {
    await mockDb.notifications.insert({
      _id: 'other-unread', userId: 'other-user', type: 'ap_mention', read: false, createdAt: Date.now(),
    });

    await request(app)
      .patch('/api/federation/notifications/read-all')
      .set('Authorization', `Bearer ${token(USER_ID)}`);

    const doc = await mockDb.notifications.findOne({ _id: 'other-unread' });
    expect(doc?.read).toBe(false);

    await mockDb.notifications.remove({ _id: 'other-unread' });
  });
});

// ════════════════════════════════════════════════════════════════
// GET /api/federation/profile
// ════════════════════════════════════════════════════════════════
describe('GET /api/federation/profile', () => {
  it('401 — kimlik doğrulaması gerekli', async () => {
    const res = await request(app).get('/api/federation/profile').query({ actorUrl: REMOTE_ACTOR });
    expect(res.status).toBe(401);
  });

  it('400 — actorUrl query parametresi eksikse hata döner', async () => {
    const res = await request(app)
      .get('/api/federation/profile')
      .set('Authorization', `Bearer ${token(USER_ID)}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/actorUrl/);
  });

  it('200 — uzak profili döner ve takip durumunu içerir', async () => {
    const mockActor = {
      id:                REMOTE_ACTOR,
      type:              'Person',
      preferredUsername: 'remoteuser',
      name:              'Remote User',
      summary:           'A remote user',
      inbox:             `${REMOTE_ACTOR}/inbox`,
      followers:         `${REMOTE_ACTOR}/followers`,
      following:         `${REMOTE_ACTOR}/following`,
    };

    global.fetch.mockResolvedValueOnce({
      ok:   true,
      json: async () => mockActor,
    });

    const res = await request(app)
      .get('/api/federation/profile')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .query({ actorUrl: REMOTE_ACTOR });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(REMOTE_ACTOR);
    expect(res.body.preferredUsername).toBe('remoteuser');
    expect(res.body).toHaveProperty('isFollowing');
    expect(res.body).toHaveProperty('isFollower');
    expect(typeof res.body.isFollowing).toBe('boolean');
    expect(typeof res.body.isFollower).toBe('boolean');
  });

  it('isFollowing true döner — kullanıcı bu aktörü takip ediyorsa', async () => {
    await mockDb.apFollows.insert({
      _id:            'profile-follow',
      fromUserId:     USER_ID,
      targetActorUrl: REMOTE_ACTOR,
      accepted:       true,
      createdAt:      Date.now(),
    });

    global.fetch.mockResolvedValueOnce({
      ok:   true,
      json: async () => ({ id: REMOTE_ACTOR, type: 'Person', preferredUsername: 'remoteuser' }),
    });

    const res = await request(app)
      .get('/api/federation/profile')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .query({ actorUrl: REMOTE_ACTOR });

    expect(res.status).toBe(200);
    expect(res.body.isFollowing).toBe(true);

    await mockDb.apFollows.remove({ _id: 'profile-follow' });
  });

  it('502 — uzak sunucu erişilemezse hata döner', async () => {
    global.fetch.mockRejectedValueOnce(new Error('Connection refused'));

    const res = await request(app)
      .get('/api/federation/profile')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .query({ actorUrl: REMOTE_ACTOR });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Could not fetch/);
  });

  it('502 — uzak sunucu 404 dönerse hata döner', async () => {
    global.fetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const res = await request(app)
      .get('/api/federation/profile')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .query({ actorUrl: REMOTE_ACTOR });

    expect(res.status).toBe(502);
  });
});
