/** Real repositories, PostgreSQL authority, Redis, content policy and send handler.
 * The socket recipient is a transport observer; this is not authenticated wire E2E.
 * Interleavings execute the real operation before changing the actual SQL row. */
import { randomUUID } from 'crypto';
import type { AuthUser } from '../../socket/handlers/messages-types';

if (!process.env.PG_TEST_URL) throw new Error('PG_TEST_URL is required');
process.env.REDIS_URL = process.env.REDIS_TEST_URL || process.env.REDIS_URL;
if (!process.env.REDIS_URL) throw new Error('REDIS_TEST_URL or REDIS_URL is required');

const db = require('../../db/loader').default as typeof import('../../db/postgres').default;
const { Bridges, Channels, Messages } = require('../../db/repositories') as typeof import('../../db/repositories');
const adapter = require('../../lib/redisAdapter') as typeof import('../../lib/redisAdapter');
const policy = require('../../lib/messageContentPolicy') as typeof import('../../lib/messageContentPolicy');
const { sendChannelMessage } = require('../../socket/handlers/messages-send') as typeof import('../../socket/handlers/messages-send');
const q = (sql: string, values: unknown[] = []) => db._pool.query(sql, values);

interface Fixture { user: string; sourceServer: string; targetServer: string; source: string; target: string; bridge: string }
const fixtures: Fixture[] = [];
const emitted: Array<{ room: string; event: string }> = [];
const io = { to: (room: string) => ({ emit: (event: string) => emitted.push({ room, event }) }) };

async function seed(): Promise<Fixture> {
  const f = { user: randomUUID(), sourceServer: randomUUID(), targetServer: randomUUID(),
    source: randomUUID(), target: randomUUID(), bridge: randomUUID() };
  fixtures.push(f);
  await q('INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$2,$3,$4,$5)',
    [f.user, `bridge-${f.user}`, 'Bridge fixture', 'not-an-authentication-fixture', Date.now()]);
  for (const server of [f.sourceServer, f.targetServer]) {
    await q('INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$2,$3,$4)',
      [server, 'Bridge expiry fixture', f.user, Date.now()]);
    await q('INSERT INTO members ("userId","serverId",roles,"joinedAt") VALUES ($1,$2,$3::jsonb,$4)',
      [f.user, server, '[]', Date.now()]);
  }
  for (const [channel, server] of [[f.source, f.sourceServer], [f.target, f.targetServer]])
    await q('INSERT INTO channels (_id,"serverId",name,"createdAt") VALUES ($1,$2,$3,$4)',
      [channel, server, 'Bridge fixture', Date.now()]);
  await Bridges.insert({ _id: f.bridge, sourceChannelId: f.source, sourceServerId: f.sourceServer,
    targetChannelId: f.target, targetServerId: f.targetServer, label: 'Fixture',
    createdBy: f.user, createdAt: Date.now(), active: true });
  return f;
}

const expire = (channel: string) => q('UPDATE channels SET "expiresAt"=1,"expiryVersion"=1 WHERE _id=$1', [channel]);
const copies = (f: Fixture) => q('SELECT * FROM messages WHERE "channelId"=$1', [f.target]);
const publications = (f: Fixture) => emitted.filter(e =>
  e.room === `channel:${f.target}` || e.room === `watch:${f.target}`);

async function send(f: Fixture) {
  const errors: string[] = [];
  const socket = {
    emit: (event: string) => errors.push(event),
    to: io.to,
  };
  const user: AuthUser = { _id: f.user, username: `bridge-${f.user}`, displayName: 'Bridge fixture' };
  await sendChannelMessage({ channelId: f.source, serverId: f.sourceServer, content: `Fixture ${f.bridge}` },
    socket as never, io as never, user, new Map());
  expect(errors).toHaveLength(0);
  expect((await q('SELECT _id FROM messages WHERE "channelId"=$1', [f.source])).rows).toHaveLength(1);
}

beforeAll(async () => {
  await adapter.applyAdapter({});
  expect(adapter.isRedisAvailable()).toBe(true);
  expect(await adapter.redisClient()!.ping()).toBe('PONG');
  expect((await q('SELECT current_database() AS name')).rows[0].name).toBeTruthy();
});
beforeEach(() => { emitted.length = 0; });
afterEach(async () => {
  jest.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    await q('DELETE FROM channel_bridges WHERE _id=$1', [f.bridge]);
    await q('DELETE FROM notifications WHERE "serverId"=ANY($1::text[])', [[f.sourceServer, f.targetServer]]);
    await q('DELETE FROM channel_expiry_tombstones WHERE "channelId"=ANY($1::text[])', [[f.source, f.target]]);
    await q('DELETE FROM messages WHERE "channelId"=ANY($1::text[])', [[f.source, f.target]]);
    await q('DELETE FROM channels WHERE _id=ANY($1::text[])', [[f.source, f.target]]);
    await q('DELETE FROM members WHERE "serverId"=ANY($1::text[])', [[f.sourceServer, f.targetServer]]);
    await q('DELETE FROM servers WHERE _id=ANY($1::text[])', [[f.sourceServer, f.targetServer]]);
    await q('DELETE FROM users WHERE _id=$1', [f.user]);
  }
});
afterAll(async () => { await adapter.disconnect(); await db._pool.end(); });

describe('channel bridge expiry against real PostgreSQL and Redis', () => {
  it('permanent source and receiver preserve content, tenant identity and live publication', async () => {
    const f = await seed();
    await send(f);
    expect((await copies(f)).rows).toEqual([expect.objectContaining({
      channelId: f.target, serverId: f.targetServer, userId: f.user,
      content: expect.stringContaining(`Fixture ${f.bridge}`),
      bridgedFrom: { channelId: f.source, serverId: f.sourceServer },
    })]);
    expect(publications(f).map(e => e.event)).toEqual(['message:new', 'channel:activity']);
  });

  it('a stale permanent receiving DTO cannot override the expired SQL row', async () => {
    const f = await seed();
    const stale = await Channels.findByIdAndServer(f.target, f.targetServer);
    expect(stale).toMatchObject({ expiresAt: null, expiryVersion: 0 });
    await expire(f.target);
    const original = Channels.findByIdAndServer.bind(Channels);
    jest.spyOn(Channels, 'findByIdAndServer').mockImplementation((id, server) =>
      id === f.target ? Promise.resolve(stale) : original(id, server));
    await send(f);
    expect((await copies(f)).rows).toHaveLength(0);
    expect(publications(f)).toHaveLength(0);
  });

  it('a live expiring receiver still accepts the authorized bridge using the database clock', async () => {
    const f = await seed();
    await q('UPDATE channels SET "expiresAt"=FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT+120000,"expiryVersion"=1 WHERE _id=$1', [f.target]);
    await send(f);
    expect((await copies(f)).rows).toHaveLength(1);
    expect(publications(f).map(e => e.event)).toEqual(['message:new', 'channel:activity']);
  });

  it('a bridge cannot pair a real receiver with a different tenant', async () => {
    const f = await seed();
    await q('UPDATE channel_bridges SET "targetServerId"=$1 WHERE _id=$2', [f.sourceServer, f.bridge]);
    await send(f);
    expect((await copies(f)).rows).toHaveLength(0);
    expect(publications(f)).toHaveLength(0);
  });

  it('a durable receiver tombstone denies even a recreated permanent row', async () => {
    const f = await seed();
    await q('INSERT INTO channel_expiry_tombstones ("channelId","serverId","expiredAt","expiryVersion","recordedAt") VALUES ($1,$2,1,1,2)',
      [f.target, f.targetServer]);
    await send(f);
    expect((await copies(f)).rows).toHaveLength(0);
    expect(publications(f)).toHaveLength(0);
  });

  it.each(['source', 'target'] as const)('expiry of %s during real target moderation refuses the copy', async side => {
    const f = await seed();
    const original = policy.machineContentRefused;
    jest.spyOn(policy, 'machineContentRefused').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      await expire(f[side]);
      return result;
    });
    await send(f);
    expect((await copies(f)).rows).toHaveLength(0);
    expect(publications(f)).toHaveLength(0);
  });

  it('expiry after committed copy suppresses publication and preserves that row for durable cleanup', async () => {
    const f = await seed();
    const original = Messages.create.bind(Messages);
    jest.spyOn(Messages, 'create').mockImplementation(async data => {
      const saved = await original(data);
      if (data.channelId === f.target) await expire(f.target);
      return saved;
    });
    await send(f);
    expect((await copies(f)).rows).toHaveLength(1);
    expect(publications(f)).toHaveLength(0);
  });

  it('expiry during actual Redis history invalidation suppresses both receiving events', async () => {
    const f = await seed();
    const original = adapter.cache.invalidatePattern.bind(adapter.cache);
    jest.spyOn(adapter.cache, 'invalidatePattern').mockImplementation(async pattern => {
      await original(pattern);
      if (pattern.includes(f.target)) await expire(f.target);
    });
    await send(f);
    expect((await copies(f)).rows).toHaveLength(1);
    expect(publications(f)).toHaveLength(0);
  });
});
