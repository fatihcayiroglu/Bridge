import type { RequestBody } from './helpers/httpDoubles';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'ap-branch-secretxxxxxxxxxxxxxxxx';
process.env.INSTANCE_URL = 'https://bridge.test';

const users = { findByUsername: jest.fn() };
const federation = {
  insertActivity: jest.fn(), updateActivity: jest.fn(),
  claimInboundActivity: jest.fn(), completeInboundActivity: jest.fn(), failInboundActivity: jest.fn(),
  findApFollows: jest.fn(), findApOutgoingFollows: jest.fn(),
  apActivitiesFind: jest.fn(), countActivities: jest.fn(),
};
const verify = jest.fn();
const acl = jest.fn();
const helpers = {
  handleApFollow: jest.fn(), handleApUnfollow: jest.fn(), handleApAccept: jest.fn(),
  handleApReject: jest.fn(), handleApCreate: jest.fn(), handleApDelete: jest.fn(),
  handleApUpdate: jest.fn(), handleApLike: jest.fn(), handleApAnnounce: jest.fn(),
  deliverApActivity: jest.fn(), deliverToFollowers: jest.fn(), fanOutActivityToFollowers: jest.fn(),
};
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.mock('../db/repositories', () => ({ Users: users, Federation: federation }));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (
    req: { headers: { authorization?: string }; user?: unknown },
    res: { status: (c: number) => { json: (b: unknown) => unknown } },
    next: () => void,
  ) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    try {
      req.user = require('jsonwebtoken').verify(h.slice(7), 'ap-branch-secretxxxxxxxxxxxxxxxx');
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
  },
  castAuthed: (req: Request) => req,
}));
jest.mock('../lib/httpSignature', () => ({ verifyHttpSignature: (...args: unknown[]) => verify(...args) }));
jest.mock('../routes/admin', () => ({ checkFederationACL: (...args: unknown[]) => acl(...args) }));
jest.mock('../routes/federation/helpers', () => helpers);
jest.mock('../lib/logger', () => ({ __esModule: true, default: logger }));
jest.mock('../middleware/federationRateLimit', () => ({
  federationGlobalRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  federationInboxRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../middleware/rateLimit', () => ({ limits: { api: () => (_req: unknown, _res: unknown, next: () => void) => next() } }));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import router from '../routes/federation/activitypub';

const app = express();
app.use(express.json());
app.use('/api/federation', router);
app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(500).json({ error: err.message }));

const user = { _id:'u1', username:'alice', displayName:'Alice' };
const inbox = (body: RequestBody, signature='sig') => request(app).post('/api/federation/users/alice/inbox').set('signature', signature).send(body);

beforeEach(() => {
  jest.clearAllMocks();
  users.findByUsername.mockResolvedValue(user);
  federation.insertActivity.mockResolvedValue({});
  federation.updateActivity.mockResolvedValue({});
  federation.claimInboundActivity.mockResolvedValue({ status: 'claimed', id: 'journal-claim' });
  federation.completeInboundActivity.mockResolvedValue(undefined);
  federation.failInboundActivity.mockResolvedValue(undefined);
  federation.findApFollows.mockResolvedValue([]);
  federation.findApOutgoingFollows.mockResolvedValue([]);
  federation.apActivitiesFind.mockResolvedValue([]);
  federation.countActivities.mockResolvedValue(0);
  verify.mockImplementation(async (req) => {
    const actor = typeof req.body?.actor === 'string' ? req.body.actor : req.body?.actor?.id;
    return { ok: true, keyId: actor ? `${actor}#main-key` : undefined, signerActor: actor };
  });
  acl.mockResolvedValue({ allowed:true });
  helpers.deliverToFollowers.mockResolvedValue(undefined);
  helpers.fanOutActivityToFollowers.mockResolvedValue({ followers: 0, failed: 0 });
  helpers.deliverApActivity.mockResolvedValue(undefined);
});

describe('ActivityPub inbox security branches', () => {
  it('fails closed on invalid production HTTP signature before persistence', async () => {
    verify.mockResolvedValueOnce({ ok:false, reason:'bad signature' });
    const res = await inbox({ type:'Follow', actor:'https://remote.test/users/a' });
    expect(res.status).toBe(401);
    expect(federation.insertActivity).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('blocks a denied actor domain before persistence', async () => {
    acl.mockResolvedValueOnce({ allowed:false, reason:'blocked' });
    const res = await inbox({ type:'Follow', actor:'https://evil.example/users/a' });
    expect(res.status).toBe(403);
    expect(acl).toHaveBeenCalledWith('evil.example');
    expect(federation.insertActivity).not.toHaveBeenCalled();
  });

  it('signed activity with malformed actor is rejected before ACL/persistence', async () => {
    const res = await inbox({ type:'Create', actor:'not a url', object:{ type:'Note' } });
    expect(res.status).toBe(401);
    expect(acl).not.toHaveBeenCalled();
    expect(federation.insertActivity).not.toHaveBeenCalled();
    expect(helpers.handleApCreate).not.toHaveBeenCalled();
  });

  it('valid signature for actor A cannot spoof actor B in the ActivityPub body', async () => {
    verify.mockResolvedValueOnce({
      ok: true,
      keyId: 'https://remote.test/users/signer#main-key',
      signerActor: 'https://remote.test/users/signer',
    });
    const res = await inbox({ type:'Create', actor:'https://remote.test/users/victim', object:{ type:'Note' } });
    expect(res.status).toBe(401);
    expect(federation.insertActivity).not.toHaveBeenCalled();
    expect(helpers.handleApCreate).not.toHaveBeenCalled();
  });

  it('rejects activity without a type', async () => {
    const res = await inbox({ actor:'https://remote.test/users/a' });
    expect(res.status).toBe(400);
    expect(federation.insertActivity).not.toHaveBeenCalled();
  });

  it.each([
    ['Follow', { type:'Follow', actor:'https://remote.test/u' }, 'handleApFollow'],
    ['Create', { type:'Create', actor:'https://remote.test/u', object:{type:'Note', id:'x'} }, 'handleApCreate'],
    ['Undo Follow', { type:'Undo', actor:'https://remote.test/u', object:{type:'Follow'} }, 'handleApUnfollow'],
    ['Accept object', { type:'Accept', actor:'https://remote.test/u', object:{type:'Follow'} }, 'handleApAccept'],
    ['Accept string', { type:'Accept', actor:'https://remote.test/u', object:'https://bridge.test/follow/1' }, 'handleApAccept'],
    ['Reject object', { type:'Reject', actor:'https://remote.test/u', object:{type:'Follow'} }, 'handleApReject'],
    ['Reject string', { type:'Reject', actor:'https://remote.test/u', object:'https://bridge.test/follow/1' }, 'handleApReject'],
    ['Delete', { type:'Delete', actor:'https://remote.test/u', object:'x' }, 'handleApDelete'],
    ['Update', { type:'Update', actor:'https://remote.test/u', object:{id:'x', type:'Note'} }, 'handleApUpdate'],
    ['Like', { type:'Like', actor:'https://remote.test/u', object:'x' }, 'handleApLike'],
    ['Announce', { type:'Announce', actor:'https://remote.test/u', object:'x' }, 'handleApAnnounce'],
  ] as Array<[string, RequestBody, keyof typeof helpers]>)('dispatches %s only after persistence', async (_label, body, method) => {
    const res = await inbox(body);
    expect(res.status).toBe(202);
    expect(federation.insertActivity).toHaveBeenCalledTimes(1);
    expect(helpers[method]).toHaveBeenCalledTimes(1);
    expect(federation.updateActivity).toHaveBeenCalledWith(expect.any(Object), {
      $set: { processed: true, processedAt: expect.any(Number) },
    });
  });

  it.each(['Follow', 'Like', 'Announce'])('dispatches Undo %s to the canonical undo handler', async (objectType) => {
    const res = await inbox({ type:'Undo', actor:'https://remote.test/u', object:{ type: objectType, object:'x' } });
    expect(res.status).toBe(202);
    expect(helpers.handleApUnfollow).toHaveBeenCalledTimes(1);
    expect(federation.updateActivity).toHaveBeenCalledWith(expect.any(Object), {
      $set: { processed: true, processedAt: expect.any(Number) },
    });
  });

  it('activity.id retry already processed is acknowledged without repeating side effects', async () => {
    federation.claimInboundActivity.mockResolvedValueOnce({ status: 'processed', id: 'existing-journal' });
    const res = await inbox({
      id:'https://remote.test/activities/retry-1', type:'Create', actor:'https://remote.test/u',
      object:{ type:'Note', id:'https://remote.test/notes/1' },
    });
    expect(res.status).toBe(202);
    expect(res.body.duplicate).toBe(true);
    expect(helpers.handleApCreate).not.toHaveBeenCalled();
    expect(federation.completeInboundActivity).not.toHaveBeenCalled();
  });

  it('concurrent activity.id claim returns retryable 503 rather than double-dispatch', async () => {
    federation.claimInboundActivity.mockResolvedValueOnce({ status: 'busy', id: 'existing-journal' });
    const res = await inbox({
      id:'https://remote.test/activities/busy-1', type:'Like', actor:'https://remote.test/u', object:'x',
    });
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(helpers.handleApLike).not.toHaveBeenCalled();
  });

  it('claimed handler failure releases the retry lease and remains a failure', async () => {
    helpers.handleApLike.mockRejectedValueOnce(new Error('like store down'));
    const res = await inbox({
      id:'https://remote.test/activities/fail-1', type:'Like', actor:'https://remote.test/u', object:'x',
    });
    expect(res.status).toBe(500);
    expect(federation.failInboundActivity).toHaveBeenCalledWith(
      'journal-claim', expect.any(String), 'like store down',
    );
    expect(federation.completeInboundActivity).not.toHaveBeenCalled();
  });

  it('does not dispatch Undo/Accept/Reject for unrelated object types', async () => {
    for (const type of ['Undo','Accept','Reject']) {
      const res = await inbox({ type, actor:'https://remote.test/u', object:{type:'Note'} });
      expect(res.status).toBe(202);
    }
    expect(helpers.handleApUnfollow).not.toHaveBeenCalled();
    expect(helpers.handleApAccept).not.toHaveBeenCalled();
    expect(helpers.handleApReject).not.toHaveBeenCalled();
  });
});

describe('ActivityPub C2S failure isolation', () => {
  it('returns 500 if durable activity persistence fails and does not deliver', async () => {
    federation.insertActivity.mockRejectedValueOnce(new Error('db down'));
    const token = jwt.sign({ id:'u1' }, 'ap-branch-secretxxxxxxxxxxxxxxxx', { expiresIn:'1h' });
    const res = await request(app).post('/api/federation/users/alice/outbox')
      .set('Authorization', `Bearer ${token}`).send({ content:'hello', visibility:'public' });
    expect(res.status).toBe(500);
    expect(helpers.fanOutActivityToFollowers).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it.each([
    ['public', ['https://www.w3.org/ns/activitystreams#Public'], 'public'],
    ['unlisted', ['https://bridge.test/api/federation/users/alice/followers'], 'unlisted'],
    ['followers', ['https://bridge.test/api/federation/users/alice/followers'], 'followers'],
  ])('persists and fans out exactly one canonical %s activity', async (visibility, expectedTo, _label) => {
    const token = jwt.sign({ id:'u1' }, 'ap-branch-secretxxxxxxxxxxxxxxxx', { expiresIn:'1h' });
    const res = await request(app).post('/api/federation/users/alice/outbox')
      .set('Authorization', `Bearer ${token}`).send({ content:'hello', visibility });
    expect(res.status).toBe(201);
    expect(federation.insertActivity).toHaveBeenCalledTimes(1);
    const persisted = federation.insertActivity.mock.calls[0][0];
    expect(persisted.activity.id).toBe(res.body.id);
    expect(persisted.activity.object.id).toBe(res.body.noteId);
    expect(persisted.activity.to).toEqual(expectedTo);
    expect(helpers.fanOutActivityToFollowers).toHaveBeenCalledTimes(1);
    expect(helpers.fanOutActivityToFollowers.mock.calls[0][1]).toBe(persisted.activity);
    expect(helpers.deliverToFollowers).not.toHaveBeenCalled();
  });
});
