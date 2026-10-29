/** Actual dispatcher/repositories, PostgreSQL and Redis. SQL fixtures do not
 * establish an expiry configuration API, authenticated E2E or atomic writes. */
import { randomUUID } from 'crypto';
import type { Server } from 'socket.io';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import { uploadRoot } from '../../lib/runtimePaths';

if (!process.env.PG_TEST_URL) throw new Error('PG_TEST_URL is required');
process.env.REDIS_URL = process.env.REDIS_TEST_URL || process.env.REDIS_URL;
if (!process.env.REDIS_URL) throw new Error('REDIS_TEST_URL or REDIS_URL is required');

const db = require('../../db/loader').default as typeof import('../../db/postgres').default;
const { Messages, ScheduledMessages, Threads, Channels } = require('../../db/repositories') as typeof import('../../db/repositories');
const adapter = require('../../lib/redisAdapter') as typeof import('../../lib/redisAdapter');
const contentPolicy = require('../../lib/messageContentPolicy') as typeof import('../../lib/messageContentPolicy');
const voiceRouter = require('../../routes/voicemsg');
const threadsRouter = require('../../routes/threads');
const { setupMemberships } = require('../../socket/handlers/members') as typeof import('../../socket/handlers/members');
const permissions = require('../../lib/permissions') as typeof import('../../lib/permissions');
const { startScheduledJob, stopScheduledJob, _dispatchDueForTest: dispatch } =
  require('../../jobs/scheduledMessages') as typeof import('../../jobs/scheduledMessages');
const q = (sql: string, values: unknown[] = []) => db._pool.query(sql, values);

interface Fixture { user: string; server: string; channel: string; schedule: string; thread?: string }
const fixtures: Fixture[] = [];
const emitted: Array<{ room: string; event: string }> = [];
const io = { to: (room: string) => ({ emit: (event: string) => emitted.push({ room, event }) }) };

async function seed(): Promise<Fixture> {
  const f = { user: randomUUID(), server: randomUUID(), channel: randomUUID(), schedule: randomUUID() };
  fixtures.push(f);
  await q('INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$2,$3,$4,$5)',
    [f.user, `d2-${f.user}`, 'D2 test owner', 'not-an-authentication-fixture', Date.now()]);
  await q('INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$2,$3,$4)',
    [f.server, 'D2 scheduled test', f.user, Date.now()]);
  await q('INSERT INTO members ("userId","serverId",roles,"joinedAt") VALUES ($1,$2,$3::jsonb,$4)',
    [f.user, f.server, '[]', Date.now()]);
  await q('INSERT INTO channels (_id,"serverId",name,"createdAt") VALUES ($1,$2,$3,$4)',
    [f.channel, f.server, 'scheduled', Date.now()]);
  await ScheduledMessages.insert({ _id: f.schedule, channelId: f.channel, serverId: f.server,
    userId: f.user, username: `d2-${f.user}`, displayName: 'D2 test owner',
    avatarColor: '#0e7490', content: `Scheduled ${f.schedule}`, sendAt: Date.now() - 1000 });
  return f;
}

const expire = (f: Fixture) => q('UPDATE channels SET "expiresAt"=$1,"expiryVersion"=1 WHERE _id=$2',
  [Date.now() - 1000, f.channel]);
const rows = (f: Fixture) => q('SELECT * FROM messages WHERE "scheduledId"=$1', [f.schedule]);
const broadcasts = (f: Fixture) => emitted.filter(e => e.room === `channel:${f.channel}` && e.event === 'message:new');
async function threadApp(f: Fixture) {
  f.thread = randomUUID();
  await Threads.insert({ _id: f.thread, channelId: f.channel, serverId: f.server,
    createdBy: f.user, name: 'Expiry test thread', parentMessageId: null, lastMessageAt: Date.now() });
  const app = express();
  app.set('io', io);
  app.use(express.json());
  app.use('/api/threads', threadsRouter);
  const token = jwt.sign({ id: f.user, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1m' });
  return (content: string, clientNonce: string) => request(app).post(`/api/threads/${f.thread}/messages`)
    .set('Authorization', `Bearer ${token}`).send({ content, clientNonce });
}
async function expectRefused(f: Fixture, persisted = 0) {
  expect((await rows(f)).rows).toHaveLength(persisted);
  expect(broadcasts(f)).toHaveLength(0);
  expect(await ScheduledMessages.findById(f.schedule, f.user)).toMatchObject({
    sent: false, failureReason: 'channel_unavailable', claimOwner: null, claimUntil: null,
  });
  expect((await q('SELECT _id FROM channels WHERE _id=$1', [f.channel])).rows).toHaveLength(1);
}

beforeAll(async () => {
  await adapter.applyAdapter({});
  expect(adapter.isRedisAvailable()).toBe(true);
  expect(await adapter.redisClient()!.ping()).toBe('PONG');
  expect((await q('SELECT current_database() AS name')).rows[0].name).toBeTruthy();
});
beforeEach(() => {
  emitted.length = 0;
  startScheduledJob(io as unknown as Server);
});
afterEach(async () => {
  stopScheduledJob();
  jest.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    if (f.thread) {
      await q('DELETE FROM thread_messages WHERE "threadId"=$1', [f.thread]);
      await q('DELETE FROM threads WHERE _id=$1', [f.thread]);
    }
    await q('DELETE FROM channel_expiry_tombstones WHERE "channelId"=$1', [f.channel]);
    await q('DELETE FROM scheduled_msgs WHERE _id=$1', [f.schedule]);
    await q('DELETE FROM voice_messages WHERE "channelId"=$1', [f.channel]);
    await q('DELETE FROM messages WHERE "channelId"=$1', [f.channel]);
    await q('DELETE FROM channels WHERE _id=$1', [f.channel]);
    await q('DELETE FROM members WHERE "serverId"=$1', [f.server]);
    await q('DELETE FROM servers WHERE _id=$1', [f.server]);
    await q('DELETE FROM users WHERE _id=$1', [f.user]);
  }
});
afterAll(async () => {
  await adapter.disconnect();
  await db._pool.end();
});

describe('scheduled channel expiry against real PostgreSQL and Redis', () => {
  it('authenticated concurrent thread nonce submissions persist and publish exactly once', async () => {
    const f = await seed();
    const send = await threadApp(f);
    const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => send(`Concurrent reply ${i}`, 'same-nonce-0001')));
    expect(responses.map(r => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(new Set(responses.map(r => r.body._id)).size).toBe(1);
    expect((await q('SELECT _id FROM thread_messages WHERE "threadId"=$1', [f.thread])).rows).toHaveLength(1);
    expect(emitted.filter(e => e.room === `thread:${f.thread}` && e.event === 'thread:message:new')).toHaveLength(1);
  });

  it('authenticated stale thread client cannot replay a stored nonce or add a reply after expiry', async () => {
    const f = await seed();
    const send = await threadApp(f);
    expect((await send('Stored reply', 'stored-nonce-0001')).status).toBe(200);
    await expire(f);
    for (const nonce of ['stored-nonce-0001', 'new-nonce-0001']) {
      const response = await send('Stored reply', nonce);
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Channel unavailable' });
    }
    expect((await q('SELECT _id FROM thread_messages WHERE "threadId"=$1', [f.thread])).rows).toHaveLength(1);
    expect(emitted.filter(e => e.room === `thread:${f.thread}` && e.event === 'thread:message:new')).toHaveLength(1);
  });

  it('real content verification followed by PG expiry refuses thread insertion', async () => {
    const f = await seed();
    const send = await threadApp(f);
    const original = contentPolicy.checkMessageContent;
    jest.spyOn(contentPolicy, 'checkMessageContent').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      await expire(f);
      return result;
    });
    expect((await send('Content interleaving', 'interleaved-nonce-0001')).status).toBe(404);
    expect((await q('SELECT _id FROM thread_messages WHERE "threadId"=$1', [f.thread])).rows).toHaveLength(0);
    expect(emitted.filter(e => e.room === `thread:${f.thread}` && e.event === 'thread:message:new')).toHaveLength(0);
  });

  it('permanent channel: two concurrent dispatches persist and publish exactly once', async () => {
    const f = await seed();
    await Promise.all([dispatch(), dispatch()]);
    await dispatch();
    expect((await rows(f)).rows).toHaveLength(1);
    expect(broadcasts(f)).toHaveLength(1);
    expect(await ScheduledMessages.findById(f.schedule, f.user)).toMatchObject({ sent: true });
  });

  it('allows a live explicitly expiring channel using the database clock', async () => {
    const f = await seed();
    await q('UPDATE channels SET "expiresAt"=FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT+120000,"expiryVersion"=1 WHERE _id=$1', [f.channel]);
    await dispatch();
    expect((await rows(f)).rows).toHaveLength(1);
    expect(broadcasts(f)).toHaveLength(1);
  });

  it('refuses a channel expired after queue insertion', async () => {
    const f = await seed();
    await expire(f);
    await dispatch();
    await expectRefused(f);
  });

  it('actual authenticated voice HTTP route refuses expiry before file or DB writes', async () => {
    const f = await seed();
    await expire(f);
    const app = express();
    app.use('/api/voice-messages', voiceRouter);
    const token = jwt.sign({ id: f.user, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1m' });
    const files = () => fs.readdirSync(uploadRoot()).filter(name => name.startsWith('vm_')).sort();
    const before = files();
    const response = await request(app).post('/api/voice-messages').set('Authorization', `Bearer ${token}`)
      .field('serverId', f.server).field('channelId', f.channel).field('duration', '0')
      .attach('audio', Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), { filename: 'fixture.webm', contentType: 'audio/webm' });
    expect(response.status).toBe(404);
    expect((await q('SELECT _id FROM voice_messages WHERE "channelId"=$1', [f.channel])).rows).toHaveLength(0);
    expect((await q('SELECT _id FROM messages WHERE "channelId"=$1', [f.channel])).rows).toHaveLength(0);
    expect(files()).toEqual(before);
    const otherTenant = await seed();
    const otherToken = jwt.sign({ id: otherTenant.user, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1m' });
    const unauthorized = await request(app).post('/api/voice-messages').set('Authorization', `Bearer ${otherToken}`)
      .field('serverId', f.server).field('channelId', f.channel).field('duration', '0')
      .attach('audio', Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), { filename: 'fixture.webm', contentType: 'audio/webm' });
    expect(unauthorized.status).toBe(403);
    expect((await q('SELECT _id FROM voice_messages WHERE "channelId"=$1', [f.channel])).rows).toHaveLength(0);
    expect((await q('SELECT _id FROM messages WHERE "channelId"=$1', [f.channel])).rows).toHaveLength(0);
    expect(files()).toEqual(before);
  });

  it('tombstone is terminal even if the channel row still appears permanent', async () => {
    const f = await seed();
    await q('INSERT INTO channel_expiry_tombstones ("channelId","serverId","expiredAt","expiryVersion","recordedAt") VALUES ($1,$2,$3,1,$4)',
      [f.channel, f.server, Date.now() - 1000, Date.now()]);
    await dispatch();
    await expectRefused(f);
  });

  it('rechecks after real content verification before inserting a message', async () => {
    const f = await seed();
    const original = contentPolicy.checkMessageContent;
    jest.spyOn(contentPolicy, 'checkMessageContent').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      expect(result).toBeNull();
      await expire(f);
      return result;
    });
    await dispatch();
    await expectRefused(f);
  });

  it('does not publish if expiry occurs after insertion; retains the committed row', async () => {
    const f = await seed();
    const original = Messages.create.bind(Messages);
    jest.spyOn(Messages, 'create').mockImplementationOnce(async (...args) => {
      const message = await original(...args);
      await expire(f);
      return message;
    });
    await dispatch();
    await expectRefused(f, 1);
  });

  it('recovers an abandoned lease without duplicating or republishing an expired message', async () => {
    const f = await seed();
    await Messages.create({ _id: randomUUID(), channelId: f.channel, serverId: f.server, userId: f.user,
      username: `d2-${f.user}`, displayName: 'D2 test owner', content: 'committed before crash',
      scheduledId: f.schedule, createdAt: Date.now() });
    await q('UPDATE scheduled_msgs SET "claimOwner"=$1,"claimUntil"=$2,"dispatchAttempts"=1 WHERE _id=$3',
      ['abandoned-worker', Date.now() - 1000, f.schedule]);
    await expire(f);
    await dispatch();
    await dispatch();
    await expectRefused(f, 1);
  });
});


// Real repositories/permissions/expiry SQL; transport double, not a Socket.IO
// authentication, browser or persistent-background eviction acceptance claim.
async function membershipTransport(f: Fixture) {
  const handlers = new Map<string, (payload?: unknown) => unknown>();
  const socket = {
    id: randomUUID(), rooms: new Set<string>(),
    on(event: string, handler: (payload?: unknown) => unknown) { handlers.set(event, handler); },
    emit() {}, join(room: string) { this.rooms.add(room); }, leave(room: string) { this.rooms.delete(room); },
  };
  await setupMemberships(socket as never, { _id: f.user });
  return { socket, join: () => Promise.resolve(handlers.get('channel:join')!(f.channel)) };
}

describe('channel subscription preflight with real PostgreSQL and Redis', () => {
  it('joins a live channel then removes its now-expired room on explicit rejoin', async () => {
    const f = await seed();
    const transport = await membershipTransport(f);
    await transport.join();
    expect(transport.socket.rooms.has(`channel:${f.channel}`)).toBe(true);
    await expire(f);
    await transport.join();
    expect(transport.socket.rooms.has(`channel:${f.channel}`)).toBe(false);
    expect((await q('SELECT _id FROM channels WHERE _id=$1', [f.channel])).rows).toHaveLength(1);
  });
  it('refuses an expired SQL row even when the initial channel DTO is stale and permanent', async () => {
    const f = await seed();
    const stale = await Channels.findById(f.channel);
    expect(stale).toBeTruthy();
    await expire(f);
    jest.spyOn(Channels, 'findById').mockResolvedValueOnce(stale);
    const transport = await membershipTransport(f);
    await transport.join();
    expect(transport.socket.rooms.has(`channel:${f.channel}`)).toBe(false);
  });
  it('refuses a real tombstone while the channel row is still permanent', async () => {
    const f = await seed();
    await q('INSERT INTO channel_expiry_tombstones ("channelId","serverId","expiredAt","expiryVersion","recordedAt","cleanupState") VALUES ($1,$2,$3,1,$4,$5)',
      [f.channel, f.server, Date.now() - 1000, Date.now(), 'pending']);
    const transport = await membershipTransport(f);
    await transport.join();
    expect(transport.socket.rooms.has(`channel:${f.channel}`)).toBe(false);
  });
  it('rechecks authority after actual membership/visibility permission work yields', async () => {
    const f = await seed();
    const original = permissions.canViewChannel;
    jest.spyOn(permissions, 'canViewChannel').mockImplementationOnce(async (...args) => {
      const allowed = await original(...args);
      expect(allowed).toBe(true);
      await expire(f);
      return allowed;
    });
    const transport = await membershipTransport(f);
    await transport.join();
    expect(transport.socket.rooms.has(`channel:${f.channel}`)).toBe(false);
  });
});
