// server/tests/federation-outbox.test.ts
// ActivityPub Outbox endpoint + deliverToFollowers delivery testi

process.env.JWT_SECRET = 'test-jwt-secret';
process.env.NODE_ENV   = 'test';

import { createMockDb, makeUser } from './helpers/mockDb';
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
jest.mock('../lib/fetch', () => ({
  fetchT: jest.fn((...args) => global.fetch(...args)),
}));

global.fetch = jest.fn();

const request    = require('supertest');
const express    = require('express');
const jwt        = require('jsonwebtoken');
const router     = require('../routes/federation');

const app = express();
app.use(express.json());
app.use('/api/federation', router);
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

// ── Fixture IDs ────────────────────────────────────────────────
const ACTOR_USER_ID  = 'outbox-actor-uid';
const ACTOR_USERNAME = 'outboxactor';
const FOLLOWER_INBOX = 'https://remote.social/users/follower/inbox';

beforeAll(async () => {
  await mockDb.users.insert(makeUser({
    _id:      ACTOR_USER_ID,
    username: ACTOR_USERNAME,
  }));
});

afterEach(() => {
  global.fetch.mockReset();
  // ap_activities ve ap_follows temizle (her testin başından itibaren temiz)
  mockDb.apActivities?.remove?.({});
  mockDb.apFollows?.remove?.({});
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Root OrderedCollection endpoint
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/federation/users/:username/outbox — root collection', () => {
  it('returns 404 for unknown user', async () => {
    const res = await request(app).get('/api/federation/users/nobody_xyz/outbox');
    expect(res.status).toBe(404);
  });

  it('returns OrderedCollection with correct @context', async () => {
    const res = await request(app).get(`/api/federation/users/${ACTOR_USERNAME}/outbox`);
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('OrderedCollection');
    expect(res.body['@context']).toBe('https://www.w3.org/ns/activitystreams');
  });

  it('returns totalItems=0 when user has no activities', async () => {
    const res = await request(app).get(`/api/federation/users/${ACTOR_USERNAME}/outbox`);
    expect(res.status).toBe(200);
    expect(res.body.totalItems).toBe(0);
  });

  it('includes first and last page links', async () => {
    const res = await request(app).get(`/api/federation/users/${ACTOR_USERNAME}/outbox`);
    expect(res.body.first).toContain('page=true');
    expect(res.body.last).toContain('page=true');
  });

  it('reflects totalItems after activities are added', async () => {
    // 2 adet aktivite ekle
    await mockDb.apActivities.insert({
      actorUserId: ACTOR_USER_ID, type: 'Create',
      activity: { type: 'Create', id: 'https://x/1' }, publishedAt: Date.now() - 2000,
    });
    await mockDb.apActivities.insert({
      actorUserId: ACTOR_USER_ID, type: 'Create',
      activity: { type: 'Create', id: 'https://x/2' }, publishedAt: Date.now() - 1000,
    });

    const res = await request(app).get(`/api/federation/users/${ACTOR_USERNAME}/outbox`);
    expect(res.body.totalItems).toBe(2);
  });

  it('sets Content-Type: application/activity+json', async () => {
    const res = await request(app).get(`/api/federation/users/${ACTOR_USERNAME}/outbox`);
    expect(res.headers['content-type']).toMatch(/activity\+json/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Paginated OrderedCollectionPage endpoint
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/federation/users/:username/outbox?page=true', () => {
  it('returns OrderedCollectionPage type', async () => {
    const res = await request(app)
      .get(`/api/federation/users/${ACTOR_USERNAME}/outbox?page=true`);
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('OrderedCollectionPage');
    expect(res.body.partOf).toContain('/outbox');
  });

  it('orderedItems is an array', async () => {
    const res = await request(app)
      .get(`/api/federation/users/${ACTOR_USERNAME}/outbox?page=true`);
    expect(Array.isArray(res.body.orderedItems)).toBe(true);
  });

  it('returns stored activities in orderedItems', async () => {
    const activity = { type: 'Create', id: 'https://example.com/act/1', object: { type: 'Note', content: 'Hello' } };
    await mockDb.apActivities.insert({
      actorUserId: ACTOR_USER_ID, type: 'Create',
      activity, publishedAt: Date.now(),
    });

    const res = await request(app)
      .get(`/api/federation/users/${ACTOR_USERNAME}/outbox?page=true`);

    expect(res.body.orderedItems.length).toBeGreaterThanOrEqual(1);
    const ids = res.body.orderedItems.map(a => a.id);
    expect(ids).toContain('https://example.com/act/1');
  });

  it('does not include activities of other users', async () => {
    const otherUser = await mockDb.users.insert(makeUser({ username: 'otheractor' }));
    await mockDb.apActivities.insert({
      actorUserId: otherUser._id, type: 'Create',
      activity: { type: 'Create', id: 'https://other.com/act/99' }, publishedAt: Date.now(),
    });

    const res = await request(app)
      .get(`/api/federation/users/${ACTOR_USERNAME}/outbox?page=true`);

    const ids = res.body.orderedItems.map(a => a.id);
    expect(ids).not.toContain('https://other.com/act/99');
  });

  it('includes next link when results fill the page', async () => {
    // 20 aktivite ekle (PAGE_SIZE eşiği)
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      await mockDb.apActivities.insert({
        actorUserId: ACTOR_USER_ID, type: 'Create',
        activity: { type: 'Create', id: `https://x/page/${i}` },
        publishedAt: now - i * 1000,
      });
    }

    const res = await request(app)
      .get(`/api/federation/users/${ACTOR_USERNAME}/outbox?page=true`);

    expect(res.body.next).toBeDefined();
    expect(res.body.next).toContain('min_id=');
  });

  it('does not include next link when results are fewer than PAGE_SIZE', async () => {
    await mockDb.apActivities.insert({
      actorUserId: ACTOR_USER_ID, type: 'Create',
      activity: { type: 'Create', id: 'https://x/only-one' }, publishedAt: Date.now(),
    });

    const res = await request(app)
      .get(`/api/federation/users/${ACTOR_USERNAME}/outbox?page=true`);

    expect(res.body.next).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. deliverToFollowers — outbox delivery fonksiyonu
// ─────────────────────────────────────────────────────────────────────────────

describe('deliverToFollowers()', () => {
  const { deliverToFollowers } = require('../routes/federation/helpers');

  const fromUser = {
    _id:          ACTOR_USER_ID,
    username:     ACTOR_USERNAME,
    apPrivateKey: null,
  };

  it('exports deliverToFollowers function', () => {
    expect(typeof deliverToFollowers).toBe('function');
  });

  it('resolves without error when there are no followers', async () => {
    await expect(deliverToFollowers(fromUser, '<p>Merhaba dünya</p>')).resolves.not.toThrow();
  });

  it('saves Create(Note) activity to ap_activities', async () => {
    await deliverToFollowers(fromUser, '<p>Federe mesaj</p>');

    // Küçük bir bekleme: deliverToFollowers async işlemi tamamlasın
    await new Promise(r => setTimeout(r, 50));

    const saved = await mockDb.apActivities.findOne({ actorUserId: ACTOR_USER_ID, type: 'Create' });
    expect(saved).toBeTruthy();
    expect(saved.activity.type).toBe('Create');
    expect(saved.activity.object.type).toBe('Note');
    expect(saved.activity.object.content).toBe('<p>Federe mesaj</p>');
  });

  it('saves Note with correct to/cc (public + followers)', async () => {
    await deliverToFollowers(fromUser, '<p>Herkese açık mesaj</p>');
    await new Promise(r => setTimeout(r, 50));

    const saved = await mockDb.apActivities.findOne({ actorUserId: ACTOR_USER_ID, type: 'Create' });
    expect(saved.activity.object.to).toContain('https://www.w3.org/ns/activitystreams#Public');
    expect(saved.activity.object.cc.some(u => u.includes('/followers'))).toBe(true);
  });

  it('delivers to each follower inbox', async () => {
    // İki follower ekle
    await mockDb.apFollows.insert({
      actorUrl: FOLLOWER_INBOX.replace('/inbox', ''), // actor URL
      targetUserId: ACTOR_USER_ID,
      activityId: 'https://remote.social/follows/1',
      createdAt: Date.now(),
    });
    await mockDb.apFollows.insert({
      actorUrl: 'https://another.social/users/friend',
      targetUserId: ACTOR_USER_ID,
      activityId: 'https://another.social/follows/2',
      createdAt: Date.now(),
    });

    // fetch mock: actor profile → inbox URL, sonra POST inbox
    global.fetch
      .mockResolvedValue({ ok: true, json: async () => ({ inbox: FOLLOWER_INBOX }) });

    await deliverToFollowers(fromUser, '<p>Follower delivery testi</p>');
    await new Promise(r => setTimeout(r, 100));

    // Her follower için en az bir fetch çağrısı yapılmış olmalı
    expect(global.fetch).toHaveBeenCalled();
  });

  it('does not throw when fetch fails for one follower', async () => {
    await mockDb.apFollows.insert({
      actorUrl: 'https://dead.social/users/ghost',
      targetUserId: ACTOR_USER_ID,
      activityId: 'https://dead.social/follows/1',
      createdAt: Date.now(),
    });

    global.fetch.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(deliverToFollowers(fromUser, '<p>Hata testi</p>')).resolves.not.toThrow();
  });

  it('accepts an explicit noteId to use as Note AP id', async () => {
    const customNoteId = 'https://bridge.local/notes/custom-123';
    await deliverToFollowers(fromUser, '<p>Custom id testi</p>', customNoteId);
    await new Promise(r => setTimeout(r, 50));

    const saved = await mockDb.apActivities.findOne({ noteId: customNoteId });
    expect(saved).toBeTruthy();
    expect(saved.activity.object.id).toBe(customNoteId);
  });

  it('outbox totalItems increases after delivery', async () => {
    const before = await request(app).get(`/api/federation/users/${ACTOR_USERNAME}/outbox`);
    const prevCount = before.body.totalItems;

    await deliverToFollowers(fromUser, '<p>Sayaç testi</p>');
    await new Promise(r => setTimeout(r, 50));

    const after = await request(app).get(`/api/federation/users/${ACTOR_USERNAME}/outbox`);
    expect(after.body.totalItems).toBeGreaterThan(prevCount);
  });
});
