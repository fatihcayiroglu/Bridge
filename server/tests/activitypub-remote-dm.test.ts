process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secretxxxxxxxxxxxxxxxxxxxxx';
process.env.INSTANCE_URL = 'http://localhost:3001';

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const alice = { _id: 'user-001', username: 'alice', displayName: 'Alice', tokenVersion: 0 };
const mallory = { _id: 'user-002', username: 'mallory', displayName: 'Mallory', tokenVersion: 0 };
const remoteActor = 'https://remote.example/users/bob';
const threadId = Buffer.from(remoteActor).toString('base64url');

let inboundRows: Record<string, unknown>[] = [];
let outboundRows: Record<string, unknown>[] = [];
const lastMessageQuery: Record<string, unknown>[] = [];
const lastActivityQuery: Record<string, unknown>[] = [];

function chain(rows: () => Record<string, unknown>[]) {
  const api = {
    sort: jest.fn(() => api),
    limit: jest.fn(async () => rows()),
  };
  return api;
}

const Federation = {
  apMessagesFind: jest.fn((query: Record<string, unknown>) => {
    lastMessageQuery.push(query);
    return chain(() => inboundRows);
  }),
  apActivitiesFind: jest.fn((query: Record<string, unknown>) => {
    lastActivityQuery.push(query);
    return chain(() => outboundRows);
  }),
  findApMessageOne: jest.fn(),
  findActivities: jest.fn().mockResolvedValue([]),
  insertActivity: jest.fn().mockResolvedValue({ ok: true }),
};

jest.mock('../db/repositories', () => ({
  Federation,
  Users: {
    findById: jest.fn(async (id: string) => id === alice._id ? alice : id === mallory._id ? mallory : null),
  },
}));

const deliverApActivity = jest.fn().mockResolvedValue(undefined);
jest.mock('../routes/federation/helpers', () => ({
  deliverApActivity: (...args: unknown[]) => deliverApActivity(...args),
}));

import remoteDmRouter from '../routes/federation/remote-dm';

const app = express();
app.use(express.json());
app.use('/federation', remoteDmRouter);

function token(userId: string) {
  return jwt.sign({ id: userId, username: userId, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

function inbound(content = 'hello', targetUserId = alice._id) {
  return {
    _id: 'in-1', apId: 'https://remote.example/notes/1', actorUrl: remoteActor,
    targetUserId, visibility: 'direct', content, published: 1000, createdAt: 1000, deletedAt: null,
  };
}

function outgoing(content = 'reply') {
  return {
    _id: 'out-1', actorUserId: alice._id, actorUrl: remoteActor, type: 'Create',
    activityId: 'http://localhost:3001/api/federation/users/alice/activities/dm-1',
    noteId: 'http://localhost:3001/api/federation/users/alice/notes/1', publishedAt: 2000, createdAt: 2000,
    activity: {
      type: 'Create',
      object: { type: 'Note', content, to: [remoteActor], cc: [] },
    },
  };
}

describe('P6 remote ActivityPub DM API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    inboundRows = [];
    outboundRows = [];
    lastMessageQuery.length = 0;
    lastActivityQuery.length = 0;
    Federation.findActivities.mockResolvedValue([]);
    Federation.insertActivity.mockResolvedValue({ ok: true });
    deliverApActivity.mockResolvedValue(undefined);
  });

  it('lists only direct messages scoped to the authenticated recipient', async () => {
    inboundRows = [inbound('private remote hello')];
    const res = await request(app)
      .get('/federation/remote-dms')
      .set('Authorization', `Bearer ${token(alice._id)}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toEqual(expect.objectContaining({ federated: true, actorUrl: remoteActor, threadId }));
    expect(res.body[0].lastMessage.content).toBe('private remote hello');
    expect(lastMessageQuery[0]).toEqual(expect.objectContaining({
      targetUserId: alice._id, visibility: 'direct', deletedAt: null,
    }));
  });

  it('uses the authenticated user id in every history query, preventing cross-recipient reads', async () => {
    inboundRows = [inbound('alice only')];
    const res = await request(app)
      .get(`/federation/remote-dms/${threadId}/messages`)
      .set('Authorization', `Bearer ${token(mallory._id)}`);

    expect(res.status).toBe(200);
    expect(lastMessageQuery.at(-1)).toEqual(expect.objectContaining({
      targetUserId: mallory._id,
      actorUrl: remoteActor,
      visibility: 'direct',
    }));
    expect(lastActivityQuery.at(-1)).toEqual(expect.objectContaining({ actorUserId: mallory._id, actorUrl: remoteActor }));
  });

  it('merges inbound and local outbound direct Notes in chronological order', async () => {
    inboundRows = [inbound('first')];
    outboundRows = [outgoing('second')];
    const res = await request(app)
      .get(`/federation/remote-dms/${threadId}/messages`)
      .set('Authorization', `Bearer ${token(alice._id)}`);

    expect(res.status).toBe(200);
    expect(res.body.map((message: { content: string }) => message.content)).toEqual(['first', 'second']);
    expect(res.body.map((message: { direction: string }) => message.direction)).toEqual(['in', 'out']);
  });

  it('refuses an arbitrary actor URL that has no inbound direct-message thread for this user', async () => {
    Federation.findApMessageOne.mockResolvedValue(null);
    const arbitrary = Buffer.from('http://127.0.0.1:9999/private').toString('base64url');
    const res = await request(app)
      .post(`/federation/remote-dms/${arbitrary}/messages`)
      .set('Authorization', `Bearer ${token(alice._id)}`)
      .send({ content: 'probe', clientNonce: 'n-1' });

    expect(res.status).toBe(404);
    expect(Federation.insertActivity).not.toHaveBeenCalled();
    expect(deliverApActivity).not.toHaveBeenCalled();
  });

  it('persists a direct Create with a stable activity id and queues signed delivery', async () => {
    Federation.findApMessageOne.mockResolvedValue(inbound());
    const res = await request(app)
      .post(`/federation/remote-dms/${threadId}/messages`)
      .set('Authorization', `Bearer ${token(alice._id)}`)
      .send({ content: 'hello back', clientNonce: 'nonce-123' });

    expect(res.status).toBe(201);
    expect(Federation.insertActivity).toHaveBeenCalledTimes(1);
    const row = Federation.insertActivity.mock.calls[0][0];
    expect(row.actorUserId).toBe(alice._id);
    expect(row.actorUrl).toBe(remoteActor);
    expect(row.activityId).toContain('/activities/dm-nonce-123');
    expect(row.activity).toEqual(expect.objectContaining({
      type: 'Create', actor: 'http://localhost:3001/api/federation/users/alice', to: [remoteActor], cc: [],
      object: expect.objectContaining({ type: 'Note', content: 'hello back', to: [remoteActor], cc: [] }),
    }));
    expect(deliverApActivity).toHaveBeenCalledWith(remoteActor, row.activity, expect.objectContaining({ _id: alice._id }));
    expect(res.body).toEqual(expect.objectContaining({ content: 'hello back', direction: 'out', federated: true }));
  });

  it('reuses an existing local activity for the same client nonce instead of duplicating the journal', async () => {
    Federation.findApMessageOne.mockResolvedValue(inbound());
    Federation.findActivities.mockResolvedValue([outgoing('already sent')]);
    const res = await request(app)
      .post(`/federation/remote-dms/${threadId}/messages`)
      .set('Authorization', `Bearer ${token(alice._id)}`)
      .send({ content: 'already sent', clientNonce: '1' });

    expect(res.status).toBe(200);
    expect(Federation.insertActivity).not.toHaveBeenCalled();
    expect(deliverApActivity).not.toHaveBeenCalled();
  });
});
