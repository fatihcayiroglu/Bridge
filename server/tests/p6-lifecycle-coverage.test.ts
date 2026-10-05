process.env.NODE_ENV = 'test';
process.env.INSTANCE_URL = 'http://localhost:3001';

import express from 'express';
import request from 'supertest';

const mockAlice = { _id: 'user-001', username: 'alice', displayName: 'Alice' };
const mockBob = { _id: 'user-002', username: 'bob', displayName: 'Bob' };
const mockFederation = { findActivities: jest.fn(), insertActivity: jest.fn() };
const mockUsers = { findByUsername: jest.fn() };
const mockFanOut = jest.fn();
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() };

jest.mock('../db/repositories', () => ({ Federation: mockFederation, Users: mockUsers }));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { user?: { id: string } }).user = { id: req.get('x-user-id') || mockAlice._id };
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

function noteObject(content = 'original'): Record<string, unknown> {
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: NOTE_ID,
    type: 'Note',
    attributedTo: 'http://localhost:3001/api/federation/users/alice',
    content,
    published: '2026-10-05T08:00:00.000Z',
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    cc: ['http://localhost:3001/api/federation/users/alice/followers'],
    summary: 'old summary',
  };
}

function createRow(content = 'original'): Record<string, unknown> {
  return {
    _id: 'row-create', actorUserId: mockAlice._id, type: 'Create', noteId: NOTE_ID,
    publishedAt: 100, createdAt: 100,
    activity: { type: 'Create', object: noteObject(content) },
  };
}

function deleteRow(withPublished = true): Record<string, unknown> {
  return {
    _id: 'row-delete', actorUserId: mockAlice._id, type: 'Delete', noteId: NOTE_ID,
    publishedAt: withPublished ? 300 : 'bad', createdAt: withPublished ? 300 : '300',
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

describe('P6 lifecycle router edge coverage', () => {
  it('covers unknown actor and missing-state 404s', async () => {
    expect((await request(app).get('/federation/users/charlie/notes/note-1')).status).toBe(404);
    expect((await request(app).patch('/federation/users/charlie/notes/note-1').send({ content: 'x' })).status).toBe(404);

    mockFederation.findActivities.mockResolvedValue([]);
    expect((await request(app).get('/federation/users/alice/notes/note-1')).status).toBe(404);
    expect((await request(app).patch('/federation/users/alice/notes/note-1').send({ content: 'x' })).status).toBe(404);
    expect((await request(app).delete('/federation/users/alice/notes/note-1')).status).toBe(404);
  });

  it('materializes cursor results and rejects a cursor that does not yield an array', async () => {
    mockFederation.findActivities.mockReturnValueOnce({ toArray: async () => [createRow('cursor')] });
    const ok = await request(app).get('/federation/users/alice/notes/note-1');
    expect(ok.status).toBe(200);
    expect(ok.body.content).toBe('cursor');

    mockFederation.findActivities.mockReturnValueOnce({ toArray: async () => ({ nope: true }) });
    expect((await request(app).get('/federation/users/alice/notes/note-1')).status).toBe(404);
  });

  it('walks older durable history when the latest activity has no Note object', async () => {
    mockFederation.findActivities.mockResolvedValue([
      createRow('legacy body'),
      {
        _id: 'bad-update', actorUserId: mockAlice._id, type: 'Update', noteId: NOTE_ID,
        publishedAt: '200', createdAt: 200,
        activity: { type: 'Update', object: 'not-an-object' },
      },
    ]);
    const res = await request(app).get('/federation/users/alice/notes/note-1');
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('legacy body');
  });

  it('uses createdAt for a Tombstone when published fields are unusable', async () => {
    mockFederation.findActivities.mockResolvedValue([createRow(), deleteRow(false)]);
    const res = await request(app).get('/federation/users/alice/notes/note-1');
    expect(res.status).toBe(410);
    expect(res.body.deleted).toBe(new Date(300).toISOString());
  });

  it('covers owner enforcement plus content and metadata validation branches', async () => {
    expect((await request(app)
      .patch('/federation/users/alice/notes/note-1')
      .set('x-user-id', mockBob._id)
      .send({ content: 'x' })).status).toBe(403);

    expect((await request(app).patch('/federation/users/alice/notes/note-1').send({ content: 7 })).status).toBe(400);
    expect((await request(app).patch('/federation/users/alice/notes/note-1').send({ content: '   ' })).status).toBe(400);
    expect((await request(app).patch('/federation/users/alice/notes/note-1').send({ content: 'x'.repeat(5001) })).status).toBe(400);
    expect((await request(app).patch('/federation/users/alice/notes/note-1').send({ content: 'ok', sensitive: 'yes' })).status).toBe(400);
    expect((await request(app).patch('/federation/users/alice/notes/note-1').send({ content: 'ok', summary: 123 })).status).toBe(400);
  });

  it('covers both summary-removal branches', async () => {
    const nullSummary = await request(app)
      .patch('/federation/users/alice/notes/note-1')
      .send({ content: 'first', summary: null });
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
      .send({ content: 'second', summary: '' });
    expect(emptySummary.status).toBe(200);
    const secondStored = mockFederation.insertActivity.mock.calls[0]?.[0];
    expect(secondStored.activity.object.summary).toBeUndefined();
  });

  it('uses empty audiences and reports a persisted Update when fanout fails', async () => {
    const row = createRow();
    const activity = row.activity as Record<string, unknown>;
    const object = activity.object as Record<string, unknown>;
    object.to = 'not-an-array';
    object.cc = null;
    mockFederation.findActivities.mockResolvedValue([row]);
    mockFanOut.mockRejectedValueOnce(new Error('fanout down'));

    const res = await request(app).patch('/federation/users/alice/notes/note-1').send({ content: 'edited' });
    expect(res.status).toBe(200);
    expect(res.body.delivery).toEqual({ followers: 0, failed: 1 });
    const stored = mockFederation.insertActivity.mock.calls[0]?.[0];
    expect(stored.activity.to).toEqual([]);
    expect(stored.activity.cc).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('keeps Delete durable when fanout enumeration fails', async () => {
    mockFanOut.mockRejectedValueOnce(new Error('fanout down'));
    const res = await request(app).delete('/federation/users/alice/notes/note-1');
    expect(res.status).toBe(204);
    expect(mockFederation.insertActivity).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('covers INSTANCE_URL and PORT fallback construction', async () => {
    delete process.env.INSTANCE_URL;
    process.env.PORT = '3999';
    const fallbackId = 'http://localhost:3999/api/federation/users/alice/notes/note-1';
    const fallbackObject = noteObject('fallback');
    fallbackObject.id = fallbackId;
    fallbackObject.attributedTo = 'http://localhost:3999/api/federation/users/alice';
    mockFederation.findActivities.mockResolvedValue([{
      ...createRow('fallback'), noteId: fallbackId, activity: { type: 'Create', object: fallbackObject },
    }]);

    const res = await request(app).get('/federation/users/alice/notes/note-1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(fallbackId);
  });
});
