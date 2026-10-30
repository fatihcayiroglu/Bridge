/** Actual poll HTTP routes, bearer middleware, repositories, PostgreSQL and Redis.
 * JWTs are issued to disposable seeded users with the production issuer. This
 * is route/lifecycle integration, not password/PKCE/browser authentication. */
import '../helpers/realRedisFixture';
import { randomUUID } from 'crypto';
import express from 'express';
import request from 'supertest';
if (!process.env.PG_TEST_URL || !process.env.REDIS_TEST_URL) throw new Error('Explicit disposable PG and Redis URLs required');
const db = require('../../db/loader').default as typeof import('../../db/postgres').default;
const { Polls } = require('../../db/repositories') as typeof import('../../db/repositories');
const { makeToken } = require('../../middleware/auth') as typeof import('../../middleware/auth');
const policy = require('../../lib/messageContentPolicy') as typeof import('../../lib/messageContentPolicy');
const router = require('../../routes/polls');
const q = (sql: string, params: unknown[] = []) => db._pool.query(sql, params);
const events: string[] = [];
const app = express(); app.use(express.json());
app.set('io', { to: () => ({ emit: (event: string) => events.push(event) }) });
app.use('/api/channels', router); app.use('/api/polls', router);
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: 'Fixture request failed' });
});
interface Fixture { user: string; server: string; channel: string; poll: string; token: string }
const fixtures: Fixture[] = [];
async function seed(): Promise<Fixture> {
  const user = randomUUID(), server = randomUUID(), channel = randomUUID();
  const f: Fixture = { user, server, channel, poll: '', token: '' }; fixtures.push(f);
  await q('INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$2,$2,$3,$4)',
    [user, `poll-${user}`, 'fixture-password-not-used-for-login', Date.now()]);
  await q('INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$2,$3,$4)', [server, 'Poll fixture', user, Date.now()]);
  await q('INSERT INTO members ("userId","serverId",roles,"joinedAt") VALUES ($1,$2,$3::jsonb,$4)', [user, server, '[]', Date.now()]);
  await q('INSERT INTO channels (_id,"serverId",name,"createdAt") VALUES ($1,$2,$3,$4)', [channel, server, 'Poll fixture', Date.now()]);
  const poll = await Polls.insert({ channelId: channel, serverId: server, createdBy: user,
    question: 'Original question', options: [{ id: '0', text: 'One', votes: [] }, { id: '1', text: 'Two', votes: [] }],
    multiSelect: false, allowVoteChange: true, closed: false, expiresAt: null });
  f.poll = poll._id; f.token = makeToken({ _id: user, username: `poll-${user}`, tokenVersion: 0 });
  return f;
}
const expire = (f: Fixture) => q('UPDATE channels SET "expiresAt"=1,"expiryVersion"=1 WHERE _id=$1', [f.channel]);
const rows = (f: Fixture) => q('SELECT * FROM polls WHERE "channelId"=$1 ORDER BY _id', [f.channel]);
type Call = ['get' | 'post' | 'patch', string, Record<string, unknown>];
const calls = (f: Fixture): Call[] => [
  ['post', `/api/channels/${f.channel}/polls`, { question: 'New question', options: ['One', 'Two'] }],
  ['post', `/api/polls/${f.poll}/vote`, { optionIds: ['0'] }],
  ['patch', `/api/polls/${f.poll}`, { question: 'Changed question' }],
  ['post', `/api/polls/${f.poll}/close`, {}],
  ['get', `/api/channels/${f.channel}/polls`, {}], ['get', `/api/polls/${f.poll}`, {}],
];
const send = (f: Fixture, [method, path, body]: Call) => request(app)[method](path).set('Authorization', `Bearer ${f.token}`).send(body);
beforeEach(() => { events.length = 0; });
afterEach(async () => {
  jest.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    await q('DELETE FROM polls WHERE "channelId"=$1', [f.channel]);
    await q('DELETE FROM channel_expiry_tombstones WHERE "channelId"=$1', [f.channel]);
    await q('DELETE FROM channels WHERE _id=$1', [f.channel]);
    await q('DELETE FROM members WHERE "serverId"=$1', [f.server]);
    await q('DELETE FROM servers WHERE _id=$1', [f.server]);
    await q('DELETE FROM users WHERE _id=$1', [f.user]);
  }
});
afterAll(async () => { await db._pool.end(); });

it.each(['permanent', 'active'])('live %s parent permits real poll writes, atomic vote/edit and reads', async state => {
  const f = await seed();
  if (state === 'active') await q('UPDATE channels SET "expiresAt"=FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT+120000,"expiryVersion"=1 WHERE _id=$1', [f.channel]);
  for (const call of calls(f)) expect((await send(f, call)).status).toBe(200);
  const saved = (await rows(f)).rows;
  expect(saved).toHaveLength(2);
  const edited = saved.find(row => row._id === f.poll)!;
  expect(edited.question).toBe('Changed question'); expect(edited.closed).toBe(true);
  expect(edited.options[0].votes).toEqual([f.user]);
  expect(events).toEqual(['poll:created', 'poll:updated', 'poll:updated', 'poll:updated']);
});

it.each(['expired', 'tombstoned'])('%s parent refuses all six surfaces without changing persisted polls', async state => {
  const f = await seed();
  if (state === 'expired') await expire(f);
  else await q('INSERT INTO channel_expiry_tombstones ("channelId","serverId","expiredAt","expiryVersion","recordedAt") VALUES ($1,$2,1,1,2)', [f.channel, f.server]);
  const before = (await rows(f)).rows;
  for (const call of calls(f)) {
    const response = await send(f, call);
    expect(response.status).toBe(404); expect(response.body).toEqual({ error: 'Channel not found' });
  }
  expect((await rows(f)).rows).toEqual(before); expect(events).toEqual([]);
});

it('valid other-account credentials cannot read or vote in the fixture tenant', async () => {
  const a = await seed(), b = await seed();
  for (const call of [calls(a)[1]!, calls(a)[5]!]) expect((await send({ ...a, token: b.token }, call)).status).toBe(403);
  expect((await rows(a)).rows[0].options[0].votes).toEqual([]); expect(events).toEqual([]);
});

it('revoked access credentials fail genuine bearer middleware before voting', async () => {
  const f = await seed();
  await q('UPDATE users SET "tokenVersion"=1 WHERE _id=$1', [f.user]);
  expect((await send(f, calls(f)[1]!)).status).toBe(401);
  expect((await rows(f)).rows[0].options[0].votes).toEqual([]); expect(events).toEqual([]);
});

it('expiry during real content enforcement refuses creation before its insert', async () => {
  const f = await seed(); const original = policy.checkMessageContent;
  jest.spyOn(policy, 'checkMessageContent').mockImplementationOnce(async (...args) => {
    const result = await original(...args); expect(result).toBeNull(); await expire(f); return result;
  });
  expect((await send(f, calls(f)[0]!)).status).toBe(404);
  expect((await rows(f)).rows).toHaveLength(1); expect(events).toEqual([]);
});

it('expiry while real poll results are fetched prevents a stale list response', async () => {
  const f = await seed(); const original = Polls.findByChannel.bind(Polls);
  jest.spyOn(Polls, 'findByChannel').mockImplementationOnce(async id => {
    const result = await original(id); await expire(f); return result;
  });
  const response = await send(f, calls(f)[4]!);
  expect(response.status).toBe(404); expect(response.body).toEqual({ error: 'Channel not found' });
});

it('expiry after real atomic vote commit suppresses HTTP success and invalidation, without pretending rollback', async () => {
  const f = await seed(); const original = Polls.mutateVoteAtomic.bind(Polls);
  jest.spyOn(Polls, 'mutateVoteAtomic').mockImplementationOnce(async (...args) => {
    const result = await original(...args); expect(result?.status).toBe('ok'); await expire(f); return result;
  });
  const response = await send(f, calls(f)[1]!);
  expect(response.status).toBe(404); expect(response.body).toEqual({ error: 'Channel not found' });
  expect((await rows(f)).rows[0].options[0].votes).toEqual([f.user]); expect(events).toEqual([]);
});

it('expired-parent vote withdrawal removes the real vote but never returns the stale question', async () => {
  const f = await seed();
  expect((await send(f, calls(f)[1]!)).status).toBe(200);
  expect((await rows(f)).rows[0].options[0].votes).toEqual([f.user]);
  await expire(f); events.length = 0;
  const response = await request(app).delete(`/api/polls/${f.poll}/vote`).set('Authorization', `Bearer ${f.token}`);
  expect(response.status).toBe(404); expect(response.body).toEqual({ error: 'Channel not found' });
  expect((await rows(f)).rows[0].options[0].votes).toEqual([]); expect(events).toEqual([]);
});
