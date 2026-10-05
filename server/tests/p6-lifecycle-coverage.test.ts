process.env.NODE_ENV = 'test';
process.env.INSTANCE_URL = 'http://localhost:3001';

import express from 'express';
import request from 'supertest';

const mockAlice = { _id: 'user-001', username: 'alice', displayName: 'Alice' };
const mockBob = { _id: 'user-002', username: 'bob', displayName: 'Bob' };

const mockFederation = {
  findActivities: jest.fn(),
  insertActivity: jest.fn(),
};
const mockUsers = {
  findByUsername: jest.fn(),
};
const mockFanOut = jest.fn();
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() };

jest.mock('../db/repositories', () => ({ Federation: mockFederation, Users: mockUsers }));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const typed = req as express.Request & { user?: { id: string } };
    typed.user = { id: req.get('x-user-id') || 'user-001' };
    next();
  },
  castAuthed: (req: express.Request) => req as express.Request & { user: { id: string } },
}));
jest.mock('../routes/federation/helpers', () => ({ fanOutActivityToFollowers: mockFanOut }));
jest.mock('../lib/logger', () => ({ __esModule: true, default: mockLogger }));

import lifecycleRouter from '../routes/federation/lifecycle';

const app = express();
app.use(express.json());
app.use('/federation', lifecycleRouter);

const NOTE_ID = 'http://localhost:3001/api/federation/users/alice/notes/note-1';

function createRow(content = 'original') {
  return {
    _id: 'row-create',
    actorUserId: mockAlice._id,
    type: 'Create',
    noteId: NOTE_ID,
    publishedAt: 100,
    createdAt: 100,
    activity: {
      type: 'Create',
      object: {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: NOTE_ID,
        type: 'Note',
        attributedTo: 'http://localhost:3001/api/federation/users/alice',
        content,
        published: '2026-10-05T08:00:00.000Z',
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        cc: ['http://localhost:3001/api/federation/users/alice/followers'],
        summary: 'old summary',
      },
    },
  };
}

function deleteRow(withPublished = true) {
  return {
    _id: 'row-delete',
    actorUserId: mockAlice._id,
    type: 'Delete',
    noteId: NOTE_ID,
    publishedAt: withPublished ? 300 : 'not-a-number',
    createdAt: withPublished ? 300 : '300',
    activity: {
      type: 'Delete',
      ...(withPublished ? { published: '2026-10-05T08:10:00.000Z' } : {}),
      object: NOTE_ID,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.INSTANCE_URL = 'http://localhost:3001';
  delete process.env.PORT;
  mockUsers.findByUsername.mockImplementation(async (username: string) => {
    if (username === 'alice') return mockAlice;
    if (username === 'bob') return mockBob;
    return null;
  });
  mockFederation.findActivities.mockResolvedValue([createRow()]);
  mockFederation.insertActivity.mockResolvedValue({ ok: true });
  mockFanOut.mockResolvedValue({ followers: 1, failed: 0 });
});

describe('P6 lifecycle router branch coverage', () => {
  it('returns 404 for an unknown local actor on GET and PATCH', async () => {
    const getRes = await request(app).get('/federation/users/charlie/notes/note-1');
    expect(getRes.status).toBe(404);

    const patchRes = await request(app)
      .patch('/federation/users/charlie/notes/note-1')
      .send({ content: 'x' });
    expect(patchRes.status).toBe(404);
  });

  it('returns 404 when no durable note state exists', async () => {
    mockFederation.findActivities.mockResolvedValue([]);
    const getRes = await request(app).get('/federation/users/alice/notes/note-1');
    expect(getRes.status).toBe(404);

    const patchRes = await request(app)
      .patch('/federation/users/alice/notes/note-1')
      .send({ content: 'x' });
    expect(patchRes.status).toBe(404);

    const deleteRes = await request(app).delete('/federation/users/alice/notes/note-1');
    expect(deleteRes.status).toBe(404);
  });

  it('materializes cursor-like activity results and rejects a non-array cursor result', async () => {
    mockFederation.findActivities.mockReturnValueOnce({
      toArray: async () => [createRow('cursor-backed')],
    });
    const ok = await request(app).get('/federation/users/alice/notes/note-1');
    expect(ok.status).toBe(200);
    expect(ok.body.content).toBe('cursor-backed');

    mockFederation.findActivities.mockReturnValueOnce({
      toArray: async () => ({ not: 'an array' }),
    });
    const missing = await request(app).get('/federation/users/alice/notes/note-1');
    expect(missing.status).toBe(404);
  });

  it('walks legacy history when the newest activity has no usable Note object', async () => {
    mockFederation.findActivities.mockResolvedValue([
      createRow('legacy body'),
      {
        _id: 'row-malformed-update',
        actorUserId: mockAlice._id,
        type: 'Update',
        noteId: NOTE_ID,
        publishedAt: '200',
        createdAt: 200,
        activity: { type: 'Update', object: 'not-an-object' },
      },
    ]);
    const res = await request(app).get('/federation/users/alice/notes/note-1');
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('legacy body');
  });

  it('uses createdAt when a tombstone has no usable published timestamp', async () => {
    mockFederation.findActivities.mockResolvedValue([createRow(), deleteRow(false)]);
    const res = await request(app).get('/federation/users/alice/notes/note-1');
    expect(res.status).toBe(410);
    expect(res.body.deleted).toBe(new Date(300).toISOString());
  });

  it('rejects mutation on behalf of another local user', async () => {
    const res = await request(app)
      .patch('/federation/users/alice/notes/note-1')
      .set('x-user-id', mockBob._id)
      .send({ content: 'nope' });
    expect(res.status).toBe(403);
  });

  it('covers all PATCH content and metadata validation branches', async () => {
    const nonString = await request(app)
      .patch('/federation/users/alice/notes/note-1')
      .send({ content: 7 });
    expect(nonString.status).toBe(400);

    const whitespace = await request(app)
      .patch('/federation/users/alice/notes/note-1')
      .send({ content: '   ' });
    expect(whitespace.status).toBe(400);

    const tooLong = await request(app)
      .patch('/federation/users/alice/notes/note-1')
      .send({ content: 'x'.repeat(5001) });
    expect(tooLong.status).toBe(400);

    const badSensitive = await request(app)
      .patch('/federation/users/alice/notes/note-1')
      .send({ content: 'ok', sensitive: 'yes' });
    expect(badSensitive.status).toBe(400);

    const badSummary = await request(app)
      .patch('/federation/users/alice/notes/note-1')
      .send({ content: 'ok', summary: 123 });
    expect(badSummary.status).toBe(400);
  });

  it('removes summary for both null and empty string updates', async () => {
    const nullSummary = await request(app)
      .patch('/federation/users/alice/notes/note-1')
      .send({ content: 'null summary', summary: null });
    expect(nullSummary.status).toBe(200);
    const firstStored = mockFederation.insertActivity.mock.calls[0]?.[0];
    expect(firstStored.activity.object.summary).toBeUndefined();

    jest.clearAllMocks();
    mockUsers.findByUsername.mockResolvedValue(mockAlice);
    mockFederation.findActivities.mockResolvedValue([createRow()]);
    mockFederation.insertActivity.mockResolvedValue({ ok: true });
    mockFanOut.mockResolvedValue({ followers: 1, failed: 0 });

    const emptySummary = await request(app)
      .patch('/federation/users/alice/notes/note-1')
      .send({ content: 'empty summary', summary: '' });
    expect(emptySummary.status).toBe(200);
    const secondStored = mockFederation.insertActivity.mock.calls[0]?.[0];
    expect(secondStored.activity.object.summary).toBeUndefined();
  });

  it('falls back to empty audiences and preserves the journal when Update fanout throws', async () => {
    const row = createRow();
    row.activity.object.to = 'not-an-array';
    row.activity.object.cc = null as unknown as string[];
    mockFederation.findActivities.mockResolvedValue([row]);
    mockFanOut.mockRejectedValueOnce(new Error('fanout down'));

    const res = await request(app)
      .patch('/federation/users/alice/notes/note-1')
      .send({ content: 'edited' });

    expect(res.status).toBe(200);
    expect(res.body.delivery).toEqual({ followers: 0, failed: 1 });
    const stored = mockFederation.insertActivity.mock.calls[0]?.[0];
    expect(stored.activity.to).toEqual([]);
    expect(stored.activity.cc).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('keeps Delete durable when follower enumeration throws', async () => {
    mockFanOut.mockRejectedValueOnce(new Error('fanout down'));
    const res = await request(app).delete('/federation/users/alice/notes/note-1');
    expect(res.status).toBe(204);
    expect(mockFederation.insertActivity).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('uses the localhost/PORT fallback when INSTANCE_URL is absent', async () => {
    delete process.env.INSTANCE_URL;
    process.env.PORT = '3999';
    const fallbackId = 'http://localhost:3999/api/federation/users/alice/notes/note-1';
    mockFederation.findActivities.mockResolvedValue([{
      ...createRow('fallback'),
      noteId: fallbackId,
      activity: {
        type: 'Create',
        object: {
          ...createRow('fallback').activity.object,
          id: fallbackId,
          attributedTo: 'http://localhost:3999/api/federation/users/alice',
        },
      },
    }]);

    const res = await request(app).get('/federation/users/alice/notes/note-1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(fallbackId);
  });
});
