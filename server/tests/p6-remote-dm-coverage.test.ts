process.env.NODE_ENV = 'test';
process.env.INSTANCE_URL = 'http://localhost:3001';

import express from 'express';
import request from 'supertest';

const mockAlice = { _id: 'user-001', username: 'alice', displayName: 'Alice' };
const mockRemote = 'https://remote.example/users/bob';
const mockOtherRemote = 'https://other.example/users/carol';
const mockPublic = 'https://www.w3.org/ns/activitystreams#Public';

let mockInboundValue: unknown = [];
let mockOutboundValue: unknown = [];

const mockFederation = {
  apMessagesFind: jest.fn(),
  apActivitiesFind: jest.fn(),
  findApMessageOne: jest.fn(),
  findActivities: jest.fn(),
  insertActivity: jest.fn(),
};
const mockUsers = { findById: jest.fn() };
const mockDeliver = jest.fn();

jest.mock('../db/repositories', () => ({ Federation: mockFederation, Users: mockUsers }));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const typed = req as express.Request & { user?: { id: string } };
    typed.user = { id: req.get('x-user-id') || 'user-001' };
    next();
  },
  castAuthed: (req: express.Request) => req as express.Request & { user: { id: string } },
}));
jest.mock('../routes/federation/helpers', () => ({ deliverApActivity: mockDeliver }));

import remoteDmRouter from '../routes/federation/remote-dm';

const app = express();
app.use(express.json());
app.use('/federation', remoteDmRouter);

function chain(value: unknown) {
  const api: { sort: jest.Mock; limit: jest.Mock } = {
    sort: jest.fn(),
    limit: jest.fn(),
  };
  api.sort.mockReturnValue(api);
  api.limit.mockImplementation(async () => value);
  return api;
}

function threadId(actor = mockRemote) {
  return Buffer.from(actor, 'utf8').toString('base64url');
}

function inbound(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'in-1',
    apId: 'https://remote.example/notes/1',
    actorUrl: mockRemote,
    targetUserId: mockAlice._id,
    visibility: 'direct',
    content: 'hello',
    published: 1000,
    createdAt: 1000,
    deletedAt: null,
    ...overrides,
  };
}

function outbound(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'out-1',
    actorUserId: mockAlice._id,
    actorUrl: mockRemote,
    type: 'Create',
    activityId: 'http://localhost:3001/api/federation/users/alice/activities/dm-1',
    noteId: 'http://localhost:3001/api/federation/users/alice/notes/1',
    publishedAt: 2000,
    createdAt: 2000,
    activity: {
      type: 'Create',
      object: { type: 'Note', content: 'reply', to: [mockRemote], cc: [] },
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.INSTANCE_URL = 'http://localhost:3001';
  delete process.env.PORT;
  mockInboundValue = [];
  mockOutboundValue = [];
  mockFederation.apMessagesFind.mockImplementation(() => chain(mockInboundValue));
  mockFederation.apActivitiesFind.mockImplementation(() => chain(mockOutboundValue));
  mockFederation.findApMessageOne.mockResolvedValue(inbound());
  mockFederation.findActivities.mockResolvedValue([]);
  mockFederation.insertActivity.mockResolvedValue({ ok: true });
  mockUsers.findById.mockImplementation(async (id: string) => id === mockAlice._id ? mockAlice : null);
  mockDeliver.mockResolvedValue(undefined);
});

describe('P6 remote DM router branch coverage', () => {
  it('rejects malformed, non-URL, unsupported-scheme and overlong thread ids', async () => {
    const malformed = await request(app).get('/federation/remote-dms/***/messages');
    expect(malformed.status).toBe(400);

    const notUrl = await request(app).get(`/federation/remote-dms/${threadId('not a url')}/messages`);
    expect(notUrl.status).toBe(400);

    const ftp = await request(app).get(`/federation/remote-dms/${threadId('ftp://remote.example/users/bob')}/messages`);
    expect(ftp.status).toBe(400);

    const longActor = `https://remote.example/users/${'x'.repeat(2050)}`;
    const tooLong = await request(app).get(`/federation/remote-dms/${threadId(longActor)}/messages`);
    expect(tooLong.status).toBe(400);
  });

  it('skips empty actors, tolerates malformed actor identities, and keeps the newest inbound thread item', async () => {
    mockInboundValue = [
      inbound({ actorUrl: '' }),
      inbound({ actorUrl: 7 }),
      inbound({ _id: 'bad-url', actorUrl: 'not a url', published: 900 }),
      inbound({ _id: 'older', published: 1000, content: 'older' }),
      inbound({ _id: 'newer', published: 1100, content: 'newer' }),
    ];

    const res = await request(app).get('/federation/remote-dms');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const remote = res.body.find((item: { actorUrl: string }) => item.actorUrl === mockRemote);
    expect(remote.lastMessage.content).toBe('newer');
    const malformed = res.body.find((item: { actorUrl: string }) => item.actorUrl === 'not a url');
    expect(malformed.other.username).toBe('not a url');
  });

  it('filters malformed/public/followers outbound activities and accepts string direct audiences', async () => {
    mockOutboundValue = [
      outbound({ actorUrl: 7 }),
      outbound({ type: 'Update' }),
      outbound({ activity: null }),
      outbound({ activity: { type: 'Create', object: { type: 'Question' } } }),
      outbound({ activity: { type: 'Create', object: { type: 'Note', content: 'public', to: [mockPublic], cc: [] } } }),
      outbound({ activity: { type: 'Create', object: { type: 'Note', content: 'followers', to: [], cc: ['https://remote.example/users/bob/followers'] } } }),
      outbound({
        actorUrl: mockOtherRemote,
        publishedAt: 3000,
        activity: { type: 'Create', object: { type: 'Note', content: 'string audience', to: mockOtherRemote, cc: mockRemote } },
      }),
      outbound({
        actorUrl: mockRemote,
        publishedAt: 800,
        activity: { type: 'Create', object: { type: 'Note', content: 'no audience arrays', to: null, cc: null } },
      }),
    ];
    mockInboundValue = [inbound({ published: 1000, content: 'inbound wins over older outbound' })];

    const res = await request(app).get('/federation/remote-dms');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.find((item: { actorUrl: string }) => item.actorUrl === mockRemote).lastMessage.content)
      .toBe('inbound wins over older outbound');
    expect(res.body.find((item: { actorUrl: string }) => item.actorUrl === mockOtherRemote).lastMessage.content)
      .toBe('string audience');
  });

  it('normalizes non-array list query results to empty lists', async () => {
    mockInboundValue = { nope: true };
    mockOutboundValue = 'nope';
    const res = await request(app).get('/federation/remote-dms');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('rejects invalid history pagination independently for limit and before', async () => {
    const badLimit = await request(app).get(`/federation/remote-dms/${threadId()}/messages?limit=0`);
    expect(badLimit.status).toBe(400);

    const badBefore = await request(app).get(`/federation/remote-dms/${threadId()}/messages?before=-1`);
    expect(badBefore.status).toBe(400);
  });

  it('normalizes non-array history query results', async () => {
    mockInboundValue = { nope: true };
    mockOutboundValue = 7;
    const res = await request(app).get(`/federation/remote-dms/${threadId()}/messages`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('covers message id/content/time fallbacks, username fallback, before filtering and limit slicing', async () => {
    mockInboundValue = [
      inbound({ _id: undefined, apId: undefined, content: 42, published: 'bad', createdAt: '500' }),
      inbound({ _id: 'too-new', content: 'later', published: 900 }),
    ];
    mockOutboundValue = [outbound({
      _id: undefined,
      activityId: undefined,
      publishedAt: 'bad',
      createdAt: '600',
      activity: { type: 'Create', object: { type: 'Note', content: 99, to: [mockRemote], cc: [] } },
    })];
    mockUsers.findById.mockResolvedValueOnce({ _id: mockAlice._id, username: 'alice', displayName: '' });

    const res = await request(app).get(`/federation/remote-dms/${threadId()}/messages?before=700&limit=1`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].direction).toBe('out');
    expect(res.body[0].content).toBe('');
    expect(res.body[0].displayName).toBe('alice');
    expect(res.body[0]._id).toContain('local:600');
  });

  it('covers POST content length and client nonce validation branches', async () => {
    const missing = await request(app)
      .post(`/federation/remote-dms/${threadId()}/messages`)
      .send({});
    expect(missing.status).toBe(400);

    const tooLong = await request(app)
      .post(`/federation/remote-dms/${threadId()}/messages`)
      .send({ content: 'x'.repeat(2001) });
    expect(tooLong.status).toBe(400);

    const badNonce = await request(app)
      .post(`/federation/remote-dms/${threadId()}/messages`)
      .send({ content: 'ok', clientNonce: 'contains space' });
    expect(badNonce.status).toBe(400);
  });

  it('requires an inbound direct thread before allowing a reply', async () => {
    mockFederation.findApMessageOne.mockResolvedValueOnce(null);
    const res = await request(app)
      .post(`/federation/remote-dms/${threadId()}/messages`)
      .send({ content: 'probe' });
    expect(res.status).toBe(404);
    expect(mockFederation.insertActivity).not.toHaveBeenCalled();
    expect(mockDeliver).not.toHaveBeenCalled();
  });

  it('returns 401 if the authenticated route user disappears before reply persistence', async () => {
    const res = await request(app)
      .post(`/federation/remote-dms/${threadId()}/messages`)
      .set('x-user-id', 'missing-user')
      .send({ content: 'reply' });
    expect(res.status).toBe(401);
  });

  it('uses localhost/PORT and UUID fallbacks and persists when the activity lookup is not an array', async () => {
    delete process.env.INSTANCE_URL;
    process.env.PORT = '3998';
    mockFederation.findActivities.mockResolvedValueOnce({ unexpected: true });

    const res = await request(app)
      .post(`/federation/remote-dms/${threadId()}/messages`)
      .send({ content: 'fallback reply' });

    expect(res.status).toBe(201);
    const stored = mockFederation.insertActivity.mock.calls[0]?.[0];
    expect(stored.activity.actor).toBe('http://localhost:3998/api/federation/users/alice');
    expect(stored.activityId).toMatch(/\/activities\/[0-9a-f-]+$/i);
    expect(mockDeliver).toHaveBeenCalledWith(mockRemote, stored.activity, mockAlice);
  });

  it('reuses an existing nonce activity and falls back to username for the response display name', async () => {
    const existing = outbound({ _id: undefined, activityId: 'existing-activity' });
    mockFederation.findActivities.mockResolvedValueOnce([existing]);
    mockUsers.findById.mockResolvedValueOnce({ _id: mockAlice._id, username: 'alice', displayName: '' });

    const res = await request(app)
      .post(`/federation/remote-dms/${threadId()}/messages`)
      .send({ content: 'same', clientNonce: 'same-1' });

    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe('alice');
    expect(mockFederation.insertActivity).not.toHaveBeenCalled();
    expect(mockDeliver).not.toHaveBeenCalled();
  });
});
