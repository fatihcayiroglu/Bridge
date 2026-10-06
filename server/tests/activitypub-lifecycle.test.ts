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

const users = {
  findByUsername: jest.fn(async (username: string) => username === 'alice' ? alice : username === 'bob' ? bob : null),
  findById: jest.fn(async (id: string) => id === alice._id ? alice : id === bob._id ? bob : null),
};

jest.mock('../db/repositories', () => ({
  Users: users,
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
    users.findByUsername.mockImplementation(async (username: string) => username === 'alice' ? alice : username === 'bob' ? bob : null);
    users.findById.mockImplementation(async (id: string) => id === alice._id ? alice : id === bob._id ? bob : null);
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

  it('returns 404 for an unknown local actor and for a missing note state', async () => {
    federation.findActivities.mockResolvedValue([]);
    const unknown = await request(app).get('/federation/users/nobody/notes/note-1');
    expect(unknown.status).toBe(404);

    const missing = await request(app).get('/federation/users/alice/notes/note-1');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('Note not found');
  });

  it('PATCH returns 404 when the authenticated owner no longer exists', async () => {
    users.findByUsername.mockResolvedValueOnce(null);
    const res = await request(app)
      .patch('/federation/users/alice/notes/note-1')
      .set('Authorization', `Bearer ${token(alice._id)}`)
      .send({ content: 'edit' });
    expect(res.status).toBe(404);
    expect(federation.findActivities).not.toHaveBeenCalled();
  });

  it('PATCH returns 404 for a missing durable note', async () => {
    federation.findActivities.mockResolvedValue([]);
    const res = await request(app)
      .patch('/federation/users/alice/notes/note-1')
      .set('Authorization', `Bearer ${token(alice._id)}`)
      .send({ content: 'edit' });
    expect(res.status).toBe(404);
  });

  it.each([
    [{}, 'content is required and must be a string'],
    [{ content: '   ' }, 'content is required and must be a string'],
    [{ content: 'x'.repeat(5001) }, 'content exceeds maximum length of 5000 characters'],
    [{ content: 'ok', sensitive: 'yes' }, 'sensitive must be a boolean'],
    [{ content: 'ok', summary: 7 }, 'summary must be a string or null'],
  ])('PATCH validates malformed mutation input %#', async (body, message) => {
    federation.findActivities.mockResolvedValue([createRow()]);
    const res = await request(app)
      .patch('/federation/users/alice/notes/note-1')
      .set('Authorization', `Bearer ${token(alice._id)}`)
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(message);
    expect(federation.insertActivity).not.toHaveBeenCalled();
  });

  it.each([null, ''])('PATCH removes an existing summary when summary is %p', async (summary) => {
    const row = createRow();
    (row.activity.object as Record<string, unknown>).summary = 'old cw';
    federation.findActivities.mockResolvedValue([row]);
    const res = await request(app)
      .patch('/federation/users/alice/notes/note-1')
      .set('Authorization', `Bearer ${token(alice._id)}`)
      .send({ content: ' edited ', summary });
    expect(res.status).toBe(200);
    const stored = federation.insertActivity.mock.calls[0][0];
    expect(stored.activity.object.content).toBe('edited');
    expect(stored.activity.object.summary).toBeUndefined();
  });

  it('keeps optional fields untouched when PATCH omits them and tolerates fanout enumeration failure', async () => {
    const row = createRow();
    (row.activity.object as Record<string, unknown>).sensitive = true;
    (row.activity.object as Record<string, unknown>).summary = 'existing';
    federation.findActivities.mockResolvedValue([row]);
    fanOut.mockRejectedValueOnce(new Error('followers unavailable'));

    const res = await request(app)
      .patch('/federation/users/alice/notes/note-1')
      .set('Authorization', `Bearer ${token(alice._id)}`)
      .send({ content: 'edited' });

    expect(res.status).toBe(200);
    const stored = federation.insertActivity.mock.calls[0][0];
    expect(stored.activity.object.sensitive).toBe(true);
    expect(stored.activity.object.summary).toBe('existing');
    expect(res.body.delivery).toEqual({ followers: 0, failed: 1 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'federation.outbox.update_fanout_failed' }),
      expect.any(String),
    );
  });

  it('uses a legacy older Note object when the newest durable activity has no usable Note object', async () => {
    federation.findActivities.mockResolvedValue([
      createRow('legacy body'),
      { type: 'Announce', publishedAt: 500, activity: { type: 'Announce', object: fullNoteId } },
    ]);
    const res = await request(app).get('/federation/users/alice/notes/note-1');
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('legacy body');
  });

  it('accepts cursor-like activity results and falls back from publishedAt to createdAt ordering', async () => {
    federation.findActivities.mockReturnValue({
      toArray: async () => [
        { ...createRow('older'), publishedAt: 'not-a-number', createdAt: 10 },
        { ...updateRow('newer'), publishedAt: 'not-a-number', createdAt: 20 },
      ],
    });
    const res = await request(app).get('/federation/users/alice/notes/note-1');
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('newer');
  });

  it('treats a cursor returning a non-array as an empty note history', async () => {
    federation.findActivities.mockReturnValue({ toArray: async () => ({ nope: true }) });
    const res = await request(app).get('/federation/users/alice/notes/note-1');
    expect(res.status).toBe(404);
  });

  it('builds a Tombstone deletion time from the durable row clock when published is absent', async () => {
    const row = deleteRow();
    delete (row.activity as Record<string, unknown>).published;
    row.publishedAt = Number.NaN;
    row.createdAt = 1700000000000;
    federation.findActivities.mockResolvedValue([row]);
    const res = await request(app).get('/federation/users/alice/notes/note-1');
    expect(res.status).toBe(410);
    expect(res.body.deleted).toBe(new Date(1700000000000).toISOString());
  });

  it('DELETE returns 404 for an unknown actor and for a missing note', async () => {
    users.findByUsername.mockResolvedValueOnce(null);
    const unknown = await request(app)
      .delete('/federation/users/alice/notes/note-1')
      .set('Authorization', `Bearer ${token(alice._id)}`);
    expect(unknown.status).toBe(404);

    federation.findActivities.mockResolvedValue([]);
    const missing = await request(app)
      .delete('/federation/users/alice/notes/note-1')
      .set('Authorization', `Bearer ${token(alice._id)}`);
    expect(missing.status).toBe(404);
  });

  it('DELETE persists successfully even if follower enumeration throws', async () => {
    federation.findActivities.mockResolvedValue([createRow()]);
    fanOut.mockRejectedValueOnce(new Error('followers unavailable'));
    const res = await request(app)
      .delete('/federation/users/alice/notes/note-1')
      .set('Authorization', `Bearer ${token(alice._id)}`);
    expect(res.status).toBe(204);
    expect(federation.insertActivity).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'federation.outbox.delete_fanout_failed' }),
      expect.any(String),
    );
  });
});
