process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secretxxxxxxxxxxxxxxxxxxxxx';
process.env.INSTANCE_URL = 'http://localhost:3001';

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const alice = { _id: 'user-001', username: 'alice', displayName: 'Alice', tokenVersion: 0 };
const remoteActor = 'https://remote.example/users/bob';
const threadId = Buffer.from(remoteActor).toString('base64url');
let inboundRows: Record<string, unknown>[] = [];
let outboundRows: Record<string, unknown>[] = [];

interface QueryChain {
  sort(): QueryChain;
  limit(): Promise<unknown>;
}

function chain(rows: () => unknown): QueryChain {
  const api: QueryChain = {
    sort: jest.fn(() => api),
    limit: jest.fn(async () => rows()),
  };
  return api;
}

const Federation = {
  apMessagesFind: jest.fn(() => chain(() => inboundRows)),
  apActivitiesFind: jest.fn(() => chain(() => outboundRows)),
  findApMessageOne: jest.fn(),
  findActivities: jest.fn().mockResolvedValue([]),
  insertActivity: jest.fn().mockResolvedValue({ ok: true }),
};
const Users = { findById: jest.fn(async (id: string) => id === alice._id ? alice : null) };

jest.mock('../db/repositories', () => ({ Federation, Users }));
const deliverApActivity = jest.fn().mockResolvedValue(undefined);
jest.mock('../routes/federation/helpers', () => ({ deliverApActivity: (...args: unknown[]) => deliverApActivity(...args) }));

import remoteDmRouter from '../routes/federation/remote-dm';

const app = express();
app.use(express.json());
app.use('/federation', remoteDmRouter);

function token(userId = alice._id) {
  return jwt.sign({ id: userId, username: userId, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

function inbound(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'in-1', apId: 'https://remote.example/notes/1', actorUrl: remoteActor,
    targetUserId: alice._id, visibility: 'direct', content: 'hello', published: 1000,
    createdAt: 900, deletedAt: null, ...overrides,
  };
}

function outbound(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'out-1', actorUserId: alice._id, actorUrl: remoteActor, type: 'Create',
    activityId: 'http://localhost:3001/api/federation/users/alice/activities/dm-1',
    noteId: 'http://localhost:3001/api/federation/users/alice/notes/1', publishedAt: 2000, createdAt: 2000,
    activity: { type: 'Create', object: { type: 'Note', content: 'reply', to: [remoteActor], cc: [] } },
    ...overrides,
  };
}

describe('P6 remote DM coverage edges', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    inboundRows = [];
    outboundRows = [];
    Federation.findApMessageOne.mockResolvedValue(inbound());
    Federation.findActivities.mockResolvedValue([]);
    Federation.insertActivity.mockResolvedValue({ ok: true });
    Users.findById.mockImplementation(async (id: string) => id === alice._id ? alice : null);
    deliverApActivity.mockResolvedValue(undefined);
  });

  it.each(['!', 'a'.repeat(4097), Buffer.from('ftp://remote.example/x').toString('base64url')])(
    'rejects invalid thread id %s', async bad => {
      const res = await request(app).get(`/federation/remote-dms/${bad}/messages`)
        .set('Authorization', `Bearer ${token()}`);
      expect(res.status).toBe(400);
    },
  );

  it.each([
    [`/federation/remote-dms/${threadId}/messages?limit=0`, 400],
    [`/federation/remote-dms/${threadId}/messages?limit=101`, 200],
    [`/federation/remote-dms/${threadId}/messages?before=-1`, 400],
  ])('enforces the history pagination contract %s', async (url, expected) => {
    const res = await request(app).get(url).set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(expected);
  });

  it('handles non-array repository results as empty histories', async () => {
    Federation.apMessagesFind.mockImplementationOnce(() => chain(() => ({ bad: true })) as never);
    Federation.apActivitiesFind.mockImplementationOnce(() => chain(() => ({ bad: true })) as never);
    const res = await request(app).get('/federation/remote-dms').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('skips rows without actors and keeps only direct outbound Create Notes', async () => {
    inboundRows = [inbound({ actorUrl: '' }), inbound()];
    outboundRows = [
      outbound({ actorUrl: '' }),
      outbound({ type: 'Update' }),
      outbound({ activity: { type: 'Create', object: { type: 'Note', content: 'public', to: ['https://www.w3.org/ns/activitystreams#Public'], cc: [] } } }),
      outbound({ activity: { type: 'Create', object: { type: 'Note', content: 'followers', to: [`${remoteActor}/followers`], cc: [] } } }),
      outbound(),
    ];
    const res = await request(app).get('/federation/remote-dms').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].actorUrl).toBe(remoteActor);
  });

  it('supports string audiences and filters follower/public visibility from history', async () => {
    inboundRows = [inbound()];
    outboundRows = [
      outbound({ activity: { type: 'Create', object: { type: 'Note', content: 'direct', to: remoteActor, cc: '' } } }),
      outbound({ activity: { type: 'Create', object: { type: 'Note', content: 'not direct', to: remoteActor, cc: 'https://www.w3.org/ns/activitystreams#Public' } } }),
    ];
    const res = await request(app).get(`/federation/remote-dms/${threadId}/messages`)
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.some((m: { content: string }) => m.content === 'direct')).toBe(true);
    expect(res.body.some((m: { content: string }) => m.content === 'not direct')).toBe(false);
  });

  it('uses fallback ids/content/timestamps and pagination slicing', async () => {
    inboundRows = [
      inbound({ _id: undefined, apId: undefined, published: undefined, createdAt: 1, content: 12 }),
      inbound({ _id: 'new', published: 50, content: 'newer' }),
    ];
    outboundRows = [outbound({ _id: undefined, activityId: undefined, publishedAt: undefined, createdAt: 25 })];
    const res = await request(app).get(`/federation/remote-dms/${threadId}/messages?before=40&limit=2`)
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].content).toBe('');
    expect(res.body[1].direction).toBe('out');
  });

  it.each([
    [{}, 400],
    [{ content: '' }, 400],
    [{ content: 'x'.repeat(2001) }, 400],
    [{ content: 'ok', clientNonce: 'bad nonce!' }, 400],
  ])('rejects invalid reply bodies %#', async (body, expected) => {
    const res = await request(app).post(`/federation/remote-dms/${threadId}/messages`)
      .set('Authorization', `Bearer ${token()}`).send(body);
    expect(res.status).toBe(expected);
    expect(Federation.insertActivity).not.toHaveBeenCalled();
  });

  it('returns 401 if the authenticated user disappears after thread lookup', async () => {
    Users.findById.mockResolvedValueOnce(null);
    const res = await request(app).post(`/federation/remote-dms/${threadId}/messages`)
      .set('Authorization', `Bearer ${token()}`).send({ content: 'hello' });
    expect(res.status).toBe(401);
  });

  it('uses a random activity suffix when clientNonce is omitted and trims content', async () => {
    const res = await request(app).post(`/federation/remote-dms/${threadId}/messages`)
      .set('Authorization', `Bearer ${token()}`).send({ content: '  hello  ' });
    expect(res.status).toBe(201);
    const row = Federation.insertActivity.mock.calls[0][0];
    expect(row.activityId).toMatch(/\/activities\/[0-9a-f-]{20,}$/i);
    expect(row.activity.object.content).toBe('hello');
    expect(deliverApActivity).toHaveBeenCalledTimes(1);
  });

  it('uses username when displayName is absent for idempotent replies', async () => {
    Users.findById.mockResolvedValueOnce({ ...alice, displayName: '' });
    Federation.findActivities.mockResolvedValue([outbound()]);
    const res = await request(app).post(`/federation/remote-dms/${threadId}/messages`)
      .set('Authorization', `Bearer ${token()}`).send({ content: 'hello', clientNonce: 'same' });
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe('alice');
    expect(Federation.insertActivity).not.toHaveBeenCalled();
  });
});
