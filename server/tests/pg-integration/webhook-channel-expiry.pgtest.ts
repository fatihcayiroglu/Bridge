/** Actual incoming bearer-webhook HTTP route, PostgreSQL and Redis.
 * Socket recipients are observed; no full app/socket/browser acceptance claimed. */
import { randomUUID } from 'crypto';
import express from 'express';
import request from 'supertest';
if (!process.env.PG_TEST_URL) throw new Error('PG_TEST_URL is required');
process.env.REDIS_URL = process.env.REDIS_TEST_URL || process.env.REDIS_URL;
if (!process.env.REDIS_URL) throw new Error('REDIS_TEST_URL or REDIS_URL is required');
const db = require('../../db/loader').default as typeof import('../../db/postgres').default;
const { Channels, Messages } = require('../../db/repositories') as typeof import('../../db/repositories');
const adapter = require('../../lib/redisAdapter') as typeof import('../../lib/redisAdapter');
const policy = require('../../lib/messageContentPolicy') as typeof import('../../lib/messageContentPolicy');
const authority = require('../../lib/channelWriteGuard') as typeof import('../../lib/channelWriteGuard');
const router = require('../../routes/bots');
const q = (sql: string, values: unknown[] = []) => db._pool.query(sql, values);
const events: string[] = [];
const app = express();
app.set('io', { to: () => ({ emit: (event: string) => events.push(event) }) });
app.use(express.json());
app.use('/api/webhooks', router);

interface Fixture { user: string; server: string; channel: string; webhook: string; token: string }
const fixtures: Fixture[] = [];
async function seed(): Promise<Fixture> {
  const f = { user: randomUUID(), server: randomUUID(), channel: randomUUID(), webhook: randomUUID(), token: randomUUID() };
  fixtures.push(f);
  await q('INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$2,$3,$4,$5)',
    [f.user, `webhook-${f.user}`, 'Webhook fixture', 'not-an-authentication-fixture', Date.now()]);
  await q('INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$2,$3,$4)',
    [f.server, 'Webhook expiry fixture', f.user, Date.now()]);
  await q('INSERT INTO channels (_id,"serverId",name,"createdAt") VALUES ($1,$2,$3,$4)',
    [f.channel, f.server, 'Webhook fixture', Date.now()]);
  await q('INSERT INTO webhooks (_id,"channelId","serverId",name,token,"createdAt") VALUES ($1,$2,$3,$4,$5,$6)',
    [f.webhook, f.channel, f.server, 'Webhook fixture', f.token, Date.now()]);
  return f;
}
const send = (f: Fixture, token = f.token) => request(app).post(`/api/webhooks/${f.webhook}`)
  .query({ token }).send({ content: `Webhook fixture ${f.webhook}` });
const expire = (f: Fixture) => q('UPDATE channels SET "expiresAt"=1,"expiryVersion"=1 WHERE _id=$1', [f.channel]);
const rows = (f: Fixture) => q('SELECT * FROM messages WHERE "channelId"=$1', [f.channel]);
async function refused(f: Fixture, persisted = 0, status = 404) {
  const response = await send(f);
  expect(response.status).toBe(status);
  if (status === 404) expect(response.body).toEqual({ error: 'Channel unavailable' });
  expect((await rows(f)).rows).toHaveLength(persisted);
  expect(events).toEqual([]);
}
beforeAll(async () => {
  await adapter.applyAdapter({});
  expect(adapter.isRedisAvailable()).toBe(true);
  expect(await adapter.redisClient()!.ping()).toBe('PONG');
  expect((await q('SELECT current_database() AS name')).rows[0].name).toBeTruthy();
});
beforeEach(() => { events.length = 0; });
afterEach(async () => {
  jest.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    await q('DELETE FROM webhooks WHERE _id=$1', [f.webhook]);
    await q('DELETE FROM channel_expiry_tombstones WHERE "channelId"=$1', [f.channel]);
    await q('DELETE FROM messages WHERE "channelId"=$1', [f.channel]);
    await q('DELETE FROM channels WHERE _id=$1', [f.channel]);
    await q('DELETE FROM servers WHERE _id=$1', [f.server]);
    await q('DELETE FROM users WHERE _id=$1', [f.user]);
  }
});
afterAll(async () => { await adapter.disconnect(); await db._pool.end(); });

it.each(['permanent', 'active'])('valid webhook into a %s channel retains its machine identity', async state => {
  const f = await seed();
  if (state === 'active')
    await q('UPDATE channels SET "expiresAt"=FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT+120000,"expiryVersion"=1 WHERE _id=$1', [f.channel]);
  expect((await send(f)).status).toBe(200);
  expect((await rows(f)).rows).toEqual([expect.objectContaining({ serverId: f.server, userId: `webhook:${f.webhook}`, isWebhook: true })]);
  expect(events).toEqual(['message:new', 'channel:activity']);
});

it('expired SQL refuses the otherwise authorized HTTP webhook', async () => {
  const f = await seed(); await expire(f); await refused(f);
});

it('a stale permanent DTO does not override current SQL expiry', async () => {
  const f = await seed(); const stale = await Channels.findById(f.channel);
  expect(stale).toMatchObject({ expiresAt: null, expiryVersion: 0 });
  await expire(f);
  const original = Channels.findById.bind(Channels);
  jest.spyOn(Channels, 'findById').mockImplementation(id => id === f.channel ? Promise.resolve(stale) : original(id));
  await refused(f);
});

it('a durable tombstone refuses a recreated permanent receiver', async () => {
  const f = await seed();
  await q('INSERT INTO channel_expiry_tombstones ("channelId","serverId","expiredAt","expiryVersion","recordedAt") VALUES ($1,$2,1,1,2)', [f.channel, f.server]);
  await refused(f);
});

it('expiry during actual moderation prevents the message insert', async () => {
  const f = await seed(); const original = policy.machineContentRefused;
  jest.spyOn(policy, 'machineContentRefused').mockImplementationOnce(async (...args) => {
    const result = await original(...args); await expire(f); return result;
  });
  await refused(f);
});

it('expiry after the real insert suppresses success/publication and preserves the committed row', async () => {
  const f = await seed(); const original = Messages.create.bind(Messages);
  jest.spyOn(Messages, 'create').mockImplementationOnce(async data => {
    const saved = await original(data); await expire(f); return saved;
  });
  await refused(f, 1);
});

it('expiry during actual Redis invalidation suppresses success and both events', async () => {
  const f = await seed(); const original = adapter.cache.invalidatePattern.bind(adapter.cache);
  jest.spyOn(adapter.cache, 'invalidatePattern').mockImplementationOnce(async prefix => {
    await original(prefix); await expire(f);
  });
  await refused(f, 1);
});

it('expiry after the caller final query is still refused by publication authority and the HTTP response', async () => {
  const f = await seed(); const original = authority.channelWriteAvailability;
  let queries = 0;
  jest.spyOn(authority, 'channelWriteAvailability').mockImplementation(async (...args) => {
    const state = await original(...args);
    if (++queries === 3) await expire(f);
    return state;
  });
  await refused(f, 1);
  expect(queries).toBe(3);
});

it('a valid token does not grant another tenant channel authority', async () => {
  const f = await seed();
  await q('UPDATE webhooks SET "serverId"=$1 WHERE _id=$2', [randomUUID(), f.webhook]);
  await refused(f, 0, 403);
});

it('invalid credentials are still refused even when the channel is expired', async () => {
  const f = await seed(); await expire(f);
  expect((await send(f, 'invalid-credential')).status).toBe(401);
  expect((await rows(f)).rows).toHaveLength(0); expect(events).toEqual([]);
});
