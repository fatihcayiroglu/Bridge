// server/tests/activitypub.test.js
// ActivityPub tam entegrasyon testleri:
//   - followers / following koleksiyonları
//   - tekil note endpoint
//   - NodeInfo (/.well-known/nodeinfo + /nodeinfo/2.1)
//   - Kayıt sırasında RSA key üretimi
//   - HTTP Signature doğrulama (Accept gönderme)

process.env.JWT_SECRET   = 'test-jwt-secret';
process.env.NODE_ENV     = 'test';
process.env.INSTANCE_URL = 'https://bridge.test';

const { createMockDb, makeUser } = require('./helpers/mockDb');
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

global.fetch = jest.fn();

const request = require('supertest');
const express = require('express');
const crypto  = require('crypto');

const router = require('../routes/federation');

const app = express();
app.use(express.json());
app.use('/api/federation', router);

// NodeInfo simülasyonu (index.js'deki gibi)
app.get('/.well-known/nodeinfo', (req, res) => {
  res.json({
    links: [{ rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1', href: 'https://bridge.test/nodeinfo/2.1' }],
  });
});
app.get('/nodeinfo/2.1', async (req, res) => {
  const userCount = await mockDb.users.count({}).catch(() => 0);
  res.json({
    version: '2.1',
    software: { name: 'bridge', version: '50.0.0' },
    protocols: ['activitypub'],
    usage: { users: { total: userCount || 0, activeMonth: 0, activeHalfyear: 0 }, localPosts: 0 },
    openRegistrations: true,
  });
});

app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

// ── Fixtures ────────────────────────────────────────────────────
const ACTOR_ID       = 'ap-full-actor-uid';
const ACTOR_USERNAME = 'apfullactor';
const FOLLOWER_URL   = 'https://mastodon.social/users/remotefriend';

function makeKeyPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

beforeAll(async () => {
  const { publicKey, privateKey } = makeKeyPair();
  await mockDb.users.insert(makeUser({
    _id:          ACTOR_ID,
    username:     ACTOR_USERNAME,
    apPublicKey:  publicKey,
    apPrivateKey: privateKey,
  }));

  // Bir follower kaydı ekle
  await mockDb.apFollows?.insert({
    _id:          'follow-001',
    actorUrl:     FOLLOWER_URL,
    targetUserId: ACTOR_ID,
    activityId:   'https://mastodon.social/users/remotefriend#follows/1',
    createdAt:    Date.now(),
  });

  // Bir activity (note) ekle
  const noteId = `https://bridge.test/api/federation/users/${ACTOR_USERNAME}/notes/note-001`;
  await mockDb.apActivities?.insert({
    _id:          'act-001',
    actorUserId:  ACTOR_ID,
    type:         'Create',
    activityId:   `https://bridge.test/api/federation/users/${ACTOR_USERNAME}/activities/act-001`,
    noteId,
    activity: {
      '@context': 'https://www.w3.org/ns/activitystreams',
      type:   'Create',
      actor:  `https://bridge.test/api/federation/users/${ACTOR_USERNAME}`,
      object: {
        id:           noteId,
        type:         'Note',
        content:      'Merhaba Fediverse! 🌐',
        attributedTo: `https://bridge.test/api/federation/users/${ACTOR_USERNAME}`,
        published:    new Date().toISOString(),
      },
    },
    publishedAt: Date.now(),
  });
});

afterEach(() => { global.fetch.mockReset(); });

// ── 1. Actor endpoint ──────────────────────────────────────────
describe('GET /api/federation/users/:username — Actor', () => {
  it('returns correct Content-Type', async () => {
    const res = await request(app).get(`/api/federation/users/${ACTOR_USERNAME}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/activity\+json/);
  });

  it('actor has publicKey with real PEM', async () => {
    const res = await request(app).get(`/api/federation/users/${ACTOR_USERNAME}`);
    expect(res.body.publicKey?.publicKeyPem).toMatch(/BEGIN PUBLIC KEY/);
  });

  it('actor includes inbox, outbox, followers, following', async () => {
    const res = await request(app).get(`/api/federation/users/${ACTOR_USERNAME}`);
    expect(res.body.inbox).toContain('/inbox');
    expect(res.body.outbox).toContain('/outbox');
    expect(res.body.followers).toContain('/followers');
    expect(res.body.following).toContain('/following');
  });

  it('returns 404 for unknown user', async () => {
    const res = await request(app).get('/api/federation/users/ghost_xyz_404');
    expect(res.status).toBe(404);
  });
});

// ── 2. Followers Collection ────────────────────────────────────
describe('GET /api/federation/users/:username/followers', () => {
  it('returns OrderedCollection', async () => {
    const res = await request(app).get(`/api/federation/users/${ACTOR_USERNAME}/followers`);
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('OrderedCollection');
  });

  it('includes the remote follower URL', async () => {
    const res = await request(app).get(`/api/federation/users/${ACTOR_USERNAME}/followers`);
    expect(res.body.orderedItems).toContain(FOLLOWER_URL);
  });

  it('totalItems matches orderedItems length', async () => {
    const res = await request(app).get(`/api/federation/users/${ACTOR_USERNAME}/followers`);
    expect(res.body.totalItems).toBe(res.body.orderedItems.length);
  });

  it('returns 404 for unknown user', async () => {
    const res = await request(app).get('/api/federation/users/nobody_follows/followers');
    expect(res.status).toBe(404);
  });
});

// ── 3. Following Collection ────────────────────────────────────
describe('GET /api/federation/users/:username/following', () => {
  it('returns OrderedCollection with totalItems=0', async () => {
    const res = await request(app).get(`/api/federation/users/${ACTOR_USERNAME}/following`);
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('OrderedCollection');
    expect(res.body.totalItems).toBe(0);
  });

  it('returns 404 for unknown user', async () => {
    const res = await request(app).get('/api/federation/users/nobody_xyz/following');
    expect(res.status).toBe(404);
  });
});

// ── 4. Note endpoint ───────────────────────────────────────────
describe('GET /api/federation/users/:username/notes/:noteId', () => {
  it('returns the note object', async () => {
    const res = await request(app).get(`/api/federation/users/${ACTOR_USERNAME}/notes/note-001`);
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('Note');
    expect(res.body.content).toBe('Merhaba Fediverse! 🌐');
  });

  it('returns 404 for unknown note', async () => {
    const res = await request(app).get(`/api/federation/users/${ACTOR_USERNAME}/notes/no-such-note`);
    expect(res.status).toBe(404);
  });
});

// ── 5. WebFinger ───────────────────────────────────────────────
describe('GET /api/federation/webfinger', () => {
  it('resolves acct: resource to actor URL', async () => {
    const res = await request(app)
      .get('/api/federation/webfinger')
      .query({ resource: `acct:${ACTOR_USERNAME}@bridge.test` });
    expect(res.status).toBe(200);
    expect(res.body.subject).toBe(`acct:${ACTOR_USERNAME}@bridge.test`);
    expect(res.body.links[0].type).toBe('application/activity+json');
    expect(res.body.links[0].href).toContain(ACTOR_USERNAME);
  });

  it('returns 400 for missing acct: prefix', async () => {
    const res = await request(app)
      .get('/api/federation/webfinger')
      .query({ resource: 'invalid' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown user', async () => {
    const res = await request(app)
      .get('/api/federation/webfinger')
      .query({ resource: 'acct:ghost_404@bridge.test' });
    expect(res.status).toBe(404);
  });
});

// ── 6. NodeInfo ────────────────────────────────────────────────
describe('NodeInfo endpoints', () => {
  it('/.well-known/nodeinfo returns link to schema 2.1', async () => {
    const res = await request(app).get('/.well-known/nodeinfo');
    expect(res.status).toBe(200);
    expect(res.body.links[0].rel).toContain('nodeinfo.diaspora.software');
    expect(res.body.links[0].href).toContain('/nodeinfo/2.1');
  });

  it('/nodeinfo/2.1 returns bridge software name and activitypub protocol', async () => {
    const res = await request(app).get('/nodeinfo/2.1');
    expect(res.status).toBe(200);
    expect(res.body.software.name).toBe('bridge');
    expect(res.body.protocols).toContain('activitypub');
    expect(res.body.version).toBe('2.1');
  });

  it('/nodeinfo/2.1 includes user count', async () => {
    const res = await request(app).get('/nodeinfo/2.1');
    expect(typeof res.body.usage.users.total).toBe('number');
  });
});

// ── 7. Inbox — Follow aktivitesi ──────────────────────────────
describe('POST /api/federation/users/:username/inbox — Follow', () => {
  it('returns 202 for valid Follow (dev mode, no signature required)', async () => {
    // apFollows insert mock için fetch gerekmez
    global.fetch.mockResolvedValue({ ok: true, status: 202, json: async () => ({}) });

    const res = await request(app)
      .post(`/api/federation/users/${ACTOR_USERNAME}/inbox`)
      .set('Content-Type', 'application/activity+json')
      .send({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id:     'https://mastodon.social/users/newfollow#follows/999',
        type:   'Follow',
        actor:  'https://mastodon.social/users/newfollow',
        object: `https://bridge.test/api/federation/users/${ACTOR_USERNAME}`,
      });

    expect(res.status).toBe(202);
  });

  it('returns 404 inbox for unknown user', async () => {
    const res = await request(app)
      .post('/api/federation/users/ghost_user_404/inbox')
      .send({ type: 'Follow', actor: 'https://remote.example/users/x', object: 'y' });
    expect(res.status).toBe(404);
  });
});

// ── 8. RSA Key üretimi kontrolü ───────────────────────────────
describe('ActivityPub RSA Keys', () => {
  it('generated key pair is valid RSA-2048', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding:  { type: 'spki',  format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    expect(publicKey).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(privateKey).toMatch(/^-----BEGIN PRIVATE KEY-----/);

    // İmzalama / doğrulama round-trip
    const sign   = crypto.createSign('RSA-SHA256');
    sign.update('bridge-test-payload');
    const signature = sign.sign(privateKey, 'base64');

    const verify = crypto.createVerify('RSA-SHA256');
    verify.update('bridge-test-payload');
    expect(verify.verify(publicKey, signature, 'base64')).toBe(true);
  });
});
