process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV = 'test';

import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { MockDb } from './helpers/mockDb';
import { createMockDb, makeChannel, makeServer, makeUser } from './helpers/mockDb';

let db: MockDb;
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/index', () => {
  db = require('./helpers/mockDb').createMockDb();
  return db;
});
jest.mock('../middleware/rateLimit', () => ({
  limits: { polls: () => (_q: unknown, _s: unknown, next: () => void) => next() },
}));
jest.mock('../lib/messageContentPolicy', () => ({
  checkMessageContent: jest.fn(async () => null),
  checkEditedContent: jest.fn(async () => null),
}));

import pollsRouter from '../routes/polls';
import { Polls } from '../db/repositories';
import { checkMessageContent, checkEditedContent } from '../lib/messageContentPolicy';

const user = makeUser();
const server = makeServer(user._id);
const channel = makeChannel(server._id);
const poll = {
  _id: 'expiry-poll', channelId: channel._id, serverId: server._id, createdBy: user._id,
  question: 'Original question', options: [{ id: '0', text: 'One', votes: [] }, { id: '1', text: 'Two', votes: [] }],
  multiSelect: false, allowVoteChange: true, closed: false, expiresAt: null, createdAt: 1,
};
const token = jwt.sign({ id: user._id, username: user.username, v: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
let app: express.Express;
let emit: jest.Mock;

beforeEach(async () => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  db = createMockDb();
  const module = require('../db/index');
  Object.assign(module, db); delete module._pool;
  await db.users.insert(user); await db.servers.insert(server); await db.channels.insert(channel);
  await db.members.insert({ userId: user._id, serverId: server._id, joinedAt: Date.now() });
  await db.polls.insert(structuredClone(poll));
  emit = jest.fn();
  app = express(); app.use(express.json()); app.set('io', { to: () => ({ emit }) });
  app.use('/api/channels', pollsRouter); app.use('/api/polls', pollsRouter);
  app.use((err: Error, _q: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
});

function call(method: 'get' | 'post' | 'patch', route: string, body: Record<string, unknown> = {}) {
  return request(app)[method](route).set('Authorization', `Bearer ${token}`).send(body);
}
const cases: Array<['get' | 'post' | 'patch', string, Record<string, unknown>]> = [
  ['post', `/api/channels/${channel._id}/polls`, { question: 'New question', options: ['One', 'Two'] }],
  ['post', '/api/polls/expiry-poll/vote', { optionIds: ['0'] }],
  ['patch', '/api/polls/expiry-poll', { question: 'Changed question' }],
  ['post', '/api/polls/expiry-poll/close', {}],
  ['get', `/api/channels/${channel._id}/polls`, {}],
  ['get', '/api/polls/expiry-poll', {}],
];

test.each(cases)('expired parent denies %s %s without writes, content or invalidation', async (method, route, body) => {
  await db.channels.update({ _id: channel._id }, { $set: { expiresAt: Date.now() - 1, expiryVersion: 1 } });
  const response = await call(method, route, body);
  expect(response.status).toBe(404);
  expect(response.body).toEqual({ error: 'Channel not found' });
  expect(await db.polls.find({ channelId: channel._id })).toEqual([poll]);
  expect(emit).not.toHaveBeenCalled();
});

test('a live channel still permits create, vote, edit, close and reads', async () => {
  for (const [method, route, body] of cases) expect((await call(method, route, body)).status).toBe(200);
  expect(emit).toHaveBeenCalledTimes(4);
});

test('stale permanent DTO cannot override PostgreSQL tombstone or database-clock expiry', async () => {
  for (const row of [
    { _id: channel._id, serverId: server._id, expiresAt: null, expiryVersion: 0, hasTombstone: true, nowMs: Date.now() },
    { _id: channel._id, serverId: server._id, expiresAt: Date.now() - 1, expiryVersion: 1, hasTombstone: false, nowMs: Date.now() },
  ]) {
    const query = jest.fn(async () => ({ rows: [row] }));
    require('../db/index')._pool = { query };
    expect((await call('post', '/api/polls/expiry-poll/vote', { optionIds: ['0'] })).status).toBe(404);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('clock_timestamp()'), [channel._id, server._id]);
  }
  expect(await db.polls.findOne({ _id: poll._id })).toEqual(poll);
  expect(emit).not.toHaveBeenCalled();
});

test('an unverifiable authoritative channel returns 503 without mutation', async () => {
  require('../db/index')._pool = { query: async () => { throw new Error('unavailable'); } };
  const response = await call('post', '/api/polls/expiry-poll/vote', { optionIds: ['0'] });
  expect(response.status).toBe(503);
  expect(response.body).toEqual({ error: 'Channel availability could not be verified' });
  expect(await db.polls.findOne({ _id: poll._id })).toEqual(poll);
  expect(emit).not.toHaveBeenCalled();
});

test.each(['create', 'edit'] as const)('expiry during %s content enforcement refuses the final write', async mode => {
  const expire = async () => {
    await db.channels.update({ _id: channel._id }, { $set: { expiresAt: Date.now() - 1, expiryVersion: 1 } });
    return null;
  };
  if (mode === 'create') jest.mocked(checkMessageContent).mockImplementationOnce(expire);
  else jest.mocked(checkEditedContent).mockImplementationOnce(expire);
  const response = mode === 'create' ? await call(...cases[0]!) : await call(...cases[2]!);
  expect(response.status).toBe(404);
  expect(await db.polls.find({ channelId: channel._id })).toEqual([poll]);
  expect(emit).not.toHaveBeenCalled();
});

test.each(['vote', 'edit'] as const)('expiry after an atomic %s success suppresses publication and content', async mode => {
  const finish = async () => {
    await db.channels.update({ _id: channel._id }, { $set: { expiresAt: Date.now() - 1, expiryVersion: 1 } });
    return { status: 'ok' as const, poll };
  };
  if (mode === 'vote') jest.spyOn(Polls, 'mutateVoteAtomic').mockImplementationOnce(finish);
  else jest.spyOn(Polls, 'updateEditableAtomic').mockImplementationOnce(finish);
  const response = mode === 'vote' ? await call(...cases[1]!) : await call(...cases[2]!);
  expect(response.status).toBe(404);
  expect(response.body).toEqual({ error: 'Channel not found' });
  expect(emit).not.toHaveBeenCalled();
});

test('expiry while list results are fetched suppresses the returned question', async () => {
  jest.spyOn(Polls, 'findByChannel').mockImplementationOnce(async () => {
    await db.channels.update({ _id: channel._id }, { $set: { expiresAt: Date.now() - 1, expiryVersion: 1 } });
    return [poll];
  });
  const response = await call(...cases[4]!);
  expect(response.status).toBe(404);
  expect(response.body).toEqual({ error: 'Channel not found' });
});

test('authorized poll deletion remains available on an expired parent', async () => {
  await db.channels.update({ _id: channel._id }, { $set: { expiresAt: Date.now() - 1, expiryVersion: 1 } });
  const response = await request(app).delete('/api/polls/expiry-poll').set('Authorization', `Bearer ${token}`);
  expect(response.status).toBe(200);
  expect(await db.polls.findOne({ _id: poll._id })).toBeNull();
});

test.each([404, 503])('vote withdrawal preserves erasure but refuses stale content with %s', async status => {
  await db.polls.update({ _id: poll._id }, { $set: { options: [
    { id: '0', text: 'One', votes: [user._id] }, { id: '1', text: 'Two', votes: [] },
  ] } });
  if (status === 404) await db.channels.update({ _id: channel._id }, { $set: { expiresAt: Date.now() - 1, expiryVersion: 1 } });
  else require('../db/index')._pool = { query: async () => { throw new Error('unavailable'); } };
  const response = await request(app).delete('/api/polls/expiry-poll/vote').set('Authorization', `Bearer ${token}`);
  expect(response.status).toBe(status);
  expect(response.body).toEqual({ error: status === 404 ? 'Channel not found' : 'Channel availability could not be verified' });
  const saved = await db.polls.findOne({ _id: poll._id });
  expect(saved?.options).toEqual([
    { id: '0', text: 'One', votes: [] }, { id: '1', text: 'Two', votes: [] },
  ]);
  expect(emit).not.toHaveBeenCalled();
});
