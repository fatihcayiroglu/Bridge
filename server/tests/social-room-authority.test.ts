/**
 * Server-owned 3D Social Space socket contracts; NO client/network mock green.
 * Unit tests prove authorization and mutation branches, NOT Redis clustering.
 */
const mockMembersFindOne = jest.fn();
const mockResolvePermissions = jest.fn();
const mockHasPermission = jest.fn();
const mockCacheData = new Map<string, unknown>();
let mockRedisAvailable = true;
let mockRedisReadFailure = false;
const mockWithKeyLock = jest.fn(async (_key: string, action: () => Promise<unknown>) => action());
jest.mock('../db/repositories', () => ({
  Members: { findOne: (...a: unknown[]) => mockMembersFindOne(...a) },
}));
jest.mock('../lib/permissions', () => ({
  PERMS: { VIEW_CHANNELS: 1, CONNECT: 65536 },
  resolvePermissions: (...a: unknown[]) => mockResolvePermissions(...a),
  hasPermission: (...a: unknown[]) => mockHasPermission(...a),
}));
jest.mock('../lib/redisAdapter', () => ({
  isRedisAvailable: () => mockRedisAvailable,
  cache: {
    getAuthoritative: async (key: string) => {
      if (mockRedisReadFailure) throw new Error('Redis read unavailable');
      return mockCacheData.get(key) ?? null;
    },
    setAuthoritative: async (key: string, value: unknown) => { mockCacheData.set(key, structuredClone(value)); },
    delAuthoritative: async (key: string) => { mockCacheData.delete(key); },
    withKeyLock: (...args: unknown[]) => mockWithKeyLock(...(args as [string, () => Promise<unknown>])),
  },
}));
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
import { registerSocialRoomHandlers } from '../socket/handlers/social-room';
import {
  SOCIAL_SPACE_BOUNDS, SOCIAL_SPACE_MAX_PEERS, socialRoomStore,
} from '../socket/handlers/social-room-store';

type Event = { name: string; data: unknown; room?: string };
let nextSocket = 0;
function socketFor(userId: string, serverId: string) {
  const id = 'social-test-socket-' + ++nextSocket;
  const rooms = new Set([id, 'server:' + serverId]);
  const emitted: Event[] = [];
  const listeners: Record<string, (payload?: unknown) => Promise<void>> = {};
  return {
    id, userId, rooms,
    emitted, listeners,
    isBot: false,
    on(name: string, cb: (payload?: unknown) => Promise<void>) { listeners[name] = cb; },
    emit(name: string, data: unknown) { emitted.push({ name, data }); },
    async join(room: string) { rooms.add(room); },
    async leave(room: string) { rooms.delete(room); },
    to() { return { emit() {} }; },
    async trigger(name: string, payload?: unknown) {
      const fn = listeners[name];
      if (!fn) throw new Error('Missing listener ' + name);
      await fn(payload);
    },
  };
}
function makeIo() {
  const events: Event[] = [];
  return {
    events,
    to(room: string) {
      return { emit(name: string, data: unknown) { events.push({ room, name, data }); } };
    },
  };
}
function wire(userId: string, serverId: string, io: ReturnType<typeof makeIo>) {
  const socket = socketFor(userId, serverId);
  registerSocialRoomHandlers(socket as never, io as never, userId);
  return socket;
}
function last(socket: ReturnType<typeof socketFor>, name: string): unknown {
  return socket.emitted.filter(e => e.name === name).at(-1)?.data;
}
const server = () => 'social-server-' + Date.now() + '-' + ++nextSocket;

beforeEach(() => {
  mockCacheData.clear();
  mockRedisAvailable = true;
  mockRedisReadFailure = false;
  mockWithKeyLock.mockClear();
  mockMembersFindOne.mockReset().mockResolvedValue({ userId: 'member', banned: false });
  mockResolvePermissions.mockReset().mockResolvedValue(1 | 65536);
  mockHasPermission.mockReset().mockReturnValue(true);
});

describe('3D Social Space authority and presence', () => {
  it('rejects missing membership without leaking room contents or writing Redis', async () => {
    const io = makeIo();
    const s = wire('u1', server(), io);
    mockMembersFindOne.mockResolvedValue(null);
    await s.trigger('social:join', { serverId: [...s.rooms].find(x => x.startsWith('server:'))!.slice(7) });
    expect(last(s, 'social:error')).toEqual({ code: 'SOCIAL_ROOM_UNAVAILABLE' });
    expect(last(s, 'social:joined')).toBeUndefined();
    expect(io.events).toHaveLength(0);
    expect(mockCacheData.size).toBe(0);
  });

  it('rejects forged tenant, bot socket and lacking CONNECT permission', async () => {
    const io = makeIo(), sid = server();
    const s = wire('u1', sid, io);
    await s.trigger('social:join', { serverId: 'forged-server' });
    expect(mockMembersFindOne).not.toHaveBeenCalled();
    s.isBot = true;
    await s.trigger('social:join', { serverId: sid });
    expect(mockMembersFindOne).not.toHaveBeenCalled();
    s.isBot = false;
    mockHasPermission.mockReturnValue(false);
    await s.trigger('social:join', { serverId: sid });
    expect(last(s, 'social:joined')).toBeUndefined();
    expect(io.events).toHaveLength(0);
  });

  it('valid join broadcasts only inside the authorized social 3D room', async () => {
    const sid = server(), io = makeIo();
    const a = wire('u1', sid, io), b = wire('u2', sid, io);
    await a.trigger('social:join', { serverId: sid, userId: 'forged', x: 50000 });
    await b.trigger('social:join', { serverId: sid });
    const result = last(b, 'social:joined') as { serverId: string; peers: Array<{userId:string; socketId:string; x:number; z:number}> };
    expect(result.peers.map(p => p.userId)).toEqual(['u1', 'u2']);
    expect(result.peers[0]).toMatchObject({ socketId: a.id, x: 0, z: 2.5 });
    expect(io.events.every(e => e.room === 'social-3d:' + sid)).toBe(true);
    expect(io.events.every(e => e.name === 'social:peers')).toBe(true);
    expect(mockCacheData.size).toBe(1);
  });

  it('server processes bounded discrete steps, ignores client coordinates and throttles', async () => {
    const sid = server(), io = makeIo(), s = wire('u1', sid, io);
    await s.trigger('social:join', { serverId: sid });
    await s.trigger('social:step', { serverId: sid, direction: 'right', x: 9999, z: -9999 });
    let room = await socialRoomStore.load(sid);
    expect(room.peers[0]?.x).toBeCloseTo(0.35);
    expect(room.peers[0]?.z).toBe(2.5);
    const before = io.events.length;
    await s.trigger('social:step', { serverId: sid, direction: 'right' });
    expect(io.events).toHaveLength(before);
    await s.trigger('social:step', { serverId: sid, direction: 'teleport', x: 5000 });
    expect(last(s, 'social:error')).toEqual({ code: 'SOCIAL_ROOM_UNAVAILABLE' });
    room = await socialRoomStore.load(sid);
    expect(room.peers[0]?.x).toBeLessThanOrEqual(SOCIAL_SPACE_BOUNDS.x);
  });

  it('rejects movement in another tenant or without having joined', async () => {
    const sid = server(), io = makeIo(), s = wire('u1', sid, io);
    await s.trigger('social:step', { serverId: sid, direction: 'forward' });
    await s.trigger('social:join', { serverId: sid });
    await s.trigger('social:step', { serverId: 'other', direction: 'forward' });
    expect(io.events).toHaveLength(1); // only join publication
    expect(last(s, 'social:error')).toEqual({ code: 'SOCIAL_ROOM_UNAVAILABLE' });
  });

  it('rechecks live membership on each movement and evicts a revoked socket', async () => {
    const sid = server(), io = makeIo(), s = wire('u1', sid, io);
    await s.trigger('social:join', { serverId: sid });
    mockMembersFindOne.mockResolvedValue(null);
    await s.trigger('social:step', { serverId: sid, direction: 'forward' });
    expect(s.rooms.has('social-3d:' + sid)).toBe(false);
    expect((await socialRoomStore.load(sid)).peers).toHaveLength(0);
    expect(last(s, 'social:error')).toEqual({ code: 'SOCIAL_ROOM_UNAVAILABLE' });
  });

  it('second tab stays present after first tab leaves or disconnects', async () => {
    const sid = server(), io = makeIo();
    const a = wire('same-user', sid, io), b = wire('same-user', sid, io);
    await a.trigger('social:join', { serverId: sid });
    await b.trigger('social:join', { serverId: sid });
    await a.trigger('social:leave', { serverId: sid });
    expect(a.rooms.has('social-3d:' + sid)).toBe(false);
    expect(last(a, 'social:left')).toEqual({ serverId: sid });
    expect((await socialRoomStore.load(sid)).peers.map(p => p.socketId)).toEqual([b.id]);
    await b.trigger('disconnect');
    expect((await socialRoomStore.load(sid)).peers).toEqual([]);
  });

  it('caps real peer capacity at 16 and rejects the seventeenth', async () => {
    const sid = server(), io = makeIo();
    const peers = Array.from({length: SOCIAL_SPACE_MAX_PEERS + 1}, (_, i) => wire('user-' + i, sid, io));
    for (const p of peers) await p.trigger('social:join', { serverId: sid });
    expect((await socialRoomStore.load(sid)).peers).toHaveLength(SOCIAL_SPACE_MAX_PEERS);
    expect(last(peers[SOCIAL_SPACE_MAX_PEERS]!, 'social:error')).toEqual({ code: 'SOCIAL_ROOM_FULL' });
    expect(peers[SOCIAL_SPACE_MAX_PEERS]!.rooms.has('social-3d:' + sid)).toBe(false);
  });

  it('fails closed during authoritative Redis state corruption', async () => {
    const sid = server(), io = makeIo(), s = wire('u1', sid, io);
    mockCacheData.set('social-3d:server:' + sid, { serverId: sid, peers: [{ socketId: 'x', userId: 'y', x: Infinity, z: 0, lastStepAt: 0 }] });
    await s.trigger('social:join', { serverId: sid });
    expect(last(s, 'social:joined')).toBeUndefined();
    expect(last(s, 'error:message')).toMatchObject({ event: 'social:join' });
    expect(io.events).toHaveLength(0);
  });

  it('refuses all participants when configured Redis throws on authoritative read', async () => {
    const sid = server(), io = makeIo(), s = wire('u1', sid, io);
    mockRedisReadFailure = true;
    await s.trigger('social:join', { serverId: sid });
    expect(last(s, 'social:joined')).toBeUndefined();
    expect(last(s, 'error:message')).toMatchObject({ event: 'social:join' });
    expect(io.events).toHaveLength(0);
  });
});
