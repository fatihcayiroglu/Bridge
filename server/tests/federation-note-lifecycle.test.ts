'use strict';
process.env.NODE_ENV = 'test';
process.env.INSTANCE_URL = 'https://bridge.test';

import express from 'express';
import request from 'supertest';

const Users = { findByUsername: jest.fn() };
const Federation = {
  apActivitiesFind: jest.fn(),
  updateActivity: jest.fn(),
  insertActivity: jest.fn(),
};
const fanOutActivityToFollowers = jest.fn();

jest.mock('../db/repositories', () => ({ Users, Federation }));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: () => void) => {
    req.user = { id: req.headers['x-test-user'] || 'u1' };
    next();
  },
  castAuthed: (req: any) => ({ user: req.user }),
}));
jest.mock('../middleware/rateLimit', () => ({
  limits: { federation: () => (_req: any, _res: any, next: () => void) => next() },
}));
jest.mock('../routes/federation/delivery', () => ({
  fanOutActivityToFollowers: (...args: unknown[]) => fanOutActivityToFollowers(...args),
}));

const routeModule = require('../routes/federation/note-lifecycle');
const router = routeModule.default || routeModule;
const app = express();
app.use(express.json());
app.use('/api/federation', router);

const ACTOR = 'https://bridge.test/api/federation/users/alice';
const NOTE = `${ACTOR}/notes/n1`;

function createRow(object: Record<string, unknown>) {
  return {
    _id: 'create-row-1',
    actorUserId: 'u1',
    type: 'Create',
    activity: {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${ACTOR}/activities/c1`,
      type: 'Create',
      actor: ACTOR,
      object,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  Users.findByUsername.mockResolvedValue({ _id: 'u1', username: 'alice' });
  Federation.apActivitiesFind.mockReturnValue([createRow({
    id: NOTE,
    type: 'Note',
    attributedTo: ACTOR,
    content: 'old',
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    cc: [`${ACTOR}/followers`],
  })]);
  Federation.updateActivity.mockResolvedValue(undefined);
  Federation.insertActivity.mockResolvedValue(undefined);
  fanOutActivityToFollowers.mockResolvedValue({ followers: 2, failed: 0 });
});

describe('PATCH federated note', () => {
  it('is owner-only', async () => {
    const res = await request(app)
      .patch('/api/federation/users/alice/notes/n1')
      .set('x-test-user', 'attacker')
      .send({ content: 'hijack' });
    expect(res.status).toBe(403);
    expect(Federation.updateActivity).not.toHaveBeenCalled();
    expect(fanOutActivityToFollowers).not.toHaveBeenCalled();
  });

  it('rewrites the stored Create object and fans out the exact new Note in Update', async () => {
    const res = await request(app)
      .patch('/api/federation/users/alice/notes/n1')
      .set('x-test-user', 'u1')
      .send({ content: 'edited text' });

    expect(res.status).toBe(200);
    expect(Federation.updateActivity).toHaveBeenCalledTimes(1);
    const rewrite = Federation.updateActivity.mock.calls[0][1].$set.activity;
    expect(rewrite.object).toEqual(expect.objectContaining({
      id: NOTE,
      type: 'Note',
      attributedTo: ACTOR,
      content: 'edited text',
      updated: expect.any(String),
    }));

    expect(Federation.insertActivity).toHaveBeenCalledWith(expect.objectContaining({ type: 'Update', noteId: NOTE }));
    const update = Federation.insertActivity.mock.calls[0][0].activity;
    expect(update).toEqual(expect.objectContaining({
      type: 'Update',
      actor: ACTOR,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      cc: [`${ACTOR}/followers`],
      object: rewrite.object,
    }));
    expect(fanOutActivityToFollowers).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'u1', username: 'alice' }),
      update,
    );
  });

  it('refuses to edit a tombstone', async () => {
    Federation.apActivitiesFind.mockReturnValue([createRow({
      id: NOTE, type: 'Tombstone', formerType: 'Note', deleted: '2026-10-04T12:00:00Z',
    })]);
    const res = await request(app)
      .patch('/api/federation/users/alice/notes/n1')
      .set('x-test-user', 'u1')
      .send({ content: 'resurrect' });
    expect(res.status).toBe(410);
    expect(Federation.updateActivity).not.toHaveBeenCalled();
  });
});

describe('DELETE federated note', () => {
  it('scrubs the stored Create to a Tombstone before sending Delete', async () => {
    const res = await request(app)
      .delete('/api/federation/users/alice/notes/n1')
      .set('x-test-user', 'u1');

    expect(res.status).toBe(200);
    const rewrite = Federation.updateActivity.mock.calls[0][1].$set.activity;
    expect(rewrite.object).toEqual(expect.objectContaining({
      id: NOTE,
      type: 'Tombstone',
      formerType: 'Note',
      deleted: expect.any(String),
    }));
    expect(rewrite.object.content).toBeUndefined();

    const persistedDelete = Federation.insertActivity.mock.calls[0][0];
    expect(persistedDelete).toEqual(expect.objectContaining({ type: 'Delete', noteId: NOTE }));
    expect(persistedDelete.activity).toEqual(expect.objectContaining({
      type: 'Delete', actor: ACTOR, object: rewrite.object,
    }));
    expect(fanOutActivityToFollowers).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'u1' }), persistedDelete.activity,
    );
  });

  it('is idempotent once the canonical object is already a Tombstone', async () => {
    Federation.apActivitiesFind.mockReturnValue([createRow({
      id: NOTE, type: 'Tombstone', formerType: 'Note', deleted: '2026-10-04T12:00:00Z',
    })]);
    const res = await request(app)
      .delete('/api/federation/users/alice/notes/n1')
      .set('x-test-user', 'u1');
    expect(res.status).toBe(204);
    expect(Federation.updateActivity).not.toHaveBeenCalled();
    expect(Federation.insertActivity).not.toHaveBeenCalled();
    expect(fanOutActivityToFollowers).not.toHaveBeenCalled();
  });
});
