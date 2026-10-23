/**
 * P7 D2: voice, Stage and SFU admission against the authoritative channel
 * lifecycle (row, tenant, tombstone and the PostgreSQL clock).
 *
 * Live media never touches the message write barrier, so an expired channel
 * must be refused by every media control path itself. The worker evicts live
 * room members when it claims the channel, but only up to a minute after
 * `expiresAt` and best effort; these tests cover that window and the paths
 * that would otherwise admit or mutate state in a channel that no longer
 * exists:
 *   · voice:join (fresh, and one waiting on the roster lock while the channel
 *     expires), signaling from a peer admitted before expiry, voice HTTP;
 *   · stage:join, the Stage mutations of an already-joined user, stage:leave
 *     cleanup, and the Stage helpers the SFU and video grid rely on;
 *   · SFU channel authority (every sfu:* operation re-checks it);
 *   · voice messages: upload and transcript read.
 * Each refusal is paired with a positive control on a permanent channel and on
 * an ephemeral channel that is still live.
 */
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown; headers: Record<string, string | undefined> }, _res: unknown, next: () => void) => {
    req.user = { id: req.headers['x-test-user'], username: req.headers['x-test-user'], displayName: 'tester' };
    next();
  },
  _invalidateTokenCache: () => undefined,
}));
jest.mock('../../middleware/rateLimit', () => ({
  limits: new Proxy({}, { get: () => () => (_req: unknown, _res: unknown, next: () => void) => next() }),
}));

// With REDIS_TEST_URL (the CI PG job), rosters, room locks and the Socket.IO
// adapter run on real Redis exactly as in a multi-node deployment. The adapter
// reads REDIS_URL when it loads, so this precedes every Bridge module.
const REDIS_TEST_URL = process.env.REDIS_TEST_URL;
if (REDIS_TEST_URL) process.env.REDIS_URL = REDIS_TEST_URL;

import { createServer } from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import request from 'supertest';
import { Server as SocketServer, type Socket as ServerSocket } from 'socket.io';
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';
import type { ClusterServer, HandlerSocket } from '../../socket/handler-contracts';

/* eslint-disable @typescript-eslint/no-require-imports */
const { registerVoiceHandlers, __getVoiceRoomForTest } = require('../../socket/handlers/voice') as typeof import('../../socket/handlers/voice');
const { registerStageHandlers, isStageParticipant, isStageSpeaker, canManageStage, stageRooms } =
  require('../../socket/handlers/stage') as typeof import('../../socket/handlers/stage');
const { authorizeChannelMediaRoom } = require('../../socket/handlers/mediasoup/authority') as typeof import('../../socket/handlers/mediasoup/authority');
const { cache, isRedisAvailable, applyAdapter, disconnect } = require('../../lib/redisAdapter') as typeof import('../../lib/redisAdapter');
/* eslint-enable @typescript-eslint/no-require-imports */

const db = require('../../db/loader').default;
const voiceRouter = require('../../routes/channels/voice').default;
const voiceMessageRouter = require('../../routes/voicemsg').default;

const RUN = process.env.PG_TEST_URL ? describe : describe.skip;
const P = 'pgt-d2-media-' + process.pid + '-' + Date.now();
const OWNER = P + '-owner';
const PEER = P + '-peer';
const SERVER = P + '-server';
const HOUR = 60 * 60 * 1000;

type Observed = HandlerSocket & { currentVoiceChannel?: string | null; currentVoiceServer?: string | null };

RUN('P7 D2 voice, Stage and SFU admission follow channel expiry — real PostgreSQL + Socket.IO', () => {
  const q = async (sql: string, params: unknown[] = []) => (await db._pool.query(sql, params)).rows as Array<Record<string, unknown>>;
  const http = createServer();
  const io = new SocketServer(http);
  const sockets = new Map<string, { real: ServerSocket; observed: Observed }>();
  const clients: ClientSocket[] = [];
  let url = '';
  let seq = 0;

  const app = express();
  app.use(express.json());
  app.use('/api/channels', voiceRouter);
  app.use('/api/voice-messages', voiceMessageRouter);

  async function cleanup() {
    await q('DELETE FROM messages WHERE "serverId"=$1', [SERVER]);
    await q('DELETE FROM voice_messages WHERE "serverId"=$1', [SERVER]);
    await q('DELETE FROM channel_expiry_tombstones WHERE "serverId"=$1', [SERVER]);
    await q('DELETE FROM channels WHERE "serverId"=$1', [SERVER]);
    await q('DELETE FROM members WHERE "serverId"=$1', [SERVER]);
    await q('DELETE FROM servers WHERE _id=$1', [SERVER]);
    await q('DELETE FROM users WHERE _id IN ($1,$2)', [OWNER, PEER]);
  }

  /** kind: 'permanent' | 'live' (expires in an hour) */
  async function channel(type: 'voice' | 'stage' | 'text', kind: 'permanent' | 'live' = 'live'): Promise<string> {
    const id = `${P}-${type}-${kind}-${++seq}`;
    await q('INSERT INTO channels (_id,"serverId",name,type,"createdAt","expiresAt","expiryVersion") VALUES ($1,$2,$1,$3,1,$4,$5)',
      [id, SERVER, type, kind === 'live' ? Date.now() + HOUR : null, kind === 'live' ? 1 : 0]);
    return id;
  }
  /** Moves the expiry into the database clock's past; the worker has not claimed it. */
  const expire = (id: string) => q(
    `UPDATE channels SET "expiresAt" = FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT - 1000,
            "expiryVersion" = "expiryVersion" + 1 WHERE _id = $1`, [id]);
  /** A claimed channel: the row may remain while the worker drains it. */
  const tombstone = (id: string) => q(
    `INSERT INTO channel_expiry_tombstones ("channelId","serverId","expiredAt","expiryVersion","recordedAt","cleanupState")
     VALUES ($1,$2,$3,1,$3,'pending')`, [id, SERVER, Date.now()]);

  beforeAll(async () => {
    await cleanup();
    await q('INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$1,$1,$3,1),($2,$2,$2,$3,1)',
      [OWNER, PEER, 'irrelevant']);
    await q('INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$1,$2,1)', [SERVER, OWNER]);
    await q('INSERT INTO members ("userId","serverId",roles,"joinedAt") VALUES ($1,$3,$4::jsonb,1),($2,$3,$4::jsonb,1)',
      [OWNER, PEER, SERVER, '[]']);
    // PEER gets CONNECT/SPEAK through @everyone defaults; grant explicitly so
    // the controls do not depend on the default role mask.
    io.on('connection', (socket) => {
      const observed: Observed = {
        id: socket.id,
        rooms: socket.rooms,
        on<A extends unknown[]>(event: string, listener: (...args: A) => unknown) {
          return socket.on(event, (...args: unknown[]) => {
            void Promise.resolve(listener(...args as A)).then(
              () => { socket.emit('test:done', event); },
              () => { socket.emit('test:done', event); },
            );
          });
        },
        emit: (event, ...args) => socket.emit(event, ...args),
        join: room => socket.join(room),
        leave: room => socket.leave(room),
        to: room => socket.to(room),
      } as Observed;
      sockets.set(socket.id, { real: socket, observed });
      const userId = String(socket.handshake.auth.userId);
      const user = { _id: userId, username: userId, displayName: userId, avatarColor: '#123456' };
      registerVoiceHandlers(observed as never, io as never, user);
      registerStageHandlers(observed, io as unknown as ClusterServer, user as never);
      socket.emit('test:ready');
    });
    if (REDIS_TEST_URL) {
      expect(await applyAdapter(io)).toBe(true);
      expect(isRedisAvailable()).toBe(true);
    }
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    url = 'http://127.0.0.1:' + (http.address() as AddressInfo).port;
  });
  afterEach(() => { for (const c of clients.splice(0)) c.close(); sockets.clear(); });
  afterAll(async () => {
    await io.close();
    await cleanup();
    if (REDIS_TEST_URL) {
      for (const pattern of [`voice:room:${P}*`, `stage:room:${P}*`]) {
        const raw = cache._client();
        for (const key of raw ? await raw.keys(`bridge:cache:${pattern}`) : []) await raw?.del(key);
      }
      await disconnect();
    }
  });

  async function connect(userId = OWNER) {
    const client = connectClient(url, { transports: ['websocket'], reconnection: false, auth: { userId } });
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once('test:ready', resolve);
      client.once('connect_error', reject);
    });
    const entry = sockets.get(String(client.id));
    if (!entry) throw new Error('socket not registered');
    return { client, server: entry.observed };
  }
  /** Emit and wait until the server-side handler promise settled. */
  function call(client: ClientSocket, event: string, payload: unknown): Promise<unknown> {
    return new Promise((resolve) => {
      let ackValue: unknown;
      const onDone = (handled: string) => {
        if (handled !== event) return;
        client.off('test:done', onDone);
        resolve(ackValue);
      };
      client.on('test:done', onDone);
      client.emit(event, payload, (ack: unknown) => { ackValue = ack; });
    });
  }
  function record(client: ClientSocket, events: string[]) {
    const seen: Array<{ event: string; payload: unknown }> = [];
    for (const event of events) client.on(event, (payload: unknown) => seen.push({ event, payload }));
    return seen;
  }
  const voiceJoin = async (client: ClientSocket, channelId: string) => {
    const seen = record(client, ['voice:joined', 'voice:join-rejected']);
    await call(client, 'voice:join', { channelId, serverId: SERVER, requestId: 'r' + (++seq) });
    return seen.map(s => s.event);
  };

  describe('voice', () => {
    it('admits a permanent and a live ephemeral voice channel (positive controls)', async () => {
      for (const kind of ['permanent', 'live'] as const) {
        const ch = await channel('voice', kind);
        const { client } = await connect();
        expect(await voiceJoin(client, ch)).toEqual(['voice:joined']);
        expect((await __getVoiceRoomForTest(ch)).map(p => p.userId)).toEqual([OWNER]);
        await call(client, 'voice:leave', { channelId: ch, serverId: SERVER });
      }
    });

    it('refuses voice:join into an expired-but-unclaimed or a tombstoned channel and leaves no roster entry', async () => {
      const expired = await channel('voice');
      await expire(expired);
      const tombed = await channel('voice');
      await tombstone(tombed);
      for (const ch of [expired, tombed]) {
        const { client, server } = await connect();
        expect(await voiceJoin(client, ch)).toEqual(['voice:join-rejected']);
        expect(await __getVoiceRoomForTest(ch)).toEqual([]);
        expect(server.rooms.has(`voice:${ch}`)).toBe(false);
        expect(server.currentVoiceChannel ?? null).toBeNull();
      }
    });

    it('a join that waited on the roster lock while the channel expired is undone, not admitted', async () => {
      const ch = await channel('voice');
      const { client, server } = await connect();
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      let locked!: () => void;
      const lockTaken = new Promise<void>(resolve => { locked = resolve; });
      const holder = cache.withKeyLock(`voice-room:${ch}`, async () => { locked(); await held; },
        { leaseSeconds: 10, waitMs: 10_000 });
      await lockTaken;
      const seen = record(client, ['voice:joined', 'voice:join-rejected']);
      const joining = call(client, 'voice:join', { channelId: ch, serverId: SERVER, requestId: 'locked' });
      // The admission preflight ran before the lock; the channel expires while the join waits.
      await new Promise(r => setTimeout(r, 100));
      await expire(ch);
      release();
      await holder;
      await joining;
      expect(seen.map(s => s.event)).toEqual(['voice:join-rejected']);
      expect(await __getVoiceRoomForTest(ch)).toEqual([]);
      expect(server.rooms.has(`voice:${ch}`)).toBe(false);
    });

    it('a peer admitted before expiry can no longer signal, and is dropped from the roster when it tries', async () => {
      const ch = await channel('voice');
      const a = await connect(OWNER);
      const b = await connect(PEER);
      expect(await voiceJoin(a.client, ch)).toEqual(['voice:joined']);
      expect(await voiceJoin(b.client, ch)).toEqual(['voice:joined']);
      const received = record(b.client, ['webrtc:offer', 'webrtc:ice-candidate']);

      // Live: the offer reaches B (positive control for the same pair).
      await call(a.client, 'webrtc:offer', { targetSocketId: b.client.id, offer: { sdp: 'v=0', type: 'offer' }, channelId: ch });
      await new Promise(r => setTimeout(r, 50));
      expect(received.map(r => r.event)).toEqual(['webrtc:offer']);

      await expire(ch);
      // The liveness of an admitted peer is cached for at most a short window; wait past it.
      await new Promise(r => setTimeout(r, 2_100));
      await call(a.client, 'webrtc:offer', { targetSocketId: b.client.id, offer: { sdp: 'v=0', type: 'offer' }, channelId: ch });
      await call(a.client, 'webrtc:ice-candidate', { targetSocketId: b.client.id, candidate: { candidate: 'c' }, channelId: ch });
      await new Promise(r => setTimeout(r, 50));
      expect(received.map(r => r.event)).toEqual(['webrtc:offer']);   // nothing new delivered
      expect((await __getVoiceRoomForTest(ch)).map(p => p.userId)).not.toContain(OWNER);
      expect(a.server.rooms.has(`voice:${ch}`)).toBe(false);
    });

    it('voice HTTP: state updates and the member list are refused for an expired channel, served for a live one', async () => {
      const live = await channel('voice');
      const gone = await channel('voice');
      const { client } = await connect();
      expect(await voiceJoin(client, live)).toEqual(['voice:joined']);
      expect(await voiceJoin(client, gone)).toEqual(['voice:joined']);   // moves the socket to `gone`
      const members = (cid: string) => request(app).get(`/api/channels/${cid}/voice-members`).set('x-test-user', OWNER);
      const state = (cid: string) => request(app).post(`/api/channels/${cid}/voice-state`).set('x-test-user', OWNER).send({ selfMute: true });

      expect((await members(gone)).body.map((p: { userId: string }) => p.userId)).toEqual([OWNER]);
      expect((await state(gone)).status).toBe(200);
      await expire(gone);
      const after = await members(gone);
      expect(after.status).toBe(404);
      expect(JSON.stringify(after.body)).not.toContain(OWNER);
      expect((await state(gone)).status).toBe(404);
      expect((await members(live)).status).toBe(200);
    });
  });

  describe('stage', () => {
    const stageJoin = (client: ClientSocket, channelId: string) => call(client, 'stage:join', { channelId });

    it('admits a permanent and a live ephemeral stage (positive controls)', async () => {
      for (const kind of ['permanent', 'live'] as const) {
        const ch = await channel('stage', kind);
        const { client } = await connect();
        expect(await stageJoin(client, ch)).toMatchObject({ ok: true });
        expect(await call(client, 'stage:setRole', { channelId: ch, role: 'speaker' })).toEqual({ ok: true });
        expect(await isStageSpeaker(ch, OWNER)).toBe(true);
        expect(await canManageStage(ch, OWNER)).toBe(true);
      }
    });

    it('refuses stage:join into an expired or tombstoned stage', async () => {
      const expired = await channel('stage');
      await expire(expired);
      const tombed = await channel('stage');
      await tombstone(tombed);
      for (const ch of [expired, tombed]) {
        const { client, server } = await connect();
        expect(await stageJoin(client, ch)).toEqual({ ok: false, code: 'STAGE_UNAVAILABLE' });
        expect(server.rooms.has(`stage:${ch}`)).toBe(false);
      }
    });

    it('an already-joined host can no longer mutate an expired stage; SFU and grid helpers deny it; leave still cleans up', async () => {
      const ch = await channel('stage');
      const host = await connect(OWNER);
      const listener = await connect(PEER);
      expect(await stageJoin(host.client, ch)).toMatchObject({ ok: true });
      expect(await call(host.client, 'stage:setRole', { channelId: ch, role: 'speaker' })).toEqual({ ok: true });
      expect(await stageJoin(listener.client, ch)).toMatchObject({ ok: true });
      expect(await call(listener.client, 'stage:setRole', { channelId: ch, role: 'listener' })).toEqual({ ok: true });
      expect(await isStageParticipant(ch, PEER)).toBe(true);

      await expire(ch);
      expect(await call(host.client, 'stage:promote', { channelId: ch, targetUserId: PEER })).toEqual({ ok: false, code: 'STAGE_ACTION_REJECTED' });
      expect(await call(host.client, 'stage:setTopic', { channelId: ch, topic: 'after expiry' })).toEqual({ ok: false, code: 'STAGE_ACTION_REJECTED' });
      expect(await call(host.client, 'stage:setLive', { channelId: ch, live: true })).toEqual({ ok: false, code: 'STAGE_ACTION_REJECTED' });
      expect(await call(listener.client, 'stage:setRole', { channelId: ch, role: 'speaker' })).toEqual({ ok: false, code: 'STAGE_ROLE_REJECTED' });
      expect(await call(listener.client, 'stage:handRaise', { channelId: ch, raised: true })).toEqual({ ok: false, code: 'STAGE_ACTION_REJECTED' });
      expect(await isStageParticipant(ch, PEER)).toBe(false);
      expect(await isStageSpeaker(ch, OWNER)).toBe(false);
      expect(await canManageStage(ch, OWNER)).toBe(false);

      // Leaving an expired stage removes the roster entry and the room instead of acknowledging a no-op.
      expect(await call(listener.client, 'stage:leave', { channelId: ch })).toEqual({ ok: true });
      expect(listener.server.rooms.has(`stage:${ch}`)).toBe(false);
      const roster = isRedisAvailable()
        ? await cache.getAuthoritative<{ speakers: Array<{ userId: string }>; listeners: Array<{ userId: string }> }>(`stage:room:${ch}`)
        : stageRooms.get(ch) ?? null;
      const ids = roster ? [...roster.speakers, ...roster.listeners].map(u => u.userId) : [];
      expect(ids).not.toContain(PEER);
    });
  });

  describe('SFU channel authority', () => {
    it('authorizes live and permanent voice/stage rooms and refuses expired, tombstoned and wrong-tenant ones', async () => {
      const permanent = await channel('voice', 'permanent');
      const live = await channel('stage');
      const expired = await channel('voice');
      await expire(expired);
      const tombed = await channel('stage');
      await tombstone(tombed);
      const text = await channel('text');

      expect(await authorizeChannelMediaRoom(OWNER, permanent, SERVER)).toMatchObject({ serverId: SERVER, channelType: 'voice' });
      expect(await authorizeChannelMediaRoom(OWNER, live, null, true)).toMatchObject({ serverId: SERVER, channelType: 'stage' });
      expect(await authorizeChannelMediaRoom(OWNER, expired, SERVER)).toBeNull();
      expect(await authorizeChannelMediaRoom(OWNER, tombed, null)).toBeNull();
      expect(await authorizeChannelMediaRoom(OWNER, permanent, 'another-server')).toBeNull();
      expect(await authorizeChannelMediaRoom(OWNER, text, SERVER)).toBeNull();
      expect(await authorizeChannelMediaRoom(OWNER, P + '-no-such-channel', null)).toBe('no-channel');
    });
  });

  describe('voice messages', () => {
    it('refuses an upload into an expired channel before storing anything, and hides an expired transcript', async () => {
      const live = await channel('text');
      const gone = await channel('text');
      const upload = (cid: string) => request(app).post('/api/voice-messages').set('x-test-user', OWNER)
        .field('channelId', cid).field('serverId', SERVER).field('duration', '3')
        .attach('audio', Buffer.from('OggS fake audio'), { filename: 'a.ogg', contentType: 'audio/ogg' });

      const ok = await upload(live);
      expect(ok.status).toBe(200);
      const vmId = String(ok.body.vmId);
      await q('UPDATE voice_messages SET transcript=$1 WHERE _id=$2', ['spoken words', vmId]);
      await q('UPDATE voice_messages SET "channelId"=$1 WHERE _id=$2', [gone, vmId]);   // same row, ephemeral channel
      const transcript = () => request(app).get(`/api/voice-messages/${vmId}/transcript`).set('x-test-user', OWNER);
      expect((await transcript()).body).toEqual({ transcript: 'spoken words', status: 'done' });

      await expire(gone);
      const hidden = await transcript();
      expect(hidden.status).toBe(404);
      expect(JSON.stringify(hidden.body)).not.toContain('spoken words');

      const before = await q('SELECT COUNT(*)::int AS n FROM voice_messages WHERE "channelId"=$1', [gone]);
      const refused = await upload(gone);
      expect(refused.status).toBe(403);
      expect(await q('SELECT COUNT(*)::int AS n FROM voice_messages WHERE "channelId"=$1', [gone])).toEqual(before);
      expect(await q('SELECT COUNT(*)::int AS n FROM messages WHERE "channelId"=$1', [gone])).toEqual([{ n: 0 }]);
    });
  });
});

export {};
