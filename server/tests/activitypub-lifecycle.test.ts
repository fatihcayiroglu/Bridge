process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secretxxxxxxxxxxxxxxxxxxxxx';
process.env.INSTANCE_URL = 'http://localhost:3001';

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const alice = { _id: 'user-001', username: 'alice', displayName: 'Alice', tokenVersion: 0 };
const bob = { _id: 'user-002', username: 'bob', displayName: 'Bob', tokenVersion: 0 };
const fullNoteId = 'http://localhost:3001/api/federation/users/alice/notes/note-1';

const federation = {
  findActivities: jest.fn(),
  insertActivity: jest.fn().mockResolvedValue({ ok: true }),
};

jest.mock('../db/repositories', () => ({
  Users: {
    findByUsername: jest.fn(async (username: string) => username === 'alice' ? alice : username === 'bob' ? bob : null),
    findById: jest.fn(async (id: string) => id === alice._id ? alice : id === bob._id ? bob : null),
  },
  Federation: federation,
}));

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() };
jest.mock('../lib/logger', () => ({ __esModule: true, default: logger, createLogger: () => logger }));

const fanOut = jest.fn().mockResolvedValue({ followers: 2, failed: 0 });
jest.mock('../routes/federation/helpers', () => ({
  fanOutActivityToFollowers: fanOut,
}));

import lifecycleRouter from '../routes/federation/lifecycle';

const app = express();
app.use(express.json());
app.use('/federation', lifecycleRouter);

function token(userId: string) {
  return jwt.sign({ id: userId, username: userId, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

function createRow(content = 'original') {
  return {
    _id: 'row-create',
    actorUserId: alice._id,
    type: 'Create',
    noteId: fullNoteId,
    publishedAt: 100,
    createdAt: 100,
    activity: {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: 'http://localhost:3001/api/federation/users/alice/activities/create-1',
      type: 'Create',
      actor: 'http://localhost:3001/api/federation/users/alice',
      object: {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: fullNoteId,
        type: 'Note',
        attributedTo: 'http://localhost:3001/api/federation/users/alice',
        content,
        published: '2026-10-05T08:00:00.000Z',
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        cc: ['http://localhost:3001/api/federation/users/alice/followers'],
      },
    },
  };
}

function updateRow(content = 'edited') {
  return {
    _id: 'row-update',
    actorUserId: alice._id,
    type: 'Update',
    noteId: fullNoteId,
    publishedAt: 200,
    createdAt: 200,
    activity: {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: 'http://localhost:3001/api/federation/users/alice/activities/update-1',
      type: 'Update',
      actor: 'http://localhost:3001/api/federation/users/alice',
      object: {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: fullNoteId,
        type: 'Note',
        attributedTo: 'http://localhost:3001/api/federation/users/alice',
        content,
        published: '2026-10-05T08:00:00.000Z',
        updated: '2026-10-05T08:05:00.000Z',
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        cc: ['http://localhost:3001/api/federation/users/alice/followers'],
      },
    },
  };
}

function deleteRow() {
  return {
    _id: 'row-delete',
    actorUserId: alice._id,
    type: 'Delete',
    noteId: fullNoteId,
    publishedAt: 300,
    createdAt: 300,
    activity: {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: 'http://localhost:3001/api/federation/users/alice/activities/delete-1',
      type: 'Delete',
      actor: 'http://localhost:3001/api/federation/users/alice',
      published: '2026-10-05T08:10:00.000Z',
      object: fullNoteId,
    },
  };
}

describe('P6 outbound ActivityPub Note lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    federation.insertActivity.mockResolvedValue({ ok: true });
    fanOut.mockResolvedValue({ followers: 2, failed: 0 });
  });

  it('PATCH persists and fans out an Update for the same Note id', async () => {
    federation.findActivities.mockResolvedValue([createRow()]);

    const res = await request(app)
      .patch('/federation/users/alice/notes/note-1')
      .set('Authorization', `Bearer ${token(alice._id)}`)
      .send({ content: 'edited content', sensitive: true, summary: 'cw' });

    expect(res.status).toBe(200);
    expect(res.body.noteId).toBe(fullNoteId);
    expect(federation.insertActivity).toHaveBeenCalledTimes(1);
    const stored = federation.insertActivity.mock.calls[0][0];
    expect(stored.type).toBe('Update');
    expect(stored.noteId).toBe(fullNoteId);
    expect(stored.activity.type).toBe('Update');
    expect(stored.activity.object.id).toBe(fullNoteId);
    expect(stored.activity.object.content).toBe('edited content');
    expect(stored.activity.object.sensitive).toBe(true);
    expect(stored.activity.object.summary).toBe('cw');
    expect(fanOut).toHaveBeenCalledWith(expect.objectContaining({ _id: alice._id }), stored.activity);
  });

  it('PATCH refuses mutation on behalf of another local user', async () => {
    federation.findActivities.mockResolvedValue([createRow()]);
    const res = await request(app)
      .patch('/federation/users/alice/notes/note-1')
      .set('Authorization', `Bearer ${token(bob._id)}`)
      .send({ content: 'nope' });
    expect(res.status).toBe(403);
    expect(federation.insertActivity).not.toHaveBeenCalled();
  });

  it('GET serves the newest Update object rather than the original Create object', async () => {
    federation.findActivities.mockResolvedValue([createRow(), updateRow('newest')]);
    const res = await request(app).get('/federation/users/alice/notes/note-1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(fullNoteId);
    expect(res.body.content).toBe('newest');
  });

  it('DELETE persists and fans out Delete without erasing lifecycle history', async () => {
    federation.findActivities.mockResolvedValue([createRow(), updateRow()]);
    const res = await request(app)
      .delete('/federation/users/alice/notes/note-1')
      .set('Authorization', `Bearer ${token(alice._id)}`);

    expect(res.status).toBe(204);
    expect(federation.insertActivity).toHaveBeenCalledTimes(1);
    const stored = federation.insertActivity.mock.calls[0][0];
    expect(stored.type).toBe('Delete');
    expect(stored.noteId).toBe(fullNoteId);
    expect(stored.activity.type).toBe('Delete');
    expect(stored.activity.object).toBe(fullNoteId);
    expect(fanOut).toHaveBeenCalledWith(expect.objectContaining({ _id: alice._id }), stored.activity);
  });

  it('GET returns a 410 Tombstone after Delete', async () => {
    federation.findActivities.mockResolvedValue([createRow(), updateRow(), deleteRow()]);
    const res = await request(app).get('/federation/users/alice/notes/note-1');
    expect(res.status).toBe(410);
    expect(res.body).toEqual(expect.objectContaining({
      id: fullNoteId,
      type: 'Tombstone',
      formerType: 'Note',
    }));
  });

  it('DELETE is idempotent after the durable Delete already exists', async () => {
    federation.findActivities.mockResolvedValue([createRow(), deleteRow()]);
    const res = await request(app)
      .delete('/federation/users/alice/notes/note-1')
      .set('Authorization', `Bearer ${token(alice._id)}`);
    expect(res.status).toBe(204);
    expect(federation.insertActivity).not.toHaveBeenCalled();
    expect(fanOut).not.toHaveBeenCalled();
  });

  it('PATCH refuses resurrection after Delete', async () => {
    federation.findActivities.mockResolvedValue([createRow(), deleteRow()]);
    const res = await request(app)
      .patch('/federation/users/alice/notes/note-1')
      .set('Authorization', `Bearer ${token(alice._id)}`)
      .send({ content: 'resurrect' });
    expect(res.status).toBe(410);
    expect(federation.insertActivity).not.toHaveBeenCalled();
  });
});
