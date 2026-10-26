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
 *     expires), each of the six relay paths from a peer admitted before
 *     expiry, voice HTTP, and the database (not application) clock;
 *   · stage:join, the Stage mutations of an already-joined user (also while
 *     held on the roster lock across expiry), stage:leave cleanup, and the
 *     Stage helpers the SFU and video grid rely on;
 *   · SFU channel authority (every sfu:* operation re-checks it);
 *   · voice messages: upload and transcript read;
 *   · the expiry instant itself: live media is evicted when `expiresAt`
 *     passes with no expiry worker running, and an admitted peer's cached
 *     liveness never outlives `expiresAt`.
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
import logger from '../../lib/logger';
import { currentRequestContext, runWithRequestContext } from '../../lib/requestContext';
import { captureActualLogRecords } from '../helpers/capture-actual-log-records';

/* eslint-disable @typescript-eslint/no-require-imports */
const { registerVoiceHandlers, __getVoiceRoomForTest } = require('../../socket/handlers/voice') as typeof import('../../socket/handlers/voice');
const { registerStageHandlers, isStageParticipant, isStageSpeaker, canManageStage, stageRooms } =
  require('../../socket/handlers/stage') as typeof import('../../socket/handlers/stage');
const { authorizeChannelMediaRoom } = require('../../socket/handlers/mediasoup/authority') as typeof import('../../socket/handlers/mediasoup/authority');
const { cache, isRedisAvailable, applyAdapter, disconnect } = require('../../lib/redisAdapter') as typeof import('../../lib/redisAdapter');
const { channelLiveForMedia } = require('../../lib/channelContentAvailability') as typeof import('../../lib/channelContentAvailability');
const { registerLocalVoiceEvictor, bindVoiceEvictionClusterControl } = require('../../lib/liveMembership') as typeof import('../../lib/liveMembership');
const { evictLocalVoiceSessions } = require('../../socket/voiceEviction') as typeof import('../../socket/voiceEviction');
const { armMediaExpiryEviction, __armedMediaExpiryForTest, __resetMediaExpiryEvictionForTest } =
  require('../../socket/mediaExpiryEviction') as typeof import('../../socket/mediaExpiryEviction');
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
  // Node B (real Redis mode only): a second Socket.IO server on the same Redis,
  // with its own adapter clients, as a second Bridge node would have.
  const httpB = createServer();
  const ioB = new SocketServer(httpB);
  let urlB = '';
  const nodeBClients: Array<{ quit(): Promise<unknown> }> = [];
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
    const wire = (node: SocketServer) => node.on('connection', (socket) => {
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
      // The production evictor (socket/voiceEviction.ts) works on the real
      // Socket instances of this node; keep the voice fields on the real socket
      // so it sees what the handlers set.
      const voiceFields = socket as unknown as Pick<Observed, 'currentVoiceChannel' | 'currentVoiceServer'>;
      for (const field of ['currentVoiceChannel', 'currentVoiceServer'] as const) {
        Object.defineProperty(observed, field, {
          get: () => voiceFields[field],
          set: (value: string | null | undefined) => { voiceFields[field] = value; },
        });
      }
      sockets.set(socket.id, { real: socket, observed });
      const userId = String(socket.handshake.auth.userId);
      const user = { _id: userId, username: userId, displayName: userId, avatarColor: '#123456' };
      // The rooms every authenticated socket of a server member holds.
      void socket.join([`user:${userId}`, `server:${SERVER}`]);
      registerVoiceHandlers(observed as never, node as never, user);
      registerStageHandlers(observed, node as unknown as ClusterServer, user as never);
      socket.emit('test:ready');
    });
    wire(io);
    registerLocalVoiceEvictor(evictLocalVoiceSessions);
    if (REDIS_TEST_URL) {
      expect(await applyAdapter(io)).toBe(true);
      expect(isRedisAvailable()).toBe(true);
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { createClient } = require('redis') as { createClient(o: { url: string }): { connect(): Promise<unknown>; duplicate(): never; quit(): Promise<unknown> } };
      const { createAdapter } = require('@socket.io/redis-adapter') as { createAdapter(pub: unknown, sub: unknown): never };
      /* eslint-enable @typescript-eslint/no-require-imports */
      const pub = createClient({ url: REDIS_TEST_URL });
      const sub = (pub as unknown as { duplicate(): typeof pub }).duplicate();
      await Promise.all([pub.connect(), sub.connect()]);
      nodeBClients.push(pub, sub);
      ioB.adapter(createAdapter(pub, sub));
      // Production socket setup binds the cluster eviction listener on every node.
      bindVoiceEvictionClusterControl(io);
      bindVoiceEvictionClusterControl(ioB);
      wire(ioB);
      await new Promise<void>(resolve => httpB.listen(0, '127.0.0.1', resolve));
      urlB = 'http://127.0.0.1:' + (httpB.address() as AddressInfo).port;
    }
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    url = 'http://127.0.0.1:' + (http.address() as AddressInfo).port;
  });
  afterEach(() => { for (const c of clients.splice(0)) c.close(); sockets.clear(); __resetMediaExpiryEvictionForTest(); });
  afterAll(async () => {
    registerLocalVoiceEvictor(null);
    await io.close();
    await ioB.close();
    for (const client of nodeBClients) await client.quit();
    await cleanup();
    if (REDIS_TEST_URL) {
      for (const pattern of [`voice:room:${P}*`, `stage:room:${P}*`]) {
        const raw = cache._client();
        for (const key of raw ? await raw.keys(`bridge:cache:${pattern}`) : []) await raw?.del(key);
      }
      await disconnect();
    }
  });

  async function connect(userId = OWNER, target = url) {
    const client = connectClient(target, { transports: ['websocket'], reconnection: false, auth: { userId } });
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
    it('serializes routine voice INFO without ambient actor/socket identity while retaining security context', async () => {
      const ch = await channel('voice', 'permanent');
      const owner = await connect();
      const peer = await connect(PEER);
      expect(await voiceJoin(owner.client, ch)).toEqual(['voice:joined']);
      expect(await voiceJoin(peer.client, ch)).toEqual(['voice:joined']);
      const original = {
        requestId: 'pg-voice-privacy-correlation', userId: OWNER,
        socketId: owner.client.id!, memo: new Map<string, unknown>([['sentinel', true]]),
      };
      const capture = captureActualLogRecords();
      try {
        await runWithRequestContext(original, async () => {
          await evictLocalVoiceSessions(io, OWNER, [ch]);
          expect(currentRequestContext()).toBe(original);
          expect(currentRequestContext()?.memo).toBe(original.memo);
          logger.warn({ event: 'test.voice-security-context' }, 'Security context positive control.');
        });
        expect(owner.server.currentVoiceChannel).toBeNull();
        expect(peer.server.currentVoiceChannel).toBe(ch);
        expect((await __getVoiceRoomForTest(ch)).map(row => row.userId)).toEqual([PEER]);
        const info = capture.records.filter(row => row.event === 'socket.voice_evicted');
        expect(info).toHaveLength(1);
        expect(info[0]).toMatchObject({ level: 30, requestId: original.requestId, sfu: false });
        for (const field of ['userId', 'socketId', 'channelId', 'serverId', 'memo']) {
          expect(info[0]).not.toHaveProperty(field);
        }
        for (const value of [OWNER, PEER, ch, SERVER, owner.client.id!]) {
          expect(JSON.stringify(info[0])).not.toContain(value);
        }
        expect(capture.records.find(row => row.event === 'test.voice-security-context')).toMatchObject({
          level: 40, requestId: original.requestId, userId: OWNER, socketId: owner.client.id,
        });
        expect(currentRequestContext()).toBeUndefined();
      } finally { capture.restore(); }
    });

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

    // Each relay path, checked on its own: a fresh pair per path, no relay before
    // expiry (so no reused liveness answer), one relay attempt after it.
    const relays: Array<{ event: string; delivered: string; payload: (ch: string, target: { id: string; user: string }) => unknown }> = [
      { event: 'webrtc:offer', delivered: 'webrtc:offer',
        payload: (ch, t) => ({ targetSocketId: t.id, offer: { type: 'offer', sdp: 'v=0' }, channelId: ch }) },
      { event: 'webrtc:answer', delivered: 'webrtc:answer',
        payload: (ch, t) => ({ targetSocketId: t.id, answer: { type: 'answer', sdp: 'v=0' }, channelId: ch }) },
      { event: 'webrtc:ice-candidate', delivered: 'webrtc:ice-candidate',
        payload: (ch, t) => ({ targetSocketId: t.id, candidate: { candidate: 'c' }, channelId: ch }) },
      { event: 'voice:state-update', delivered: 'voice:peer-state',
        payload: ch => ({ channelId: ch, muted: true, deafened: false, screensharing: false, video: false }) },
      { event: 'voice:activity', delivered: 'voice:activity',
        payload: ch => ({ channelId: ch, speaking: true }) },
      { event: 'voice:e2e-key', delivered: 'voice:e2e-key',
        payload: (ch, t) => ({ channelId: ch, targetUserId: t.user, encryptedKey: 'opaque-wrapped-key' }) },
    ];
    for (const relay of relays) {
      it(`${relay.event}: delivered while live, refused from a peer admitted before expiry`, async () => {
        for (const phase of ['live', 'expired'] as const) {
          const ch = await channel('voice');
          const a = await connect(OWNER);
          const b = await connect(PEER);
          expect(await voiceJoin(a.client, ch)).toEqual(['voice:joined']);
          expect(await voiceJoin(b.client, ch)).toEqual(['voice:joined']);
          const received = record(b.client, [relay.delivered]);
          if (phase === 'expired') await expire(ch);
          await call(a.client, relay.event, relay.payload(ch, { id: String(b.client.id), user: PEER }));
          await new Promise(r => setTimeout(r, 50));
          expect([phase, received.length]).toEqual([phase, phase === 'live' ? 1 : 0]);
          if (phase === 'expired') {
            expect((await __getVoiceRoomForTest(ch)).map(p => p.userId)).not.toContain(OWNER);
            expect(a.server.rooms.has(`voice:${ch}`)).toBe(false);
          }
          for (const c of [a.client, b.client]) c.close();
        }
      });
    }

    it('expiry is decided by the database clock, not the application clock', async () => {
      const expired = await channel('voice');
      await expire(expired);
      const live = await channel('voice');
      const { client } = await connect();
      // Shift the application clock (it keeps advancing; a frozen clock would
      // stall unrelated timers), never the database's.
      const realDateNow = Date.now.bind(Date);
      let skewMs = 0;
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => realDateNow() + skewMs);
      try {
        // An application clock two hours behind must not revive the expired channel.
        skewMs = -2 * HOUR;
        expect(await voiceJoin(client, expired)).toEqual(['voice:join-rejected']);
        expect(await authorizeChannelMediaRoom(OWNER, expired, SERVER)).toBeNull();
        // An application clock two hours ahead (past the live channel's expiry)
        // must not expire a channel the database still holds live. Checked on the
        // same authority without a client socket: the in-process Socket.IO
        // client's own ping-expiry check reads Date.now() and would drop its
        // connection on a forward jump (a harness artifact, not product state).
        client.close();
        skewMs = 2 * HOUR;
        expect(await authorizeChannelMediaRoom(OWNER, live, SERVER)).toMatchObject({ serverId: SERVER, channelType: 'voice' });
        expect(await channelLiveForMedia(live, SERVER)).toBe(true);
        expect(await channelLiveForMedia(expired, SERVER)).toBe(false);
      } finally {
        clock.mockRestore();
      }
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

  describe('stage mutations held on the roster lock across expiry', () => {
    // The access check runs before the lock; the channel expires while the
    // mutation waits for it. The mutation must be refused inside the lock and
    // leave the roster unchanged (not applied, then published).
    const roster = async (ch: string) => (isRedisAvailable()
      ? await cache.getAuthoritative<{ speakers: Array<{ userId: string }>; listeners: Array<{ userId: string }>; topic: string; live: boolean }>(`stage:room:${ch}`)
      : stageRooms.get(ch)) ?? null;
    const mutations: Array<{ event: string; payload: (ch: string) => unknown; rejected: unknown }> = [
      { event: 'stage:setRole', payload: ch => ({ channelId: ch, role: 'speaker' }), rejected: { ok: false, code: 'STAGE_ROLE_REJECTED' } },
      { event: 'stage:setTopic', payload: ch => ({ channelId: ch, topic: 'written after expiry' }), rejected: { ok: false, code: 'STAGE_ACTION_REJECTED' } },
      { event: 'stage:setLive', payload: ch => ({ channelId: ch, live: true }), rejected: { ok: false, code: 'STAGE_ACTION_REJECTED' } },
      { event: 'stage:promote', payload: ch => ({ channelId: ch, targetUserId: PEER }), rejected: { ok: false, code: 'STAGE_ACTION_REJECTED' } },
    ];
    for (const mutation of mutations) {
      it(`${mutation.event} that waited on the lock while the stage expired is refused and not applied`, async () => {
        const ch = await channel('stage');
        const host = await connect(OWNER);
        const listener = await connect(PEER);
        expect(await call(host.client, 'stage:join', { channelId: ch })).toMatchObject({ ok: true });
        expect(await call(host.client, 'stage:setRole', { channelId: ch, role: 'speaker' })).toEqual({ ok: true });
        expect(await call(listener.client, 'stage:join', { channelId: ch })).toMatchObject({ ok: true });
        expect(await call(listener.client, 'stage:setRole', { channelId: ch, role: 'listener' })).toEqual({ ok: true });
        const before = JSON.stringify(await roster(ch));

        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        let locked!: () => void;
        const lockTaken = new Promise<void>(resolve => { locked = resolve; });
        const holder = cache.withKeyLock(`stage-room:${ch}`, async () => { locked(); await held; },
          { leaseSeconds: 10, waitMs: 10_000 });
        await lockTaken;
        // setRole by the listener; the other three by the host.
        const actor = mutation.event === 'stage:setRole' ? listener.client : host.client;
        const pending = call(actor, mutation.event, mutation.payload(ch));
        await new Promise(r => setTimeout(r, 150));   // the pre-lock access check has passed
        await expire(ch);
        release();
        await holder;
        expect(await pending).toEqual(mutation.rejected);
        expect(JSON.stringify(await roster(ch))).toBe(before);
      });
    }
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

  describe('the expiry instant (no expiry worker runs in this suite)', () => {
    /** A live channel whose expiresAt is `inMs` after the DATABASE clock; returns when that is on this process's monotonic clock. */
    async function expiringSoon(inMs: number): Promise<{ id: string; expiresAtLocal: number }> {
      const id = `${P}-voice-soon-${++seq}`;
      const sentAt = performance.now();
      const [row] = await q(
        `INSERT INTO channels (_id,"serverId",name,type,"createdAt","expiresAt","expiryVersion")
         VALUES ($1,$2,$1,'voice',1,FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT + $3,1)
         RETURNING "expiresAt", FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT AS "dbNow"`,
        [id, SERVER, inMs]);
      return { id, expiresAtLocal: sentAt + (Number(row.expiresAt) - Number(row.dbNow)) };
    }
    const until = (localDeadline: number) => new Promise(r => setTimeout(r, Math.max(0, localDeadline - performance.now())));

    it('live voice is evicted when expiresAt passes, not when a worker later claims the channel', async () => {
      const { id: ch, expiresAtLocal } = await expiringSoon(1_500);
      const a = await connect(OWNER);
      const b = await connect(PEER);
      expect(await voiceJoin(a.client, ch)).toEqual(['voice:joined']);
      expect(await voiceJoin(b.client, ch)).toEqual(['voice:joined']);
      expect(__armedMediaExpiryForTest()).toContain(ch);
      const evicted = { a: record(a.client, ['voice:evicted']), b: record(b.client, ['voice:evicted']) };
      const capture = captureActualLogRecords();
      try {
        // Still live shortly before the instant: nobody is evicted early.
        await until(expiresAtLocal - 250);
        expect([evicted.a.length, evicted.b.length]).toEqual([0, 0]);
        expect((await __getVoiceRoomForTest(ch)).map(p => p.userId).sort()).toEqual([OWNER, PEER].sort());

        // Shortly after it, both are out: told, off the roster, out of the room.
        await until(expiresAtLocal + 750);
        expect(evicted.a.map(e => e.payload)).toEqual([{ channelId: ch }]);
        expect(evicted.b.map(e => e.payload)).toEqual([{ channelId: ch }]);
        expect(await __getVoiceRoomForTest(ch)).toEqual([]);
        for (const side of [a, b]) {
          expect(side.server.rooms.has(`voice:${ch}`)).toBe(false);
          expect(side.server.currentVoiceChannel ?? null).toBeNull();
        }
        const events = new Set(['socket.voice_evicted', 'socket.voice_access_evicted',
          'socket.voice_publish_revoked', 'socket.channel_access_evicted', 'media.expiry_evicted']);
        const info = capture.records.filter(row => row.level === 30 && events.has(String(row.event)));
        expect(info).toEqual(expect.arrayContaining([
          expect.objectContaining({ event: 'media.expiry_evicted' }),
          expect.objectContaining({ event: 'socket.channel_access_evicted' }),
        ]));
        for (const row of info) {
          // This harness admits voice without an outer request scope. The
          // background timer must not invent one; per-socket eviction does
          // establish its own scope in the production coordinator.
          if (row.event === 'media.expiry_evicted') expect(row).not.toHaveProperty('requestId');
          else expect(row).toHaveProperty('requestId', expect.any(String));
          for (const field of ['userId', 'socketId', 'channelId', 'serverId']) expect(row).not.toHaveProperty(field);
          for (const value of [OWNER, PEER, ch, SERVER, a.client.id!, b.client.id!]) {
            expect(JSON.stringify(row)).not.toContain(value);
          }
        }
      } finally { capture.restore(); }
    });

    it('a request-scoped expiry timer keeps correlation without its inherited actor', async () => {
      const ch = await channel('voice', 'permanent');
      const a = await connect(OWNER);
      expect(await voiceJoin(a.client, ch)).toEqual(['voice:joined']);
      expect(__armedMediaExpiryForTest()).not.toContain(ch);
      const sentAt = performance.now();
      const [row] = await q(`UPDATE channels SET
        "expiresAt" = FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT + 1000,
        "expiryVersion" = "expiryVersion" + 1 WHERE _id = $1
        RETURNING "expiresAt", FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT AS "dbNow"`, [ch]);
      const expiresAtLocal = sentAt + Number(row.expiresAt) - Number(row.dbNow);
      const original = { requestId: 'pg-media-expiry-correlation', userId: OWNER,
        socketId: 'private-initial-socket', memo: new Map<string, unknown>() };
      const evicted = record(a.client, ['voice:evicted']);
      const capture = captureActualLogRecords();
      try {
        // Arm the actual timer in the scope, rather than merely inserting the
        // channel there: network events do not inherit the test caller's ALS.
        await runWithRequestContext(original, async () => {
          await armMediaExpiryEviction(io, ch, SERVER);
          expect(currentRequestContext()).toBe(original);
        });
        expect(__armedMediaExpiryForTest()).toContain(ch);
        await until(expiresAtLocal + 750);
        expect(evicted.map(event => event.payload)).toEqual([{ channelId: ch }]);
        expect(await __getVoiceRoomForTest(ch)).toEqual([]);
        expect(a.server.rooms.has(`voice:${ch}`)).toBe(false);
        const terminal = capture.records.filter(record => record.event === 'media.expiry_evicted');
        expect(terminal).toHaveLength(1);
        expect(terminal[0]).toMatchObject({ level: 30, requestId: original.requestId });
        for (const field of ['userId', 'socketId', 'channelId', 'serverId']) expect(terminal[0]).not.toHaveProperty(field);
        for (const value of [OWNER, ch, SERVER, original.socketId]) expect(JSON.stringify(terminal[0])).not.toContain(value);
      } finally { capture.restore(); }
    });

    it('an expiry moved later before the instant re-arms instead of evicting (positive control)', async () => {
      const { id: ch, expiresAtLocal } = await expiringSoon(1_000);
      const a = await connect(OWNER);
      expect(await voiceJoin(a.client, ch)).toEqual(['voice:joined']);
      const evicted = record(a.client, ['voice:evicted']);
      await q(`UPDATE channels SET "expiresAt" = "expiresAt" + $2, "expiryVersion" = "expiryVersion" + 1 WHERE _id = $1`, [ch, HOUR]);
      await until(expiresAtLocal + 750);
      expect(evicted).toEqual([]);
      expect((await __getVoiceRoomForTest(ch)).map(p => p.userId)).toEqual([OWNER]);
      expect(__armedMediaExpiryForTest()).toContain(ch);   // re-armed for the new expiry
    });

    it('a relay just after expiresAt is refused even though liveness was confirmed just before it', async () => {
      const { id: ch, expiresAtLocal } = await expiringSoon(1_200);
      const a = await connect(OWNER);
      const b = await connect(PEER);
      expect(await voiceJoin(a.client, ch)).toEqual(['voice:joined']);
      expect(await voiceJoin(b.client, ch)).toEqual(['voice:joined']);
      // Isolate the relay check from the expiry-instant eviction above.
      __resetMediaExpiryEvictionForTest();
      const received = record(b.client, ['webrtc:offer']);
      const offer = () => call(a.client, 'webrtc:offer', { targetSocketId: b.client.id, offer: { sdp: 'v=0', type: 'offer' }, channelId: ch });

      await offer();                                   // live: delivered, and liveness confirmed
      const confirmedAt = performance.now();
      await new Promise(r => setTimeout(r, 50));
      expect(received).toHaveLength(1);
      expect(expiresAtLocal - confirmedAt).toBeGreaterThan(0);

      await until(expiresAtLocal + 150);
      // Well inside the two-second reuse window of that confirmation…
      expect(performance.now() - confirmedAt).toBeLessThan(2_000);
      await offer();
      await new Promise(r => setTimeout(r, 50));
      // …yet past expiresAt: refused, and the sender is dropped.
      expect(received).toHaveLength(1);
      expect((await __getVoiceRoomForTest(ch)).map(p => p.userId)).not.toContain(OWNER);
      expect(a.server.rooms.has(`voice:${ch}`)).toBe(false);
    });

    // Two Bridge nodes need a shared Redis; in-memory mode has no cluster. CI's
    // PG job always sets REDIS_TEST_URL and rejects skipped tests there.
    (REDIS_TEST_URL ? it : it.skip)('multi-node: the expiry timer on node A evicts a member whose socket is on node B', async () => {
      const { id: ch, expiresAtLocal } = await expiringSoon(1_500);
      const a = await connect(OWNER);
      const b = await connect(PEER, urlB);
      expect(await voiceJoin(a.client, ch)).toEqual(['voice:joined']);
      expect(await voiceJoin(b.client, ch)).toEqual(['voice:joined']);
      expect((await __getVoiceRoomForTest(ch)).map(p => p.userId).sort()).toEqual([OWNER, PEER].sort());
      // Only node A holds the timer: node B's member is reached through the
      // Redis adapter (remote fetchSockets) and the cluster eviction event.
      __resetMediaExpiryEvictionForTest();
      await armMediaExpiryEviction(io, ch, SERVER);
      const evictedB = record(b.client, ['voice:evicted']);

      await until(expiresAtLocal - 250);
      expect(evictedB).toEqual([]);
      await until(expiresAtLocal + 1_000);
      expect(evictedB.map(e => e.payload)).toEqual([{ channelId: ch }]);
      expect(b.server.rooms.has(`voice:${ch}`)).toBe(false);
      expect(b.server.currentVoiceChannel ?? null).toBeNull();
      expect(await __getVoiceRoomForTest(ch)).toEqual([]);
    });

    it('Stage and permanent channels: a live stage arms one timer, a permanent channel none', async () => {
      const stage = await channel('stage');
      const permanent = await channel('voice', 'permanent');
      const { client } = await connect();
      expect(await call(client, 'stage:join', { channelId: stage })).toMatchObject({ ok: true });
      expect(await voiceJoin(client, permanent)).toEqual(['voice:joined']);
      expect(__armedMediaExpiryForTest()).toEqual([stage]);
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
