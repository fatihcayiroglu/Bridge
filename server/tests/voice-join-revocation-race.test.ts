// server/tests/voice-join-revocation-race.test.ts
//
// A voice join that is still in flight when the user loses access must not end
// in the room.
//
// Both joins check access first and admit later:
//   - `voice:join` (P2P) waits for the room's roster lock, then joins the
//     Socket.IO room and records `currentVoiceChannel`;
//   - `sfu:join` asks the cluster registry whether the room is local (and may
//     create the router), then registers the SFU peer and joins the room.
// Every revocation path (kick, ban, leave, a CONNECT or VIEW change) finds
// voice sessions through exactly that room, that field and that peer. A
// revocation that runs in between finds nothing to evict, and the join then
// completes for a user who no longer has access: listed in the roster, told
// who the other peers are, announced to them, and kept until they leave.
//
// Real Socket.IO server and clients, the real voice and SFU handlers, the real
// revocation paths (lib/liveMembership, socket/voiceEviction) and the real
// permission resolver on the in-memory DB. mediasoup, the cluster registry and
// ICE config are stubbed as in mediasoup-handlers.test.ts. Only one await of
// the join is held, so the revocation lands exactly in that window every run.
process.env.NODE_ENV = 'test';

jest.mock('../music', () => ({ readMusicQueue: jest.fn(async () => ({ current: null, queue: [] })) }));
jest.mock('../lib/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
const mediasoupStub = {
  createWorker: jest.fn(async () => ({
    _id: 'w1', close: jest.fn(), on: jest.fn(),
    createRouter: jest.fn(async () => ({
      rtpCapabilities: { codecs: [{ kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 }], headerExtensions: [] },
      canConsume: jest.fn(() => true), createWebRtcTransport: jest.fn(), close: jest.fn(), on: jest.fn(),
    })),
  })),
};
jest.mock('mediasoup', () => mediasoupStub, { virtual: true });
jest.mock('../lib/sfuRegistry', () => ({
  INSTANCE_ID: 'test-node', ROOM_LEASE_TTL_SECONDS: 3600, NODE_LEASE_MS: 30_000, NODE_HEARTBEAT_MS: 10_000,
  isLocalRoom: jest.fn(async () => true),
  getRoomOwner: jest.fn(async () => null),
  claimRoom: jest.fn(async () => ({ owned: true, owner: 'test-node' })),
  releaseRoom: jest.fn(async () => {}),
  refreshRoom: jest.fn(async () => true),
}));
jest.mock('../lib/turnConfig', () => ({ getRtcIceConfig: jest.fn(() => ({ iceServers: [], iceTransportPolicy: 'all' })) }));
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
import { registerVoiceHandlers, __getVoiceRoomForTest, __setVoiceRoomForTest } from '../socket/handlers/voice';
import { evictLocalVoiceSessions } from '../socket/voiceEviction';
import { evictSocketsWithoutChannelAccess, evictUserFromServerRooms, registerLocalVoiceEvictor } from '../lib/liveMembership';
import { cache } from '../lib/redisAdapter';
import { invalidatePerms } from '../lib/permCache';
import { Members } from '../db/repositories';
import * as permissions from '../lib/permissions';
import { PERMS } from '../lib/permissions';
import { deferred } from './helpers/deferred';
import * as sfuRegistry from '../lib/sfuRegistry';
import * as stage from '../socket/handlers/stage';
import { registerSFUHandlers } from '../socket/handlers/mediasoup/index';
import { initMediasoup, _resetWorkersForTest, _setMediasoupForTest } from '../socket/handlers/mediasoup/workers';
import { sfuPeers, sfuRooms, _resetRoomsForTest } from '../socket/handlers/mediasoup/rooms';
import type { BridgeIO, BridgeSocket, MediasoupModule } from '../socket/handlers/mediasoup/types';

const SRV = 'srv-race';
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
    socket.data.userId = userId;
    void socket.join([`user:${userId}`, `server:${SRV}`, `channel:${VC}`]);
    serverSockets.set(userId, socket);
    registerVoiceHandlers(socket as never, io as never, { _id: userId, displayName: userId, avatarColor: '#fff' });
    registerSFUHandlers(socket as unknown as BridgeSocket, io as unknown as BridgeIO, { _id: userId, displayName: userId, avatarColor: '#fff' });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  registerLocalVoiceEvictor(evictLocalVoiceSessions);
  _resetWorkersForTest();
  _setMediasoupForTest(mediasoupStub as unknown as MediasoupModule);
  await initMediasoup();
});

afterAll(async () => {
  registerLocalVoiceEvictor(null);
  await io.close();
});

beforeEach(async () => {
  await vdb.servers.insert({ _id: SRV, name: 'S', ownerId: 'owner', createdAt: 1 });
  await vdb.channels.insert({ _id: VC, serverId: SRV, name: 'voice', type: 'voice', createdAt: 1 });
  for (const userId of ['alice', 'bob']) await vdb.members.insert({ userId, serverId: SRV, roles: [], joinedAt: 1 });
  invalidatePerms(SRV);
});

afterEach(async () => {
  jest.restoreAllMocks();
  lockMock.mockImplementation(realWithKeyLock);
  for (const client of clients.splice(0)) client.close();
  serverSockets.clear();
  await __setVoiceRoomForTest(VC, []);
  _resetRoomsForTest();
  vdb._reset();
  invalidatePerms(SRV);
});

async function connect(userId: string): Promise<{ client: ClientSocket; received: Received }> {
  const client = ioc(url, { transports: ['websocket'], reconnection: false, auth: { userId } });
  clients.push(client);
  const received: Received = [];
  client.onAny((event: string, data: unknown) => { received.push({ event, data }); });
  await new Promise<void>((resolve, reject) => { client.once('connect', () => resolve()); client.once('connect_error', reject); });
  // The server registers its handlers on connection; wait until that socket exists.
  while (!serverSockets.has(userId)) await new Promise((r) => setImmediate(r));
  return { client, received };
}

function outcome(client: ClientSocket): Promise<'joined' | 'rejected'> {
  return new Promise((resolve) => {
    client.once('voice:joined', () => resolve('joined'));
    client.once('voice:join-rejected', () => resolve('rejected'));
  });
}

// In tests every `cache` method is a jest.fn around the real implementation
// (lib/redisAdapter.ts); hold the lock by swapping that implementation.
const lockMock = cache.withKeyLock as unknown as jest.Mock;
const realWithKeyLock = lockMock.getMockImplementation()!;

/** Hold the next roster mutation of the channel until `release` is called. */
function holdNextRosterLock(channelId: string) {
  const reached = deferred<void>();
  const release = deferred<void>();
  let held = false;
  lockMock.mockImplementation(async (key: string, fn: () => Promise<unknown>, options?: object) => {
    if (!held && key === `voice-room:${channelId}`) {
      held = true;
      reached.resolve();
      await release.promise;
    }
    return realWithKeyLock(key, fn, options);
  });
  return { reached: reached.promise, release: () => release.resolve() };
}

/**
 * Hold the voice handler's second permission read for `userId` (the re-check
 * after admission) once it has its result, so a revocation lands after the
 * re-check has read the old permissions.
 */
function holdRecheckOf(userId: string) {
  const reached = deferred<void>();
  const release = deferred<void>();
  const real = permissions.resolvePermissions;
  let calls = 0;
  jest.spyOn(permissions, 'resolvePermissions').mockImplementation(async (...args: Parameters<typeof real>) => {
    const result = await real(...args);
    if (args[0] === userId && args[2] === VC && ++calls === 2) {
      reached.resolve();
      await release.promise;
    }
    return result;
  });
  return { reached: reached.promise, release: () => release.resolve() };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 10));
}

async function bobInTheRoom() {
  const bob = await connect('bob');
  const joined = outcome(bob.client);
  bob.client.emit('voice:join', { channelId: VC, serverId: SRV });
  expect(await joined).toBe('joined');
  return bob;
}

async function rosterIds(): Promise<string[]> {
  return (await __getVoiceRoomForTest(VC)).map((p) => p.userId).sort();
}

describe('access revoked while a voice join waits for the roster lock', () => {
  it('kicked from the server: the join does not complete and nobody is told the user joined', async () => {
    const bob = await bobInTheRoom();
    const alice = await connect('alice');
    const lock = holdNextRosterLock(VC);
    const result = outcome(alice.client);
    alice.client.emit('voice:join', { channelId: VC, serverId: SRV });
    await lock.reached;

    // The kick route's order: remove the membership, drop cached permissions, evict live sockets.
    expect((await Members.removeMember('alice', SRV))?.deleted).toBe(1);
    invalidatePerms(SRV, 'alice');
    await evictUserFromServerRooms(io, 'alice', SRV);
    lock.release();

    expect(await result).toBe('rejected');
    await settle();
    const socket = serverSockets.get('alice')! as ServerSocket & { currentVoiceChannel?: string | null };
    expect(await rosterIds()).toEqual(['bob']);
    expect(socket.rooms.has(`voice:${VC}`)).toBe(false);
    expect(socket.currentVoiceChannel ?? null).toBeNull();
    expect(alice.received.map((r) => r.event)).not.toContain('voice:existing-peers');
    expect(bob.received.filter((r) => r.event === 'voice:peer-joined')).toEqual([]);
  });

  it('CONNECT revoked on the channel (VIEW kept): the join does not complete', async () => {
    const bob = await bobInTheRoom();
    const alice = await connect('alice');
    const lock = holdNextRosterLock(VC);
    const result = outcome(alice.client);
    alice.client.emit('voice:join', { channelId: VC, serverId: SRV });
    await lock.reached;

    // The override route's order: write the override, drop cached permissions, re-check live sockets.
    await vdb.channelOverrides.insert({
      _id: 'ovr-no-connect', channelId: VC, targetType: 'everyone', targetId: SRV, allow: 0, deny: PERMS.CONNECT, position: 0,
    });
    invalidatePerms(SRV, null, VC);
    await evictSocketsWithoutChannelAccess(io, SRV, VC);
    lock.release();

    expect(await result).toBe('rejected');
    await settle();
    const socket = serverSockets.get('alice')!;
    expect(await rosterIds()).toEqual([]);         // bob lost CONNECT too, and was evicted
    expect(socket.rooms.has(`voice:${VC}`)).toBe(false);
    expect(socket.rooms.has(`channel:${VC}`)).toBe(true);   // VIEW kept: the text room stays
    expect(bob.received.filter((r) => r.event === 'voice:peer-joined')).toEqual([]);
  });

  it('revoked while the re-check is reading: the eviction wins and the client is told the join failed', async () => {
    const bob = await bobInTheRoom();
    const alice = await connect('alice');
    const recheck = holdRecheckOf('alice');
    const result = outcome(alice.client);
    alice.client.emit('voice:join', { channelId: VC, serverId: SRV });
    await recheck.reached;            // admitted, and the re-check has already read "allowed"

    expect((await Members.removeMember('alice', SRV))?.deleted).toBe(1);
    invalidatePerms(SRV, 'alice');
    await evictUserFromServerRooms(io, 'alice', SRV);
    recheck.release();

    expect(await result).toBe('rejected');
    await settle();
    expect(await rosterIds()).toEqual(['bob']);
    expect(serverSockets.get('alice')!.rooms.has(`voice:${VC}`)).toBe(false);
    expect(alice.received.map((r) => r.event)).toEqual(expect.arrayContaining(['voice:evicted']));
    expect(alice.received.map((r) => r.event)).not.toContain('voice:joined');
    expect(bob.received.filter((r) => r.event === 'voice:peer-joined')).toEqual([]);
  });

  it('the user leaves while the re-check is reading: no join result is sent and the user is not in the room', async () => {
    const bob = await bobInTheRoom();
    const alice = await connect('alice');
    const recheck = holdRecheckOf('alice');
    alice.client.emit('voice:join', { channelId: VC, serverId: SRV });
    await recheck.reached;

    alice.client.emit('voice:leave', { channelId: VC, serverId: SRV });
    for (let i = 0; i < 200 && (await rosterIds()).includes('alice'); i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(await rosterIds()).toEqual(['bob']);
    recheck.release();

    await settle();
    expect(await rosterIds()).toEqual(['bob']);
    expect(serverSockets.get('alice')!.rooms.has(`voice:${VC}`)).toBe(false);
    const events = alice.received.map((r) => r.event);
    expect(events).not.toContain('voice:joined');
    expect(events).not.toContain('voice:join-rejected');   // she left; no "forbidden" error
    expect(bob.received.filter((r) => r.event === 'voice:peer-joined')).toEqual([]);
  });

  it('CONTROL: with no revocation the held join completes and the peer is told', async () => {
    const bob = await bobInTheRoom();
    const alice = await connect('alice');
    const lock = holdNextRosterLock(VC);
    const result = outcome(alice.client);
    alice.client.emit('voice:join', { channelId: VC, serverId: SRV });
    await lock.reached;
    lock.release();

    expect(await result).toBe('joined');
    await settle();
    expect(await rosterIds()).toEqual(['alice', 'bob']);
    expect(serverSockets.get('alice')!.rooms.has(`voice:${VC}`)).toBe(true);
    expect(bob.received.filter((r) => r.event === 'voice:peer-joined').map((r) => (r.data as { userId: string }).userId)).toEqual(['alice']);
  });

  it('CONTROL: a user kicked before the join starts is rejected up front', async () => {
    const alice = await connect('alice');
    await Members.removeMember('alice', SRV);
    invalidatePerms(SRV, 'alice');
    const result = outcome(alice.client);
    alice.client.emit('voice:join', { channelId: VC, serverId: SRV });
    expect(await result).toBe('rejected');
    expect(await rosterIds()).toEqual([]);
  });
});

// ── SFU ─────────────────────────────────────────────────────────────────────
const RTP_CAPS = { codecs: [{ kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 }], headerExtensions: [] };

function sfuOutcome(client: ClientSocket): Promise<'joined' | string> {
  return new Promise((resolve) => {
    client.once('sfu:joined', () => resolve('joined'));
    client.on('sfu:error', (e: { operation: string; code: string }) => { if (e.operation === 'join') resolve(e.code); });
  });
}

/** Hold the next "is this room local?" registry read until `release` is called. */
function holdNextRoomLookup() {
  const reached = deferred<void>();
  const release = deferred<void>();
  (sfuRegistry.isLocalRoom as jest.Mock).mockImplementationOnce(async () => {
    reached.resolve();
    await release.promise;
    return true;
  });
  return { reached: reached.promise, release: () => release.resolve() };
}

async function bobInTheSfuRoom() {
  const bob = await connect('bob');
  const joined = sfuOutcome(bob.client);
  bob.client.emit('sfu:join', { channelId: VC, serverId: SRV, rtpCapabilities: RTP_CAPS });
  expect(await joined).toBe('joined');
  return bob;
}

const sfuUserIds = () => [...(sfuRooms.get(VC)?.peers.values() ?? [])].map((p) => p.userId).sort();

describe('access revoked while an SFU join is in flight', () => {
  it('kicked from the server: the join is refused and the peer is not told', async () => {
    const bob = await bobInTheSfuRoom();
    const alice = await connect('alice');
    const lookup = holdNextRoomLookup();
    const result = sfuOutcome(alice.client);
    alice.client.emit('sfu:join', { channelId: VC, serverId: SRV, rtpCapabilities: RTP_CAPS });
    await lookup.reached;

    expect((await Members.removeMember('alice', SRV))?.deleted).toBe(1);
    invalidatePerms(SRV, 'alice');
    await evictUserFromServerRooms(io, 'alice', SRV);
    lookup.release();

    expect(await result).toBe('FORBIDDEN');
    await settle();
    const socket = serverSockets.get('alice')! as ServerSocket & { currentVoiceChannel?: string | null };
    expect(sfuUserIds()).toEqual(['bob']);
    expect(sfuPeers.has(socket.id)).toBe(false);
    expect(socket.rooms.has(`voice:${VC}`)).toBe(false);
    expect(socket.currentVoiceChannel ?? null).toBeNull();
    expect(alice.received.map((r) => r.event)).not.toContain('sfu:joined');
    expect(bob.received.filter((r) => r.event === 'sfu:peer-joined')).toEqual([]);
  });

  it('CONNECT revoked on the channel (VIEW kept): the join is refused', async () => {
    const bob = await bobInTheSfuRoom();
    const alice = await connect('alice');
    const lookup = holdNextRoomLookup();
    const result = sfuOutcome(alice.client);
    alice.client.emit('sfu:join', { channelId: VC, serverId: SRV, rtpCapabilities: RTP_CAPS });
    await lookup.reached;

    await vdb.channelOverrides.insert({
      _id: 'ovr-no-connect', channelId: VC, targetType: 'everyone', targetId: SRV, allow: 0, deny: PERMS.CONNECT, position: 0,
    });
    invalidatePerms(SRV, null, VC);
    await evictSocketsWithoutChannelAccess(io, SRV, VC);
    lookup.release();

    expect(await result).toBe('FORBIDDEN');
    await settle();
    expect(sfuUserIds()).toEqual([]);           // bob lost CONNECT too, and was evicted
    expect(sfuPeers.has(serverSockets.get('alice')!.id)).toBe(false);
    expect(serverSockets.get('alice')!.rooms.has(`voice:${VC}`)).toBe(false);
    expect(bob.received.filter((r) => r.event === 'sfu:peer-joined')).toEqual([]);
  });

  it('revoked while the re-check is reading: the eviction wins and the client is told the join failed', async () => {
    const bob = await bobInTheSfuRoom();
    const alice = await connect('alice');
    const recheck = holdRecheckOf('alice');
    const result = sfuOutcome(alice.client);
    alice.client.emit('sfu:join', { channelId: VC, serverId: SRV, rtpCapabilities: RTP_CAPS });
    await recheck.reached;            // admitted, and the re-check has already read "allowed"

    expect((await Members.removeMember('alice', SRV))?.deleted).toBe(1);
    invalidatePerms(SRV, 'alice');
    await evictUserFromServerRooms(io, 'alice', SRV);
    recheck.release();

    expect(await result).toBe('FORBIDDEN');
    await settle();
    expect(sfuUserIds()).toEqual(['bob']);
    expect(sfuPeers.has(serverSockets.get('alice')!.id)).toBe(false);
    expect(alice.received.map((r) => r.event)).toEqual(expect.arrayContaining(['voice:evicted']));
    expect(alice.received.map((r) => r.event)).not.toContain('sfu:joined');
    expect(bob.received.filter((r) => r.event === 'sfu:peer-joined')).toEqual([]);
  });

  it('the user leaves during the re-check: no join result is sent and no peer is left behind', async () => {
    const bob = await bobInTheSfuRoom();
    const alice = await connect('alice');
    const recheck = holdRecheckOf('alice');
    alice.client.emit('sfu:join', { channelId: VC, serverId: SRV, rtpCapabilities: RTP_CAPS });
    await recheck.reached;
    alice.client.emit('sfu:leave', { channelId: VC, serverId: SRV });
    for (let i = 0; i < 200 && sfuUserIds().includes('alice'); i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(sfuUserIds()).toEqual(['bob']);
    recheck.release();

    await settle();
    expect(sfuUserIds()).toEqual(['bob']);
    const events = alice.received.map((r) => r.event);
    expect(events).not.toContain('sfu:joined');
    expect(events).not.toContain('sfu:error');      // she left; no "forbidden" error
    expect(bob.received.filter((r) => r.event === 'sfu:peer-joined')).toEqual([]);
  });

  it('a stage: taken off the stage roster during the join, the join is refused', async () => {
    const ST = 'stage-race';
    await vdb.channels.insert({ _id: ST, serverId: SRV, name: 'stage', type: 'stage', createdAt: 1 });
    const onStage = jest.spyOn(stage, 'isStageParticipant').mockResolvedValue(true);
    const alice = await connect('alice');
    const lookup = holdNextRoomLookup();
    const result = sfuOutcome(alice.client);
    alice.client.emit('sfu:join', { channelId: ST, serverId: SRV, rtpCapabilities: RTP_CAPS });
    await lookup.reached;             // the first check passed: she was on the stage
    onStage.mockResolvedValue(false);
    lookup.release();

    expect(await result).toBe('FORBIDDEN');
    await settle();
    expect(sfuRooms.get(ST)?.peers.size ?? 0).toBe(0);
    expect(sfuPeers.has(serverSockets.get('alice')!.id)).toBe(false);
    expect(serverSockets.get('alice')!.rooms.has(`voice:${ST}`)).toBe(false);
  });

  it('CONTROL: with no revocation the held join completes and the peer is told', async () => {
    const bob = await bobInTheSfuRoom();
    const alice = await connect('alice');
    const lookup = holdNextRoomLookup();
    const result = sfuOutcome(alice.client);
    alice.client.emit('sfu:join', { channelId: VC, serverId: SRV, rtpCapabilities: RTP_CAPS });
    await lookup.reached;
    lookup.release();

    expect(await result).toBe('joined');
    await settle();
    expect(sfuUserIds()).toEqual(['alice', 'bob']);
    expect(bob.received.filter((r) => r.event === 'sfu:peer-joined').map((r) => (r.data as { userId: string }).userId)).toEqual(['alice']);
  });
});
