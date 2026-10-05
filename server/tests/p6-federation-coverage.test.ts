process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secretxxxxxxxxxxxxxxxxxxxxx';
process.env.INSTANCE_URL = 'http://localhost:3001';

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const alice = { _id: 'user-001', username: 'alice', displayName: 'Alice', tokenVersion: 0 };
const bob = { _id: 'user-002', username: 'bob', displayName: 'Bob', tokenVersion: 0 };
const remoteActor = 'https://remote.example/users/bob';

let inboundResult: unknown = [];
let outboundResult: unknown = [];

function queryChain(value: () => unknown) {
  const api = {
    sort: jest.fn(() => api),
    limit: jest.fn(async () => value()),
  };
  return api;
}

const Users = {
  findByUsername: jest.fn(async (username: string) => username === 'alice' ? alice : username === 'bob' ? bob : null),
  findById: jest.fn(async (id: string) => id === alice._id ? alice : id === bob._id ? bob : null),
};

const Federation = {
  findActivities: jest.fn(),
  insertActivity: jest.fn(),
  apMessagesFind: jest.fn(() => queryChain(() => inboundResult)),
  apActivitiesFind: jest.fn(() => queryChain(() => outboundResult)),
  findApMessageOne: jest.fn(),
};

jest.mock('../db/repositories', () => ({ Users, Federation }));

const fanOutActivityToFollowers = jest.fn();
const deliverApActivity = jest.fn();
jest.mock('../routes/federation/helpers', () => ({
  fanOutActivityToFollowers: (...args: unknown[]) => fanOutActivityToFollowers(...args),
  deliverApActivity: (...args: unknown[]) => deliverApActivity(...args),
}));

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() };
jest.mock('../lib/logger', () => ({ __esModule: true, default: logger, createLogger: () => logger }));

import lifecycleRouter from '../routes/federation/lifecycle';
import remoteDmRouter from '../routes/federation/remote-dm';

const app = express();
app.use(express.json());
app.use('/lifecycle', lifecycleRouter);
app.use('/dm', remoteDmRouter);

function token(userId: string) {
  return jwt.sign({ id: userId, username: userId, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

function noteId(base = 'http://localhost:3001') {
  return `${base}/api/federation/users/alice/notes/note-1`;
}

function createRow(overrides: Record<string, unknown> = {}) {
  const id = String(overrides.noteId || noteId());
  return {
    _id: 'row-create',
    actorUserId: alice._id,
    type: 'Create',
    noteId: id,
    publishedAt: 100,
    createdAt: 100,
    activity: {
      type: 'Create',
      object: {
        id,
        type: 'Note',
        attributedTo: 'http://localhost:3001/api/federation/users/alice',
        content: 'original',
        published: '2026-10-05T08:00:00.000Z',
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        cc: ['http://localhost:3001/api/federation/users/alice/followers'],
      },
    },
    ...overrides,
  };
}

function directCreate(actorUrl = remoteActor, content: unknown = 'reply', overrides: Record<string, unknown> = {}) {
  return {
    _id: 'out-1',
    actorUserId: alice._id,
    actorUrl,
    type: 'Create',
    activityId: 'http://localhost:3001/api/federation/users/alice/activities/dm-1',
    noteId: 'http://localhost:3001/api/federation/users/alice/notes/1',
    publishedAt: 2000,
    createdAt: 2000,
    activity: {
      type: 'Create',
      object: { type: 'Note', content, to: actorUrl, cc: 'https://remote.example/users/other' },
    },
    ...overrides,
  };
}

describe('P6 federation coverage closure', () => {
  const originalInstanceUrl = process.env.INSTANCE_URL;
  const originalPort = process.env.PORT;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.INSTANCE_URL = 'http://localhost:3001';
    delete process.env.PORT;
    inboundResult = [];
    outboundResult = [];
    Users.findByUsername.mockImplementation(async (username: string) => username === 'alice' ? alice : username === 'bob' ? bob : null);
    Users.findById.mockImplementation(async (id: string) => id === alice._id ? alice : id === bob._id ? bob : null);
    Federation.findActivities.mockResolvedValue([]);
    Federation.insertActivity.mockResolvedValue({ ok: true });
    Federation.findApMessageOne.mockResolvedValue(null);
    fanOutActivityToFollowers.mockResolvedValue({ followers: 1, failed: 0 });
    deliverApActivity.mockResolvedValue(undefined);
  });

  afterAll(() => {
    if (originalInstanceUrl === undefined) delete process.env.INSTANCE_URL;
    else process.env.INSTANCE_URL = originalInstanceUrl;
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;
  });

  describe('authored Note lifecycle edge paths', () => {
    it('uses the localhost fallback and materializes cursor-backed legacy history', async () => {
      delete process.env.INSTANCE_URL;
      process.env.PORT = '4444';
      const id = noteId('http://localhost:4444');
      Federation.findActivities.mockReturnValue({
        toArray: async () => [
          {
            _id: 'newest-legacy', type: '', noteId: id,
            publishedAt: 'not-a-number', createdAt: '200',
            activity: { type: 'Announce', object: 'not-a-note' },
          },
          createRow({ noteId: id, publishedAt: '100' }),
        ],
      });

      const res = await request(app).get('/lifecycle/users/alice/notes/note-1');
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(id);
      expect(res.body.content).toBe('original');
    });

    it('treats unusable cursor results and non-cursor values as no durable history', async () => {
      Federation.findActivities.mockReturnValueOnce({ toArray: async () => ({ nope: true }) });
      const badCursor = await request(app).get('/lifecycle/users/alice/notes/note-1');
      expect(badCursor.status).toBe(404);

      Federation.findActivities.mockReturnValueOnce({ unexpected: true });
      const nonCursor = await request(app).get('/lifecycle/users/alice/notes/note-1');
      expect(nonCursor.status).toBe(404);
    });

    it('covers missing users, missing Notes, and Tombstone timestamp fallback', async () => {
      const missingUser = await request(app).get('/lifecycle/users/nobody/notes/note-1');
      expect(missingUser.status).toBe(404);

      Federation.findActivities.mockResolvedValueOnce([]);
      const missingNote = await request(app).get('/lifecycle/users/alice/notes/note-1');
      expect(missingNote.status).toBe(404);

      Federation.findActivities.mockResolvedValueOnce([{
        _id: 'delete', type: 'Delete', activity: { type: 'Delete' },
        noteId: noteId(), publishedAt: 'bad', createdAt: '300',
      }]);
      const tombstone = await request(app).get('/lifecycle/users/alice/notes/note-1');
      expect(tombstone.status).toBe(410);
      expect(tombstone.body.deleted).toBe(new Date(300).toISOString());
    });

    it('rejects every PATCH payload validation edge without persisting', async () => {
      Federation.findActivities.mockResolvedValue([createRow()]);
      const auth = `Bearer ${token(alice._id)}`;

      const arrayBody = await request(app).patch('/lifecycle/users/alice/notes/note-1').set('Authorization', auth).send([]);
      expect(arrayBody.status).toBe(400);
      const blank = await request(app).patch('/lifecycle/users/alice/notes/note-1').set('Authorization', auth).send({ content: '   ' });
      expect(blank.status).toBe(400);
      const long = await request(app).patch('/lifecycle/users/alice/notes/note-1').set('Authorization', auth).send({ content: 'x'.repeat(5001) });
      expect(long.status).toBe(400);
      const badSensitive = await request(app).patch('/lifecycle/users/alice/notes/note-1').set('Authorization', auth).send({ content: 'ok', sensitive: 'yes' });
      expect(badSensitive.status).toBe(400);
      const badSummary = await request(app).patch('/lifecycle/users/alice/notes/note-1').set('Authorization', auth).send({ content: 'ok', summary: 42 });
      expect(badSummary.status).toBe(400);
      expect(Federation.insertActivity).not.toHaveBeenCalled();
    });

    it('covers PATCH ownership/not-found paths plus default audience/context and summary removal', async () => {
      const aliceAuth = `Bearer ${token(alice._id)}`;
      const bobAuth = `Bearer ${token(bob._id)}`;

      const noUser = await request(app).patch('/lifecycle/users/nobody/notes/note-1').set('Authorization', aliceAuth).send({ content: 'x' });
      expect(noUser.status).toBe(404);

      Federation.findActivities.mockResolvedValueOnce([]);
      const noNote = await request(app).patch('/lifecycle/users/alice/notes/note-1').set('Authorization', aliceAuth).send({ content: 'x' });
      expect(noNote.status).toBe(404);

      Federation.findActivities.mockResolvedValueOnce([createRow()]);
      const wrongOwner = await request(app).patch('/lifecycle/users/alice/notes/note-1').set('Authorization', bobAuth).send({ content: 'x' });
      expect(wrongOwner.status).toBe(403);

      const sparse = createRow({
        activity: { type: 'Create', object: { id: noteId(), type: 'Note', content: 'old', summary: 'remove-me' } },
      });
      Federation.findActivities.mockResolvedValueOnce([sparse]);
      const success = await request(app)
        .patch('/lifecycle/users/alice/notes/note-1')
        .set('Authorization', aliceAuth)
        .send({ content: ' trimmed ', summary: null });
      expect(success.status).toBe(200);
      const stored = Federation.insertActivity.mock.calls.at(-1)?.[0];
      expect(stored.activity.object).toEqual(expect.objectContaining({
        '@context': 'https://www.w3.org/ns/activitystreams',
        content: 'trimmed', to: [], cc: [],
      }));
      expect(stored.activity.object.summary).toBeUndefined();
      expect(stored.activity.object.sensitive).toBeUndefined();
    });

    it('covers empty-summary removal and persisted Update when follower enumeration fails', async () => {
      Federation.findActivities.mockResolvedValue([createRow()]);
      fanOutActivityToFollowers.mockRejectedValueOnce(new Error('followers unavailable'));
      const res = await request(app)
        .patch('/lifecycle/users/alice/notes/note-1')
        .set('Authorization', `Bearer ${token(alice._id)}`)
        .send({ content: 'updated', summary: '' });
      expect(res.status).toBe(200);
      expect(res.body.delivery).toEqual({ followers: 0, failed: 1 });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'federation.outbox.update_fanout_failed' }),
        expect.any(String),
      );
    });

    it('covers DELETE missing state, missing user, wrong owner, and fanout failure', async () => {
      const aliceAuth = `Bearer ${token(alice._id)}`;
      const bobAuth = `Bearer ${token(bob._id)}`;

      const noUser = await request(app).delete('/lifecycle/users/nobody/notes/note-1').set('Authorization', aliceAuth);
      expect(noUser.status).toBe(404);

      Federation.findActivities.mockResolvedValueOnce([createRow()]);
      const wrongOwner = await request(app).delete('/lifecycle/users/alice/notes/note-1').set('Authorization', bobAuth);
      expect(wrongOwner.status).toBe(403);

      Federation.findActivities.mockResolvedValueOnce([]);
      const missing = await request(app).delete('/lifecycle/users/alice/notes/note-1').set('Authorization', aliceAuth);
      expect(missing.status).toBe(404);

      Federation.findActivities.mockResolvedValueOnce([createRow()]);
      fanOutActivityToFollowers.mockRejectedValueOnce(new Error('fanout failed'));
      const deleted = await request(app).delete('/lifecycle/users/alice/notes/note-1').set('Authorization', aliceAuth);
      expect(deleted.status).toBe(204);
      expect(Federation.insertActivity).toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'federation.outbox.delete_fanout_failed' }),
        expect.any(String),
      );
    });
  });

  describe('remote DM defensive and fallback paths', () => {
    it('rejects malformed, non-URL, non-http, and oversized thread ids', async () => {
      const auth = `Bearer ${token(alice._id)}`;
      for (const id of [
        '***',
        Buffer.from('not a url').toString('base64url'),
        Buffer.from('ftp://remote.example/users/bob').toString('base64url'),
        Buffer.from(`https://remote.example/${'x'.repeat(2050)}`).toString('base64url'),
      ]) {
        const res = await request(app).get(`/dm/remote-dms/${id}/messages`).set('Authorization', auth);
        expect(res.status).toBe(400);
      }
    });

    it('lists malformed inbound identities safely and filters non-direct outbound activities', async () => {
      inboundResult = [
        { actorUrl: 'not a url', content: 123, published: 'bad', createdAt: '50' },
        { _id: 'skip-empty-actor', actorUrl: '', content: 'skip', published: 60 },
      ];
      outboundResult = [
        { actorUrl: remoteActor, type: 'Update', activity: {} },
        { actorUrl: remoteActor, type: 'Create', activity: null },
        { actorUrl: remoteActor, type: 'Create', activity: { object: null } },
        { actorUrl: remoteActor, type: 'Create', activity: { object: { type: 'Article' } } },
        directCreate(remoteActor, 'public', { activity: { type: 'Create', object: { type: 'Note', to: 'https://www.w3.org/ns/activitystreams#Public', cc: [] } } }),
        directCreate(remoteActor, 'followers', { activity: { type: 'Create', object: { type: 'Note', to: [], cc: 'https://remote.example/users/bob/followers' } } }),
        directCreate('https://remote.example/users/carol', 'direct-string-audience', { publishedAt: 3000 }),
        { ...directCreate('https://remote.example/users/dave', 'direct-array-audience'), activity: { type: 'Create', object: { type: 'Note', content: 'array', to: ['https://remote.example/users/dave'], cc: [] } } },
      ];

      const res = await request(app).get('/dm/remote-dms').set('Authorization', `Bearer ${token(alice._id)}`);
      expect(res.status).toBe(200);
      expect(res.body.some((thread: { actorUrl: string }) => thread.actorUrl === 'not a url')).toBe(true);
      expect(res.body.some((thread: { actorUrl: string }) => thread.actorUrl.includes('/users/carol'))).toBe(true);
      expect(res.body.some((thread: { actorUrl: string }) => thread.actorUrl.includes('/users/dave'))).toBe(true);
    });

    it('normalizes non-array repository results to empty lists', async () => {
      inboundResult = { not: 'an array' };
      outboundResult = null;
      const res = await request(app).get('/dm/remote-dms').set('Authorization', `Bearer ${token(alice._id)}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('rejects invalid history pagination and normalizes non-array history query results', async () => {
      const id = Buffer.from(remoteActor).toString('base64url');
      const auth = `Bearer ${token(alice._id)}`;
      const badLimit = await request(app).get(`/dm/remote-dms/${id}/messages?limit=0`).set('Authorization', auth);
      expect(badLimit.status).toBe(400);
      const badBefore = await request(app).get(`/dm/remote-dms/${id}/messages?before=-1`).set('Authorization', auth);
      expect(badBefore.status).toBe(400);

      inboundResult = { nope: true };
      outboundResult = 'nope';
      const normalized = await request(app).get(`/dm/remote-dms/${id}/messages?limit=1&before=10`).set('Authorization', auth);
      expect(normalized.status).toBe(200);
      expect(normalized.body).toEqual([]);
    });

    it('applies before/limit history filtering and falls back to username display name', async () => {
      const id = Buffer.from(remoteActor).toString('base64url');
      inboundResult = [
        { _id: 'i1', actorUrl: remoteActor, content: 'old', published: 1 },
        { apId: 'i2', actorUrl: remoteActor, content: 'new', published: 30 },
      ];
      outboundResult = [directCreate(remoteActor, 'middle', { _id: undefined, activityId: undefined, publishedAt: 20 })];
      Users.findById.mockImplementation(async (idValue: string) => idValue === alice._id ? { ...alice, displayName: '' } : null);

      const res = await request(app)
        .get(`/dm/remote-dms/${id}/messages?limit=1&before=25`)
        .set('Authorization', `Bearer ${token(alice._id)}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].content).toBe('middle');
      expect(res.body[0].displayName).toBe('alice');
    });

    it('rejects empty/oversized content and invalid nonces before touching the journal', async () => {
      const id = Buffer.from(remoteActor).toString('base64url');
      const auth = `Bearer ${token(alice._id)}`;
      for (const body of [
        [],
        { content: '   ' },
        { content: 'x'.repeat(2001) },
        { content: 'ok', clientNonce: 'bad nonce!' },
      ]) {
        const res = await request(app).post(`/dm/remote-dms/${id}/messages`).set('Authorization', auth).send(body);
        expect(res.status).toBe(400);
      }
      expect(Federation.findApMessageOne).not.toHaveBeenCalled();
    });

    it('requires an existing inbound thread and handles a missing authenticated user record', async () => {
      const id = Buffer.from(remoteActor).toString('base64url');
      const auth = `Bearer ${token(alice._id)}`;
      Federation.findApMessageOne.mockResolvedValueOnce(null);
      const missingThread = await request(app).post(`/dm/remote-dms/${id}/messages`).set('Authorization', auth).send({ content: 'hello' });
      expect(missingThread.status).toBe(404);

      Federation.findApMessageOne.mockResolvedValueOnce({ _id: 'in' });
      Users.findById.mockResolvedValueOnce(null);
      const missingUser = await request(app).post(`/dm/remote-dms/${id}/messages`).set('Authorization', auth).send({ content: 'hello' });
      expect(missingUser.status).toBe(401);
    });

    it('uses local actor fallbacks, random activity ids, and non-array idempotency results', async () => {
      delete process.env.INSTANCE_URL;
      process.env.PORT = '4555';
      const id = Buffer.from(remoteActor).toString('base64url');
      Federation.findApMessageOne.mockResolvedValue({ _id: 'in' });
      Federation.findActivities.mockResolvedValue({ not: 'an array' });

      const res = await request(app)
        .post(`/dm/remote-dms/${id}/messages`)
        .set('Authorization', `Bearer ${token(alice._id)}`)
        .send({ content: '  hello  ' });
      expect(res.status).toBe(201);
      const row = Federation.insertActivity.mock.calls.at(-1)?.[0];
      expect(row.activityId).toContain('http://localhost:4555/api/federation/users/alice/activities/');
      expect(row.activity.object.content).toBe('hello');
      expect(deliverApActivity).toHaveBeenCalled();
    });

    it('uses port 3001 fallback and safely renders a sparse idempotent row', async () => {
      delete process.env.INSTANCE_URL;
      delete process.env.PORT;
      const id = Buffer.from(remoteActor).toString('base64url');
      Federation.findApMessageOne.mockResolvedValue({ _id: 'in' });
      Federation.findActivities.mockResolvedValue([{}]);

      const res = await request(app)
        .post(`/dm/remote-dms/${id}/messages`)
        .set('Authorization', `Bearer ${token(alice._id)}`)
        .send({ content: 'hello', clientNonce: 'stable' });
      expect(res.status).toBe(200);
      expect(res.body.content).toBe('');
      expect(res.body.direction).toBe('out');
      expect(Federation.insertActivity).not.toHaveBeenCalled();
    });
  });
});
