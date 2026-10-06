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

const fanOut = jest.fn().mockResolvedValue({ followers: 1, failed: 0 });
jest.mock('../routes/federation/helpers', () => ({ fanOutActivityToFollowers: fanOut }));

import lifecycleRouter from '../routes/federation/lifecycle';

const app = express();
app.use(express.json());
app.use('/federation', lifecycleRouter);

function token(userId: string) {
  return jwt.sign({ id: userId, username: userId, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

function createRow(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'row-create', actorUserId: alice._id, type: 'Create', noteId: fullNoteId,
    publishedAt: 100, createdAt: 100,
    activity: {
      type: 'Create',
      object: {
        '@context': 'https://www.w3.org/ns/activitystreams', id: fullNoteId, type: 'Note',
        attributedTo: 'http://localhost:3001/api/federation/users/alice', content: 'original',
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        cc: ['http://localhost:3001/api/federation/users/alice/followers'],
        summary: 'old cw', sensitive: false,
      },
    },
    ...overrides,
  };
}

function deleteRow(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'row-delete', actorUserId: alice._id, type: 'Delete', noteId: fullNoteId,
    publishedAt: 300, createdAt: 300,
    activity: { type: 'Delete', object: fullNoteId },
    ...overrides,
  };
}

describe('P6 outbound lifecycle coverage edges', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    federation.findActivities.mockResolvedValue([]);
    federation.insertActivity.mockResolvedValue({ ok: true });
    fanOut.mockResolvedValue({ followers: 1, failed: 0 });
  });

  it('returns 404 for an unknown local actor and for a missing note', async () => {
    expect((await request(app).get('/federation/users/nobody/notes/note-1')).status).toBe(404);
    federation.findActivities.mockResolvedValue([]);
    expect((await request(app).get('/federation/users/alice/notes/note-1')).status).toBe(404);
  });

  it('materializes cursor-like activity results and falls back to an older usable Note object', async () => {
    const legacyLatest = { type: 'Update', publishedAt: 500, activity: { type: 'Update', object: { type: 'Question', id: fullNoteId } } };
    const cursor = { toArray: jest.fn(async () => [legacyLatest, createRow()]) };
    federation.findActivities.mockReturnValue(cursor);
    const res = await request(app).get('/federation/users/alice/notes/note-1');
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('original');
    expect(cursor.toArray).toHaveBeenCalled();
  });

  it('returns 404 when durable rows contain no usable Note object', async () => {
    federation.findActivities.mockResolvedValue([{ type: 'Update', publishedAt: 'bad', createdAt: 'bad', activity: { type: 'Update', object: null } }]);
    const res = await request(app).get('/federation/users/alice/notes/note-1');
    expect(res.status).toBe(404);
  });

  it('uses row time for Tombstone deleted when Delete has no published string', async () => {
    federation.findActivities.mockResolvedValue([createRow(), deleteRow({ activity: { type: 'Delete', object: fullNoteId }, publishedAt: undefined, createdAt: 1234 })]);
    const res = await request(app).get('/federation/users/alice/notes/note-1');
    expect(res.status).toBe(410);
    expect(res.body.deleted).toBe(new Date(1234).toISOString());
  });

  it.each([
    [{}, 400],
    [{ content: '   ' }, 400],
    [{ content: 'x'.repeat(5001) }, 400],
    [{ content: 'ok', sensitive: 'yes' }, 400],
    [{ content: 'ok', summary: 42 }, 400],
  ])('rejects invalid PATCH bodies %#', async (body, status) => {
    federation.findActivities.mockResolvedValue([createRow()]);
    const res = await request(app)
      .patch('/federation/users/alice/notes/note-1')
      .set('Authorization', `Bearer ${token(alice._id)}`)
      .send(body);
    expect(res.status).toBe(status);
    expect(federation.insertActivity).not.toHaveBeenCalled();
  });

  it('returns 404 for PATCH when note history is absent and 403 for another owner', async () => {
    federation.findActivities.mockResolvedValue([]);
    const missing = await request(app).patch('/federation/users/alice/notes/note-1')
      .set('Authorization', `Bearer ${token(alice._id)}`).send({ content: 'x' });
    expect(missing.status).toBe(404);

    const forbidden = await request(app).patch('/federation/users/alice/notes/note-1')
      .set('Authorization', `Bearer ${token(bob._id)}`).send({ content: 'x' });
    expect(forbidden.status).toBe(403);
  });

  it('clears summary, preserves default audience fallbacks, and reports fanout failure without losing Update', async () => {
    federation.findActivities.mockResolvedValue([createRow({ activity: { type: 'Create', object: { id: fullNoteId, type: 'Note', content: 'old', summary: 'remove me' } } })]);
    fanOut.mockRejectedValue(new Error('boom'));
    const res = await request(app)
      .patch('/federation/users/alice/notes/note-1')
      .set('Authorization', `Bearer ${token(alice._id)}`)
      .send({ content: '  updated  ', summary: '', sensitive: false });
    expect(res.status).toBe(200);
    const stored = federation.insertActivity.mock.calls[0][0];
    expect(stored.activity.object.content).toBe('updated');
    expect(stored.activity.object.summary).toBeUndefined();
    expect(stored.activity.to).toEqual([]);
    expect(stored.activity.cc).toEqual([]);
    expect(res.body.delivery).toEqual({ followers: 0, failed: 1 });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('returns 404 for DELETE with no note, and persists Delete even if fanout throws', async () => {
    federation.findActivities.mockResolvedValue([]);
    const missing = await request(app).delete('/federation/users/alice/notes/note-1')
      .set('Authorization', `Bearer ${token(alice._id)}`);
    expect(missing.status).toBe(404);

    federation.findActivities.mockResolvedValue([createRow()]);
    fanOut.mockRejectedValue(new Error('boom'));
    const deleted = await request(app).delete('/federation/users/alice/notes/note-1')
      .set('Authorization', `Bearer ${token(alice._id)}`);
    expect(deleted.status).toBe(204);
    expect(federation.insertActivity).toHaveBeenCalledWith(expect.objectContaining({ type: 'Delete', noteId: fullNoteId }));
    expect(logger.warn).toHaveBeenCalled();
  });
});
