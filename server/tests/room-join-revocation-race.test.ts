// server/tests/room-join-revocation-race.test.ts
//
// A stage, canvas or draw-together join that is still in flight when the user
// loses access must not end in the room.
//
// Each join checks access first and joins its Socket.IO room later:
//   - `stage:join` reads (or creates) the stage room under its lock;
//   - `canvas:join` counts the room's sockets and reads the strokes;
//   - `draw:join` waits for the draw session lock and adds the participant.
// Revocations (kick, ban, leave, a VIEW change) find live sessions through
// those rooms. One that runs in between finds nothing to evict, and the join
// then completes: the user is sent the stage roster, the canvas strokes or the
// drawing, and keeps receiving every later update in that channel.
//
// Real Socket.IO server and clients, the real handlers, the real revocation
// paths (lib/liveMembership, socket/voiceEviction) and the real permission
// resolver on the in-memory DB. Only one await of the join is held, so the
// revocation lands exactly in that window every run.
process.env.NODE_ENV = 'test';

jest.mock('../music', () => ({ readMusicQueue: jest.fn(async () => ({ current: null, queue: [] })) }));
jest.mock('../lib/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
// eslint-disable-next-line no-var
var vdb: ReturnType<typeof import('./helpers/mockDb').createMockDb>;
jest.mock('../db/loader', () => {
  const { createMockDb } = require('./helpers/mockDb');
  vdb = createMockDb();
  return vdb;
});
jest.mock('../db/index', () => require('../db/loader'));

import { createServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { Server as IOServer, type Socket as ServerSocket } from 'socket.io';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import { registerVoiceHandlers, __setVoiceRoomForTest } from '../socket/handlers/voice';
import { registerStageHandlers } from '../socket/handlers/stage';
import { registerCanvasHandlers } from '../socket/handlers/canvas';
import { registerDrawTogetherHandlers, drawSessions } from '../socket/handlers/activities/draw-together';
import { evictLocalVoiceSessions } from '../socket/voiceEviction';
import { evictSocketsWithoutChannelAccess, evictUserFromServerRooms, registerLocalVoiceEvictor } from '../lib/liveMembership';
import { cache } from '../lib/redisAdapter';
import { invalidatePerms } from '../lib/permCache';
import { Members } from '../db/repositories';
import * as permissions from '../lib/permissions';
import { PERMS } from '../lib/permissions';
import { deferred } from './helpers/deferred';

const SRV = 'srv-rooms';
const STAGE = 'st-race';
const TEXT = 'tc-race';
const VC = 'vc-race';

type Received = Array<{ event: string; data: unknown }>;

let http: HttpServer;
let io: IOServer;
let url: string;
const serverSockets = new Map<string, ServerSocket>();
const clients: ClientSocket[] = [];

beforeAll(async () => {
  http = createServer();
  io = new IOServer(http);
  io.on('connection', (socket) => {
    const userId = String(socket.handshake.auth.userId);
    const user = { _id: userId, displayName: userId, avatarColor: '#fff' };
    socket.data.userId = userId;
    void socket.join([`user:${userId}`, `server:${SRV}`]);
    serverSockets.set(userId, socket);
    registerVoiceHandlers(socket as never, io as never, user);
    registerStageHandlers(socket as never, io as never, user as never);
    registerCanvasHandlers(socket as never, io as never, user as never);
    registerDrawTogetherHandlers(socket as never, io as never, user);
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  registerLocalVoiceEvictor(evictLocalVoiceSessions);
});

afterAll(async () => {
  registerLocalVoiceEvictor(null);
  await io.close();
});

beforeEach(async () => {
  await vdb.servers.insert({ _id: SRV, name: 'S', ownerId: 'owner', createdAt: 1 });
  await vdb.channels.insert({ _id: STAGE, serverId: SRV, name: 'stage', type: 'stage', createdAt: 1 });
  await vdb.channels.insert({ _id: TEXT, serverId: SRV, name: 'text', type: 'text', createdAt: 1 });
  await vdb.channels.insert({ _id: VC, serverId: SRV, name: 'voice', type: 'voice', createdAt: 1 });
  for (const userId of ['alice', 'bob']) await vdb.members.insert({ userId, serverId: SRV, roles: [], joinedAt: 1 });
  invalidatePerms(SRV);
});

// In tests every `cache` method is a jest.fn around the real implementation
// (lib/redisAdapter.ts); hold a lock by swapping that implementation.
const lockMock = cache.withKeyLock as unknown as jest.Mock;
const realWithKeyLock = lockMock.getMockImplementation()!;

afterEach(async () => {
  jest.restoreAllMocks();
  lockMock.mockImplementation(realWithKeyLock);
  for (const client of clients.splice(0)) client.close();
  serverSockets.clear();
  await __setVoiceRoomForTest(VC, []);
  drawSessions.clear();
  vdb._reset();
  invalidatePerms(SRV);
});

async function connect(userId: string): Promise<{ client: ClientSocket; received: Received }> {
  const client = ioc(url, { transports: ['websocket'], reconnection: false, auth: { userId } });
  clients.push(client);
  const received: Received = [];
  client.onAny((event: string, data: unknown) => { received.push({ event, data }); });
  await new Promise<void>((resolve, reject) => { client.once('connect', () => resolve()); client.once('connect_error', reject); });
  while (!serverSockets.has(userId)) await new Promise((r) => setImmediate(r));
  return { client, received };
}

/** Hold the next lock on `key` until `release` is called. */
function holdNextLock(key: string) {
  const reached = deferred<void>();
  const release = deferred<void>();
  let held = false;
  lockMock.mockImplementation(async (k: string, fn: () => Promise<unknown>, options?: object) => {
    if (!held && k === key) {
      held = true;
      reached.resolve();
      await release.promise;
    }
    return realWithKeyLock(k, fn, options);
  });
  return { reached: reached.promise, release: () => release.resolve() };
}

/** Hold the canvas join's room count (`io.in('canvas:<id>').fetchSockets()`). */
function holdNextCanvasCount(channelId: string) {
  const reached = deferred<void>();
  const release = deferred<void>();
  const realIn = io.in.bind(io);
  let held = false;
  jest.spyOn(io, 'in').mockImplementation(((room: string) => {
    const target = realIn(room);
    if (held || room !== `canvas:${channelId}`) return target;
    held = true;
    return {
      fetchSockets: async () => {
        reached.resolve();
        await release.promise;
        return target.fetchSockets();
      },
    } as unknown as ReturnType<typeof realIn>;
  }) as typeof io.in);
  return { reached: reached.promise, release: () => release.resolve() };
}

/**
 * Hold the second access read for (userId, channelId) counted from now (the
 * join's re-check, the first being its initial check) once it has its result,
 * so a revocation lands after the re-check has read the old permissions.
 * `canViewChannel` resolves permissions inside lib/permissions, so the draw
 * join is held there; the stage and canvas joins call `resolvePermissions`.
 */
function holdRecheckOf(userId: string, channelId: string, via: 'resolvePermissions' | 'canViewChannel' = 'resolvePermissions') {
  const reached = deferred<void>();
  const release = deferred<void>();
  const real = permissions[via] as (...args: unknown[]) => Promise<unknown>;
  let calls = 0;
  jest.spyOn(permissions, via).mockImplementation((async (...args: unknown[]) => {
    const result = await real(...args);
    if (args[0] === userId && args[2] === channelId && ++calls === 2) {
      reached.resolve();
      await release.promise;
    }
    return result;
  }) as never);
  return { reached: reached.promise, release: () => release.resolve() };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 10));
}

async function kick(userId: string): Promise<void> {
  // The kick route's order: remove the membership, drop cached permissions, evict live sockets.
  expect((await Members.removeMember(userId, SRV))?.deleted).toBe(1);
  invalidatePerms(SRV, userId);
  await evictUserFromServerRooms(io, userId, SRV);
}

async function revokeView(channelId: string): Promise<void> {
  // The override route's order: write the override, drop cached permissions, re-check live sockets.
  await vdb.channelOverrides.insert({
    _id: `ovr-no-view-${channelId}`, channelId, targetType: 'everyone', targetId: SRV, allow: 0, deny: PERMS.VIEW_CHANNELS, position: 0,
  });
  invalidatePerms(SRV, null, channelId);
  await evictSocketsWithoutChannelAccess(io, SRV, channelId);
}

function stageJoin(client: ClientSocket, channelId = STAGE): Promise<{ ok: boolean; code?: string }> {
  return new Promise((resolve) => client.emit('stage:join', { channelId }, resolve));
}

async function joinVoice(user: { client: ClientSocket }): Promise<void> {
  const joined = new Promise<void>((resolve) => user.client.once('voice:joined', () => resolve()));
  user.client.emit('voice:join', { channelId: VC, serverId: SRV });
  await joined;
}

const events = (r: Received) => r.map((e) => e.event);

// ── stage ───────────────────────────────────────────────────────────────────
describe('stage:join while access is revoked', () => {
  it.each([
    ['kicked from the server', () => kick('alice')],
    ['VIEW revoked on the stage channel', () => revokeView(STAGE)],
  ])('%s during the room read: refused, and no stage state is sent', async (_label, revoke) => {
    const alice = await connect('alice');
    const lock = holdNextLock(`stage-room:${STAGE}`);
    const result = stageJoin(alice.client);
    await lock.reached;
    await revoke();
    lock.release();

    expect(await result).toEqual({ ok: false, code: 'STAGE_UNAVAILABLE' });
    await settle();
    expect(serverSockets.get('alice')!.rooms.has(`stage:${STAGE}`)).toBe(false);
    expect(events(alice.received)).not.toContain('stage:state');
  });

  it('kicked while the re-check is reading: the eviction wins and the join is refused', async () => {
    const alice = await connect('alice');
    const recheck = holdRecheckOf('alice', STAGE);
    const result = stageJoin(alice.client);
    await recheck.reached;            // in the room, and the re-check has already read "allowed"
    await kick('alice');
    recheck.release();

    expect(await result).toEqual({ ok: false, code: 'STAGE_UNAVAILABLE' });
    await settle();
    expect(serverSockets.get('alice')!.rooms.has(`stage:${STAGE}`)).toBe(false);
    expect(events(alice.received)).not.toContain('stage:state');
  });

  it('CONTROL: with no revocation the held join completes', async () => {
    const alice = await connect('alice');
    const lock = holdNextLock(`stage-room:${STAGE}`);
    const result = stageJoin(alice.client);
    await lock.reached;
    lock.release();

    expect(await result).toEqual(expect.objectContaining({ ok: true }));
    expect(serverSockets.get('alice')!.rooms.has(`stage:${STAGE}`)).toBe(true);
    expect(events(alice.received)).toContain('stage:state');
  });
});

// ── canvas ──────────────────────────────────────────────────────────────────
describe('canvas:join while access is revoked', () => {
  it.each([
    ['kicked from the server', () => kick('alice')],
    ['VIEW revoked on the channel', () => revokeView(TEXT)],
  ])('%s during the room count: refused, and no strokes are sent', async (_label, revoke) => {
    const alice = await connect('alice');
    const count = holdNextCanvasCount(TEXT);
    alice.client.emit('canvas:join', { channelId: TEXT });
    await count.reached;
    await revoke();
    count.release();

    await settle();
    expect(serverSockets.get('alice')!.rooms.has(`canvas:${TEXT}`)).toBe(false);
    expect(events(alice.received)).not.toContain('canvas:state-sync');
    expect(alice.received).toContainEqual({ event: 'error', data: { event: 'canvas:join', message: 'Bu kanala erişim yetkiniz yok.' } });
  });

  it('a refused join grants nothing: with access back, drawing without a new join is refused', async () => {
    const bob = await connect('bob');
    bob.client.emit('canvas:join', { channelId: TEXT });
    await settle();
    const alice = await connect('alice');
    const count = holdNextCanvasCount(TEXT);
    alice.client.emit('canvas:join', { channelId: TEXT });
    await count.reached;
    await kick('alice');
    count.release();
    await settle();

    // She is let back in but never completes a new canvas:join.
    await vdb.members.insert({ userId: 'alice', serverId: SRV, roles: [], joinedAt: 2 });
    invalidatePerms(SRV, 'alice');
    alice.client.emit('canvas:draw', { channelId: TEXT, stroke: { id: 's1', tool: 'pen', points: [{ x: 1, y: 1 }] } });
    await settle();
    expect(bob.received.filter((r) => r.event === 'canvas:draw')).toEqual([]);
  });

  it('kicked while the re-check is reading: the eviction wins, no strokes are sent', async () => {
    const alice = await connect('alice');
    const recheck = holdRecheckOf('alice', TEXT);
    alice.client.emit('canvas:join', { channelId: TEXT });
    await recheck.reached;
    await kick('alice');
    recheck.release();

    await settle();
    expect(serverSockets.get('alice')!.rooms.has(`canvas:${TEXT}`)).toBe(false);
    expect(events(alice.received)).not.toContain('canvas:state-sync');
    expect(alice.received).toContainEqual({ event: 'error', data: { event: 'canvas:join', message: 'Bu kanala erişim yetkiniz yok.' } });
  });

  it('the user leaves during the re-check: no error and no strokes', async () => {
    const alice = await connect('alice');
    const recheck = holdRecheckOf('alice', TEXT);
    alice.client.emit('canvas:join', { channelId: TEXT });
    await recheck.reached;
    alice.client.emit('canvas:leave', { channelId: TEXT });
    const socket = serverSockets.get('alice')!;
    for (let i = 0; i < 200 && socket.rooms.has(`canvas:${TEXT}`); i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(socket.rooms.has(`canvas:${TEXT}`)).toBe(false);
    recheck.release();

    await settle();
    expect(socket.rooms.has(`canvas:${TEXT}`)).toBe(false);
    expect(events(alice.received)).not.toContain('error');
    expect(events(alice.received)).not.toContain('canvas:state-sync');
  });

  it('CONTROL: with no revocation the held join completes', async () => {
    const alice = await connect('alice');
    const count = holdNextCanvasCount(TEXT);
    alice.client.emit('canvas:join', { channelId: TEXT });
    await count.reached;
    count.release();

    await settle();
    expect(serverSockets.get('alice')!.rooms.has(`canvas:${TEXT}`)).toBe(true);
    expect(events(alice.received)).toContain('canvas:state-sync');
  });
});

// ── draw-together ───────────────────────────────────────────────────────────
describe('draw:join while access is revoked', () => {
  it.each([
    ['kicked from the server', () => kick('alice')],
    ['VIEW revoked on the channel', () => revokeView(VC)],
  ])('%s during the session lock: refused, the session forgets the user and nobody is told', async (_label, revoke) => {
    const bob = await connect('bob');
    await joinVoice(bob);
    bob.client.emit('draw:join', { channelId: VC, sessionId: 'draw-1' });
    await settle();
    expect(drawSessions.get(VC)?.participants.size).toBe(1);
    const alice = await connect('alice');
    await joinVoice(alice);

    const lock = holdNextLock(`draw-session:${VC}`);
    alice.client.emit('draw:join', { channelId: VC, sessionId: 'draw-1' });
    await lock.reached;
    await revoke();
    lock.release();

    await settle();
    const socket = serverSockets.get('alice')!;
    expect(socket.rooms.has(`draw:${VC}`)).toBe(false);
    expect([...(drawSessions.get(VC)?.participants.keys() ?? [])]).not.toContain(socket.id);
    expect(events(alice.received)).not.toContain('draw:state');
    expect(bob.received.filter((r) => r.event === 'draw:participant-joined')).toEqual([]);
  });

  it('kicked while the re-check is reading: the eviction wins and the session forgets the user', async () => {
    const bob = await connect('bob');
    await joinVoice(bob);
    bob.client.emit('draw:join', { channelId: VC, sessionId: 'draw-1' });
    await settle();
    const alice = await connect('alice');
    await joinVoice(alice);

    const recheck = holdRecheckOf('alice', VC, 'canViewChannel');
    alice.client.emit('draw:join', { channelId: VC, sessionId: 'draw-1' });
    await recheck.reached;
    await kick('alice');
    recheck.release();

    await settle();
    const socket = serverSockets.get('alice')!;
    expect(socket.rooms.has(`draw:${VC}`)).toBe(false);
    expect([...(drawSessions.get(VC)?.participants.keys() ?? [])]).not.toContain(socket.id);
    expect(events(alice.received)).not.toContain('draw:state');
    expect(bob.received.filter((r) => r.event === 'draw:participant-joined')).toEqual([]);
  });

  it('CONTROL: with no revocation the held join completes and the other participant is told', async () => {
    const bob = await connect('bob');
    await joinVoice(bob);
    bob.client.emit('draw:join', { channelId: VC, sessionId: 'draw-1' });
    await settle();
    const alice = await connect('alice');
    await joinVoice(alice);

    const lock = holdNextLock(`draw-session:${VC}`);
    alice.client.emit('draw:join', { channelId: VC, sessionId: 'draw-1' });
    await lock.reached;
    lock.release();

    await settle();
    expect(serverSockets.get('alice')!.rooms.has(`draw:${VC}`)).toBe(true);
    expect(events(alice.received)).toContain('draw:state');
    expect(bob.received.filter((r) => r.event === 'draw:participant-joined').map((r) => (r.data as { userId: string }).userId)).toEqual(['alice']);
  });
});
