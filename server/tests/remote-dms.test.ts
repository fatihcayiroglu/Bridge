'use strict';
process.env.NODE_ENV = 'test';
process.env.INSTANCE_URL = 'https://bridge.test';

import express from 'express';
import request from 'supertest';

const Federation = {
  apMessagesFind: jest.fn(),
  countApMessages: jest.fn(),
  insertActivity: jest.fn(),
};
const Users = {
  findById: jest.fn(),
  saveApKeys: jest.fn(),
};
const deliverApActivity = jest.fn();
const resolveFollowTarget = jest.fn();

jest.mock('../db/repositories', () => ({ Federation, Users }));
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
  deliverApActivity: (...args: unknown[]) => deliverApActivity(...args),
  resolveFollowTarget: (...args: unknown[]) => resolveFollowTarget(...args),
}));

const remoteDmsModule = require('../routes/federation/remote-dms');
const router = remoteDmsModule.default || remoteDmsModule;
const app = express();
app.use(express.json());
app.use('/api/federation', router);

function pagedRows(rows: unknown[]) {
  const chain: any = {
    sort: jest.fn(() => chain),
    skip: jest.fn(() => chain),
    limit: jest.fn(() => Promise.resolve(rows)),
  };
  return chain;
}

beforeEach(() => {
  jest.clearAllMocks();
  Federation.apMessagesFind.mockImplementation(() => pagedRows([]));
  Federation.countApMessages.mockResolvedValue(0);
  Federation.insertActivity.mockResolvedValue(undefined);
  Users.findById.mockResolvedValue({ _id: 'u1', username: 'alice', apPublicKey: 'PUBLIC' });
  Users.saveApKeys.mockResolvedValue(undefined);
  resolveFollowTarget.mockResolvedValue({ ok: true });
  deliverApActivity.mockResolvedValue(undefined);
});

describe('GET /api/federation/remote-dms', () => {
  it('queries only live direct rows owned by the authenticated recipient', async () => {
    Federation.apMessagesFind.mockImplementation(() => pagedRows([{
      _id: 'm1', apId: 'https://remote.test/notes/1', actorUrl: 'https://remote.test/users/bob',
      targetUserId: 'u1', visibility: 'direct', content: 'hello', published: 123, deletedAt: null,
    }]));
    Federation.countApMessages.mockResolvedValue(1);

    const res = await request(app)
      .get('/api/federation/remote-dms?limit=20&page=1')
      .set('x-test-user', 'u1');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ content: 'hello', actorUrl: 'https://remote.test/users/bob' });
    expect(Federation.apMessagesFind).toHaveBeenCalledWith({
      targetUserId: 'u1', visibility: 'direct', deletedAt: null,
    });
    expect(Federation.countApMessages).toHaveBeenCalledWith({
      targetUserId: 'u1', visibility: 'direct', deletedAt: null,
    });
  });

  it('never lets a caller select another recipient id from query parameters', async () => {
    await request(app)
      .get('/api/federation/remote-dms?targetUserId=victim')
      .set('x-test-user', 'attacker');

    expect(Federation.apMessagesFind).toHaveBeenCalledWith({
      targetUserId: 'attacker', visibility: 'direct', deletedAt: null,
    });
  });

  it('rejects invalid pagination instead of widening the query', async () => {
    const res = await request(app)
      .get('/api/federation/remote-dms?page=0&limit=999999999')
      .set('x-test-user', 'u1');
    expect(res.status).toBe(400);
    expect(Federation.apMessagesFind).not.toHaveBeenCalled();
  });
});

describe('POST /api/federation/remote-dms', () => {
  it('refuses blocked/unresolvable actors before any activity or queue write', async () => {
    resolveFollowTarget.mockResolvedValue({ ok: false, status: 403, error: 'blocked' });

    const res = await request(app)
      .post('/api/federation/remote-dms')
      .set('x-test-user', 'u1')
      .send({ actorUrl: 'https://blocked.test/users/bob', content: 'hello' });

    expect(res.status).toBe(403);
    expect(Federation.insertActivity).not.toHaveBeenCalled();
    expect(deliverApActivity).not.toHaveBeenCalled();
  });

  it('persists the exact direct Create before handing it to durable delivery', async () => {
    const res = await request(app)
      .post('/api/federation/remote-dms')
      .set('x-test-user', 'u1')
      .send({ actorUrl: 'https://remote.test/users/bob', content: 'private hello' });

    expect(res.status).toBe(202);
    expect(Federation.insertActivity).toHaveBeenCalledTimes(1);
    const stored = Federation.insertActivity.mock.calls[0][0];
    expect(stored).toEqual(expect.objectContaining({ actorUserId: 'u1', type: 'Create' }));
    expect(stored.activity).toEqual(expect.objectContaining({
      type: 'Create',
      actor: 'https://bridge.test/api/federation/users/alice',
      to: ['https://remote.test/users/bob'],
      cc: [],
      object: expect.objectContaining({
        type: 'Note', content: 'private hello', to: ['https://remote.test/users/bob'], cc: [],
      }),
    }));
    expect(deliverApActivity).toHaveBeenCalledWith(
      'https://remote.test/users/bob',
      stored.activity,
      expect.objectContaining({ _id: 'u1', username: 'alice' }),
    );
  });

  it('validates target and content before touching federation state', async () => {
    for (const body of [
      { actorUrl: 'file:///etc/passwd', content: 'x' },
      { actorUrl: 'https://remote.test/users/bob', content: '   ' },
      { actorUrl: 'https://remote.test/users/bob', content: 'x'.repeat(5001) },
    ]) {
      const res = await request(app).post('/api/federation/remote-dms').set('x-test-user', 'u1').send(body);
      expect(res.status).toBe(400);
    }
    expect(resolveFollowTarget).not.toHaveBeenCalled();
    expect(Federation.insertActivity).not.toHaveBeenCalled();
    expect(deliverApActivity).not.toHaveBeenCalled();
  });
});
