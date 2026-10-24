// server/tests/thread-message-report-endpoint.test.ts
//
// POST /api/threads/:threadId/messages/:messageId/report (P7 B5, 093): the
// paths real PostgreSQL cannot reach on demand. The full behaviour is covered
// by pg-integration/thread-message-reports.pgtest.ts.
//   · Channel liveness cannot be verified: 503, and nothing is stored (fail
//     closed). The thread's own reader is the only one who can get it.
//   · Liveness is asked only after access is established. A non-member still
//     gets the plain 404 while the store is down, so a 503 never reveals that
//     the reply exists.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';

import { createMockDb, makeUser, makeServer, makeChannel } from './helpers/mockDb';

const mockDb = createMockDb();
jest.mock('../db/loader', () => mockDb);
jest.mock('../db/index', () => mockDb);
jest.mock('../middleware/rateLimit', () => {
  const pass = () => (_req: unknown, _res: unknown, next: () => void) => next();
  return { limits: new Proxy({}, { get: () => pass }), rateLimit: pass };
});

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import threadsRouter from '../routes/threads';
import { invalidatePerms } from '../lib/permCache';

const owner = makeUser();
const reporter = makeUser();
const author = makeUser();
const outsider = makeUser();
const server = makeServer(owner._id);
const channel = makeChannel(server._id);
const app = express();
app.use(express.json());
app.use('/api/threads', threadsRouter);

function file(as: { _id: string }, body: Record<string, unknown> = { reason: 'spam' }) {
  const token = jwt.sign({ id: as._id, username: 'tester', v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
  return request(app).post('/api/threads/thread-r/messages/reply-r/report').set('Authorization', `Bearer ${token}`).send(body);
}
const setPool = (pool: unknown) => { (mockDb as unknown as { _pool?: unknown })._pool = pool; };

beforeAll(async () => {
  for (const u of [owner, reporter, author, outsider]) await mockDb.users.insert(u);
  for (const u of [owner, reporter, author]) {
    await mockDb.members.insert({ userId: u._id, serverId: server._id, joinedAt: 1, roles: '[]' });
  }
  await mockDb.servers.insert(server);
  await mockDb.channels.insert(channel);
  await mockDb.threads.insert({ _id: 'thread-r', channelId: channel._id, serverId: server._id, name: 't',
    createdBy: author._id, createdAt: 1, lastMessageAt: 1, messageCount: 1 });
  await mockDb.threadMessages.insert({ _id: 'reply-r', threadId: 'thread-r', channelId: channel._id, serverId: server._id,
    userId: author._id, username: 'author', displayName: 'Author', content: 'abusive reply', type: 'normal', createdAt: 2 });
  invalidatePerms(server._id);
});
afterEach(() => setPool(undefined));

it('liveness unverifiable: 503 for the thread\'s reader, nothing stored', async () => {
  const pool = { query: jest.fn().mockRejectedValue(new Error('pg down')) };
  setPool(pool);
  const res = await file(reporter);
  expect(res.status).toBe(503);
  expect(pool.query).toHaveBeenCalled();
  setPool(undefined);
  expect(await mockDb.messageReports.find({ messageId: 'reply-r' })).toHaveLength(0);
});

it('a non-member gets the plain 404 even while liveness is unverifiable (no oracle)', async () => {
  const pool = { query: jest.fn().mockRejectedValue(new Error('pg down')) };
  setPool(pool);
  const res = await file(outsider);
  expect(res.status).toBe(404);
  expect(res.body).toEqual({ error: 'Message not available' });
  expect(pool.query).not.toHaveBeenCalled();
});

it('positive control: with the channel verifiably live the report is stored with its thread', async () => {
  const res = await file(reporter, { reason: 'harassment', detail: 'see' });
  expect(res.status).toBe(201);
  const rows = await mockDb.messageReports.find({ messageId: 'reply-r' });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ threadId: 'thread-r', channelId: channel._id, serverId: server._id,
    reporterId: reporter._id, reason: 'harassment', detail: 'see', evidenceText: 'abusive reply' });
});
