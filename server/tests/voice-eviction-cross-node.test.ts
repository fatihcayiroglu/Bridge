// server/tests/voice-eviction-cross-node.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// SES OTURUMU, YETKİ İPTALİNİ HER DÜĞÜMDE İZLEMELİ (P1 çok-düğüm, STALE-02/03)
// ════════════════════════════════════════════════════════════════════════════
// Üç gerçek düğümle ölçüldü: B'deki soketi C üzerinden atılan kullanıcı
//   · ses durumu / konuşma / WebRTC teklifi yaymaya DEVAM etti (STALE-02),
//   · her akranın ses listesinde HAYALET olarak kaldı (STALE-03, iki yolda da).
// Nedenler: `fetchSockets()` başka düğümdeki soketi RemoteSocket vekili olarak
// verir; vekile `currentVoiceChannel` yazmak hiçbir şey değiştirmez. Ses listesi
// (Redis) ve SFU akranı hiçbir yolda temizlenmiyordu.
//
// Bu dosya hızlı CI'da sözleşmeyi korur; gerçek süreçlerle kanıt
// scripts/multinode/scenarios/stale.mjs'tedir.

process.env.NODE_ENV = 'test';

jest.mock('../music', () => ({ readMusicQueue: jest.fn(async () => ({ current: null, queue: [] })) }));
jest.mock('../lib/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
const mockFindIdsByServer = jest.fn(async (..._a: unknown[]) => ['vc1', 'tc1']);
jest.mock('../db/repositories', () => {
  const actual = jest.requireActual('../db/repositories');
  return {
    ...actual,
    Channels: { ...actual.Channels, findIdsByServer: (...a: unknown[]) => mockFindIdsByServer(...a) },
    Threads: { ...actual.Threads, findById: jest.fn(async () => null) },
  };
});

import {
  bindVoiceEvictionClusterControl,
  evictUserFromServerRooms,
  registerLocalVoiceEvictor,
} from '../lib/liveMembership';
import { evictLocalVoiceSessions } from '../socket/voiceEviction';
import { registerVoiceHandlers, __setVoiceRoomForTest, __getVoiceRoomForTest } from '../socket/handlers/voice';
import { sfuPeers, sfuRooms, _resetRoomsForTest } from '../socket/handlers/mediasoup/rooms';

type Listener = (...args: unknown[]) => unknown;

function localSocket(id: string, userId: string) {
  const handlers: Record<string, Listener> = {};
  const rooms = new Set<string>([id, `user:${userId}`]);
  const toRoom: Array<{ room: string; event: string; data: unknown }> = [];
  return {
    id, userId, rooms,
    currentVoiceChannel: null as string | null,
    currentVoiceServer: null as string | null,
    on(e: string, f: Listener) { handlers[e] = f; },
    emit: jest.fn(),
    join(r: string) { rooms.add(r); },
    leave(r: string) { rooms.delete(r); },
    to(room: string) { return { emit(event: string, data: unknown) { toRoom.push({ room, event, data }); } }; },
    toRoom,
    async trigger(e: string, d?: unknown) { const f = handlers[e]; if (f) await f(d); },
  };
}

function fakeIo(localSockets: Array<ReturnType<typeof localSocket>>, remoteSockets: unknown[] = []) {
  const cluster = new Map<string, Listener>();
  const broadcasts: Array<{ target: string | string[]; event: string; data: unknown }> = [];
  const serverSide: Array<{ event: string; payload: unknown }> = [];
  const byUser = (room: string) => localSockets.filter(s => s.rooms.has(room));
  return {
    cluster, broadcasts, serverSide,
    on(event: string, fn: Listener) { cluster.set(event, fn); },
    serverSideEmit(event: string, payload: unknown) { serverSide.push({ event, payload }); },
    to(target: string | string[]) { return { emit(event: string, data: unknown) { broadcasts.push({ target, event, data }); } }; },
    in(room: string) {
      return {
        fetchSockets: async () => [...byUser(room), ...remoteSockets],
        local: { fetchSockets: async () => byUser(room) },
      };
    },
  };
}

const user = (id: string) => ({ _id: id, displayName: id, avatarColor: '#000' } as never);

afterEach(() => {
  registerLocalVoiceEvictor(null);
  delete process.env.REDIS_URL;
  _resetRoomsForTest();
});

describe('P2P voice handlers require real voice-room membership', () => {
  it('a socket whose voice room was revoked through the adapter cannot broadcast state, activity or signalling', async () => {
    const s = localSocket('sock-kicked', 'u-kicked');
    const io = fakeIo([s]);
    registerVoiceHandlers(s as never, io as never, user('u-kicked'));
    await __setVoiceRoomForTest('vc1', [
      { socketId: 'sock-kicked', userId: 'u-kicked', displayName: 'k', avatarColor: '#000' },
      { socketId: 'sock-peer', userId: 'u-peer', displayName: 'p', avatarColor: '#000' },
    ]);
    s.currentVoiceChannel = 'vc1';
    s.join('voice:vc1');

    // Positive control: while the socket holds the room, state reaches peers.
    await s.trigger('voice:state-update', { channelId: 'vc1', muted: true, deafened: false, screensharing: false, video: false });
    expect(s.toRoom.filter(e => e.event === 'voice:peer-state')).toHaveLength(1);

    // Another node revoked membership: the room is gone, the field is stale.
    s.leave('voice:vc1');
    s.toRoom.length = 0;
    io.broadcasts.length = 0;
    await s.trigger('voice:state-update', { channelId: 'vc1', muted: false, deafened: false, screensharing: true, video: true });
    await s.trigger('voice:activity', { channelId: 'vc1', speaking: true });
    await s.trigger('webrtc:offer', { targetSocketId: 'sock-peer', offer: { type: 'offer', sdp: 'v=0' }, channelId: 'vc1' });
    expect(s.toRoom).toEqual([]);
    expect(io.broadcasts.filter(b => b.event === 'webrtc:offer')).toEqual([]);
  });
});

describe('local voice eviction (the node that holds the socket)', () => {
  it('removes a P2P peer from the shared roster and tells the room', async () => {
    const s = localSocket('sock-a', 'u1');
    const io = fakeIo([s]);
    await __setVoiceRoomForTest('vc1', [
      { socketId: 'sock-a', userId: 'u1', displayName: 'a', avatarColor: '#000' },
      { socketId: 'sock-b', userId: 'u2', displayName: 'b', avatarColor: '#000' },
    ]);
    s.currentVoiceChannel = 'vc1'; s.currentVoiceServer = 'srv'; s.join('voice:vc1');

    await evictLocalVoiceSessions(io as never, 'u1', ['vc1']);

    expect((await __getVoiceRoomForTest('vc1')).map(p => p.socketId)).toEqual(['sock-b']);
    expect(s.currentVoiceChannel).toBeNull();
    expect(s.rooms.has('voice:vc1')).toBe(false);
    expect(s.toRoom).toContainEqual(expect.objectContaining({ room: 'voice:vc1', event: 'voice:peer-left' }));
    expect(io.broadcasts).toContainEqual(expect.objectContaining({ event: 'voice:room-update', data: expect.objectContaining({ channelId: 'vc1' }) }));
  });

  it('tears down an SFU peer (transports, producers) on the node that owns it', async () => {
    const s = localSocket('sock-sfu', 'u1');
    const io = fakeIo([s]);
    const closed: string[] = [];
    const peer = {
      channelId: 'vc1', serverId: 'srv', userId: 'u1', displayName: 'a', avatarColor: '#000', rtpCapabilities: {},
      sendTransport: { close: () => closed.push('send') }, recvTransport: { close: () => closed.push('recv') },
      producers: new Map([['audio', { id: 'p1', close: () => closed.push('producer') }]]),
      consumers: new Map([['c1', { close: () => closed.push('consumer') }]]),
      muted: false, deafened: false, screensharing: false, video: false,
    };
    sfuPeers.set('sock-sfu', peer as never);
    sfuRooms.set('vc1', { router: { close() {} }, peers: new Map([['sock-sfu', peer]]), createdAt: 0, channelId: 'vc1' } as never);
    s.currentVoiceChannel = 'vc1'; s.currentVoiceServer = 'srv'; s.join('voice:vc1');

    await evictLocalVoiceSessions(io as never, 'u1', ['vc1']);

    expect(sfuPeers.has('sock-sfu')).toBe(false);
    expect(closed.sort()).toEqual(['consumer', 'producer', 'recv', 'send']);
    expect(io.broadcasts).toContainEqual(expect.objectContaining({ event: 'sfu:peer-left' }));
    expect(s.currentVoiceChannel).toBeNull();
  });

  it('negative control: a voice session in a channel that was NOT revoked is left alone', async () => {
    const s = localSocket('sock-a', 'u1');
    const io = fakeIo([s]);
    await __setVoiceRoomForTest('vc-other', [{ socketId: 'sock-a', userId: 'u1', displayName: 'a', avatarColor: '#000' }]);
    s.currentVoiceChannel = 'vc-other'; s.join('voice:vc-other');
    await evictLocalVoiceSessions(io as never, 'u1', ['vc1']);
    expect(s.currentVoiceChannel).toBe('vc-other');
    expect((await __getVoiceRoomForTest('vc-other'))).toHaveLength(1);
  });
});

describe('revocation reaches the node that holds the socket', () => {
  it('kick: runs the local evictor and asks every other node to evict (cluster mode)', async () => {
    process.env.REDIS_URL = 'redis://cluster.test:6379';
    const evictor = jest.fn(async () => undefined);
    registerLocalVoiceEvictor(evictor);
    // The target's socket lives on ANOTHER node: fetchSockets() yields a proxy.
    const remote = { id: 'remote-1', rooms: new Set(['voice:vc1', 'server:srv', 'user:u1']), leave: jest.fn(async () => undefined), emit: jest.fn() };
    const io = fakeIo([], [remote]);

    await evictUserFromServerRooms(io as never, 'u1', 'srv');

    expect(evictor).toHaveBeenCalledWith(io, 'u1', ['vc1', 'tc1']);
    expect(io.serverSide).toEqual([{ event: 'membership:voice-evict', payload: { userId: 'u1', channelIds: ['vc1', 'tc1'] } }]);
    expect(remote.leave).toHaveBeenCalledWith('voice:vc1');
  });

  it('negative control: a deliberately single-node deployment evicts locally and broadcasts nothing', async () => {
    const evictor = jest.fn(async () => undefined);
    registerLocalVoiceEvictor(evictor);
    const io = fakeIo([]);
    await evictUserFromServerRooms(io as never, 'u1', 'srv');
    expect(evictor).toHaveBeenCalledTimes(1);
    expect(io.serverSide).toEqual([]);
  });

  it('the cluster listener runs the local evictor only for well-formed payloads', async () => {
    const evictor = jest.fn(async () => undefined);
    registerLocalVoiceEvictor(evictor);
    const io = fakeIo([]);
    bindVoiceEvictionClusterControl(io as never);
    const listener = io.cluster.get('membership:voice-evict')!;
    for (const bad of [null, [], 'x', { userId: 'u1' }, { userId: 'u1', channelIds: [] }, { userId: 7, channelIds: ['vc1'] }, { userId: 'u1', channelIds: [''] }]) {
      listener(bad);
    }
    await new Promise(r => setImmediate(r));
    expect(evictor).not.toHaveBeenCalled();
    listener({ userId: 'u1', channelIds: ['vc1'] });
    await new Promise(r => setImmediate(r));
    expect(evictor).toHaveBeenCalledWith(io, 'u1', ['vc1']);
  });
});
