// server/tests/federation.test.ts
// Tests for federation endpoints: /info, /servers, /peers (add/delete), /discover
import type { RequestBody } from './helpers/httpDoubles';
import { fetchMock, installFetchMock } from './helpers/fetchDouble';

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

import { createMockDb, makeUser, makeServer } from './helpers/mockDb';
const mockDb = createMockDb();

jest.mock('../db/index', () => mockDb);
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
  castAuthed: (req: Request) => req,
}));

jest.mock('../lib/fetch', () => ({
  fetchT: jest.fn((...args: Parameters<typeof fetch>) => global.fetch(...args)),
}));

// Mock global fetch for remote peer calls
installFetchMock();

import request from 'supertest';
import express from 'express';
const jwt     = require('jsonwebtoken');

import router from '../routes/federation';
import { requireDoc } from './helpers/mockDb';

const app = express();
app.use(express.json());
app.use('/api/federation', router);
app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(err.status || 500).json({ error: err.message }));

function token(id: string, opts = {}) {
  return jwt.sign({ id, username: 'user', displayName: 'User', v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h', ...opts });
}

const ADMIN_ID  = 'admin1';
const USER_ID   = 'user1';
const SERVER_ID = 'srv1';

beforeAll(async () => {
  await mockDb.users.insert(makeUser({ _id: ADMIN_ID, username: 'admin', isAdmin: 1 }));
  await mockDb.users.insert(makeUser({ _id: USER_ID,  username: 'regularuser' }));
  await mockDb.servers.insert(makeServer(ADMIN_ID, { _id: SERVER_ID, discoverable: 1, description: 'Test server', tags: ['test'] }));
  await mockDb.members.insert({ userId: ADMIN_ID, serverId: SERVER_ID, roles: '[]', joinedAt: Date.now() });
});

// ── /info endpoint ────────────────────────────────────────────

describe('GET /api/federation/info', () => {
  it('is publicly accessible (no auth required)', async () => {
    const res = await request(app).get('/api/federation/info');
    expect(res.status).toBe(200);
    expect(res.body.software).toBe('bridge');
    expect(res.body.federation).toBe(true);
  });

  it('returns instance metadata', async () => {
    const res = await request(app).get('/api/federation/info');
    expect(res.body.name).toBeDefined();
    expect(res.body.version).toBeDefined();
  });
});

// ── /servers endpoint ──────────────────────────────────────────

describe('GET /api/federation/servers', () => {
  it('returns discoverable servers', async () => {
    const res = await request(app).get('/api/federation/servers');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.servers)).toBe(true);
  });

  it('does not expose non-discoverable servers', async () => {
    // Insert a private server
    await mockDb.servers.insert(makeServer(ADMIN_ID, { _id: 'private-srv', discoverable: 0 }));
    const res = await request(app).get('/api/federation/servers');
    const ids = res.body.servers.map((s: Record<string, unknown>) => s.id || s._id);
    expect(ids).not.toContain('private-srv');
  });
});

// ── /peers endpoint ───────────────────────────────────────────

describe('POST /api/federation/peers', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await request(app).post('/api/federation/peers').send({ url: 'http://peer.example.com' });
    expect(res.status).toBe(401);
  });

  it('rejects non-admin users', async () => {
    const res = await request(app)
      .post('/api/federation/peers')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .send({ url: 'http://peer.example.com' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin/i);
  });

  it('returns 400 when url is missing', async () => {
    const res = await request(app)
      .post('/api/federation/peers')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/url/i);
  });

  it('returns 400 when remote server is unreachable', async () => {
    fetchMock().mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await request(app)
      .post('/api/federation/peers')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`)
      .send({ url: 'http://offline.example.com' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/could not reach/i);
  });

  it('adds a valid Bridge peer', async () => {
    fetchMock().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        software: 'bridge',
        name: 'Remote Bridge',
        description: 'Remote instance',
        url: 'https://remote.bridge.example.com',
        version: 24,
        federation: true,
        // P5 FED-04: a peer must publish its RSA key (ADR-0006 Faz 3 accepts nothing else).
        publicKey: { publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----' },
      }),
    });

    const res = await request(app)
      .post('/api/federation/peers')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`)
      .send({ url: 'https://remote.bridge.example.com' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.peer._id).toBeDefined();
  });

  it('rejects duplicate peer (409)', async () => {
    // Same URL as above — already added
    fetchMock().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        software: 'bridge',
        name: 'Remote Bridge',
        url: 'https://remote.bridge.example.com',
        version: 24,
        federation: true,
        // P5 FED-04: a peer must publish its RSA key (ADR-0006 Faz 3 accepts nothing else).
        publicKey: { publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----' },
      }),
    });

    const res = await request(app)
      .post('/api/federation/peers')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`)
      .send({ url: 'https://remote.bridge.example.com' });

    expect(res.status).toBe(409);
  });
});

describe('DELETE /api/federation/peers/:id', () => {
  let peerId: string;

  beforeAll(async () => {
    // Insert a peer to delete
    const peer = await mockDb.federationPeers.insert({
      url: 'http://todelete.example.com',
      name: 'Delete Me',
      addedAt: Date.now(),
      lastSeen: Date.now(),
      verified: true,
    });
    peerId = peer._id;
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).delete(`/api/federation/peers/${peerId}`);
    expect(res.status).toBe(401);
  });

  it('rejects non-admin users', async () => {
    const res = await request(app)
      .delete(`/api/federation/peers/${peerId}`)
      .set('Authorization', `Bearer ${token(USER_ID)}`);
    expect(res.status).toBe(403);
  });

  it('deletes a peer as admin', async () => {
    const res = await request(app)
      .delete(`/api/federation/peers/${peerId}`)
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ── /discover endpoint ────────────────────────────────────────

describe('GET /api/federation/discover', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/federation/discover');
    expect(res.status).toBe(401);
  });

  it('returns empty list when no peers registered', async () => {
    const res = await request(app)
      .get('/api/federation/discover')
      .set('Authorization', `Bearer ${token(USER_ID)}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.servers)).toBe(true);
  });

  it('filters by query string', async () => {
    const res = await request(app)
      .get('/api/federation/discover?q=nosuchserver')
      .set('Authorization', `Bearer ${token(USER_ID)}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });
});

// ── ActivityPub Inbox ─────────────────────────────────────────

describe('POST /api/federation/users/:username/inbox', () => {
  const INBOX_USER = 'inboxuser';
  const ACTOR_URL  = 'https://mastodon.social/users/remote_actor';

  beforeAll(async () => {
    await mockDb.users.insert(makeUser({ _id: 'inbox-uid', username: INBOX_USER }));
  });

  function inboxPost(username: string, body: RequestBody) {
    return request(app)
      .post(`/api/federation/users/${username}/inbox`)
      .set('Content-Type', 'application/activity+json')
      .send(body);
  }

  it('returns 404 for unknown user', async () => {
    const res = await inboxPost('nobody', { type: 'Follow', actor: ACTOR_URL, id: 'https://x.example/1' });
    expect(res.status).toBe(404);
  });

  it('returns 400 when activity has no type', async () => {
    const res = await inboxPost(INBOX_USER, { actor: ACTOR_URL });
    expect(res.status).toBe(400);
  });

  it('accepts a Follow activity and returns 202', async () => {
    // Mock fetch for Accept delivery back to actor
    fetchMock().mockResolvedValueOnce({ ok: true, json: async () => ({ inbox: `${ACTOR_URL}/inbox` }) });
    fetchMock().mockResolvedValueOnce({ ok: true });

    const res = await inboxPost(INBOX_USER, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id:     'https://mastodon.social/follows/1',
      type:   'Follow',
      actor:  ACTOR_URL,
      object: `http://localhost:3001/api/federation/users/${INBOX_USER}`,
    });

    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
  });

  it('accepts a Create(Note) activity and stores the message', async () => {
    const noteId = 'https://mastodon.social/users/remote_actor/statuses/123';

    const res = await inboxPost(INBOX_USER, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id:    'https://mastodon.social/users/remote_actor/statuses/123/activity',
      type:  'Create',
      actor: ACTOR_URL,
      object: {
        id:        noteId,
        type:      'Note',
        content:   '<p>Merhaba, federe dünya!</p>',
        published: '2026-04-24T10:00:00Z',
      },
    });

    expect(res.status).toBe(202);

    // Mesajın DB'ye kaydedildiğini doğrula
    const saved = await requireDoc(mockDb.apMessages, { apId: noteId });
    expect(saved).toBeTruthy();
    expect(saved.actorUrl).toBe(ACTOR_URL);
    expect(saved.content).toContain('federe dünya');
    expect(saved.visibility).toBe('public');
  });

  it('remote direct Create(Note) timeline kaydını explicit direct olarak sınıflandırır', async () => {
    const noteId = 'https://mastodon.social/users/remote_actor/statuses/direct-1';
    const res = await inboxPost(INBOX_USER, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${noteId}/activity`,
      type: 'Create',
      actor: ACTOR_URL,
      object: {
        id: noteId,
        type: 'Note',
        content: '<p>yalnız alıcı için</p>',
        to: [`http://localhost:3001/api/federation/users/${INBOX_USER}`],
        cc: [],
      },
    });

    expect(res.status).toBe(202);
    const saved = await requireDoc(mockDb.apMessages, { apId: noteId });
    expect(saved).toBeTruthy();
    expect(saved.targetUserId).toBe('inbox-uid');
    expect(saved.visibility).toBe('direct');
  });

  it('ignores Create activity with non-Note object', async () => {
    const res = await inboxPost(INBOX_USER, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id:    'https://mastodon.social/activities/456',
      type:  'Create',
      actor: ACTOR_URL,
      object: { id: 'https://mastodon.social/articles/1', type: 'Article', content: 'test' },
    });

    // Hata vermemeli, sessizce geçmeli
    expect(res.status).toBe(202);
  });

  it('accepts a Delete activity and leaves a tombstone', async () => {
    // A tombstone is durable ordering state: it prevents a delayed Create from
    // resurrecting a remotely deleted object, while read surfaces hide it.
    const apId = 'https://mastodon.social/users/remote_actor/statuses/to-delete';
    await mockDb.apMessages.insert({
      _id: 'del-msg-1', apId, actorUrl: ACTOR_URL,
      targetUserId: 'inbox-uid', content: 'silinecek', createdAt: Date.now(),
    });

    const res = await inboxPost(INBOX_USER, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id:     'https://mastodon.social/activities/delete/1',
      type:   'Delete',
      actor:  ACTOR_URL,
      object: apId,
    });

    expect(res.status).toBe(202);

    const tombstone = await mockDb.apMessages.findOne({ apId });
    expect(tombstone).toBeTruthy();
    expect(tombstone?.content).toBe('');
    expect(typeof tombstone?.deletedAt).toBe('number');
    expect(typeof tombstone?.updatedAt).toBe('number');
  });

  it('accepts Undo(Follow) and removes the follow record', async () => {
    // Önce follow kaydı ekle
    await mockDb.apFollows.insert({
      _id: 'follow-to-undo', actorUrl: ACTOR_URL,
      targetUserId: 'inbox-uid', activityId: 'https://mastodon.social/follows/1', createdAt: Date.now(),
    });

    const res = await inboxPost(INBOX_USER, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id:    'https://mastodon.social/activities/undo/1',
      type:  'Undo',
      actor: ACTOR_URL,
      object: { type: 'Follow', actor: ACTOR_URL },
    });

    expect(res.status).toBe(202);

    const stillExists = await mockDb.apFollows.findOne({ _id: 'follow-to-undo' });
    expect(stillExists).toBeFalsy();
  });
});
