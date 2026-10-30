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
import { evictSocialUserFromRoom, reconcileSocialRoomAccess } from '../socket/handlers/social-room-eviction';
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

  it('cancels an in-flight join after the user closes the room before permission resolves', async () => {
    const sid = server(), io = makeIo(), s = wire('user-pending', sid, io);
    let release!: (value: unknown) => void;
    const permissionPending = new Promise(resolve => { release = resolve; });
    mockMembersFindOne.mockImplementationOnce(() => permissionPending);
    const pending = s.trigger('social:join', { serverId: sid });
    // The server received the request but DB permissions have not resolved.
    await Promise.resolve();
    await s.trigger('social:leave', { serverId: sid });
    expect(last(s, 'social:left')).toEqual({ serverId: sid });
    release({ userId: 'user-pending', banned: false });
    await pending;
    expect(last(s, 'social:joined')).toBeUndefined();
    expect(s.rooms.has('social-3d:' + sid)).toBe(false);
    expect((await socialRoomStore.load(sid)).peers).toHaveLength(0);
    expect(io.events).toHaveLength(0);
  });

  it('rejects a pending stale join when the user is revoked during the DB lookup', async () => {
    const sid = server(), io = makeIo(), s = wire('revoked', sid, io);
    let allowMembership!: (value: unknown) => void;
    let membershipEntered!: () => void;
    const membershipStarted = new Promise<void>(resolve => { membershipEntered = resolve; });
    const membershipPending = new Promise(resolve => { allowMembership = resolve; });
    mockMembersFindOne.mockImplementationOnce(() => {
      membershipEntered();
      return membershipPending;
    });
    const pending = s.trigger('social:join', { serverId: sid });
    // This handshake makes the overlap deterministic: the handler already
    // captured the old generation and is blocked on actual membership lookup.
    await membershipStarted;
    await socialRoomStore.withLock(sid, () => socialRoomStore.markRevocationFence(sid, 'revoked'));
    allowMembership({ userId: 'revoked', banned: false });
    await pending;
    expect(last(s, 'social:joined')).toBeUndefined();
    expect((await socialRoomStore.load(sid)).peers).toEqual([]);
    expect(s.rooms.has('social-3d:' + sid)).toBe(false);
    expect(io.events).toHaveLength(0);
  });

  it('rejects join and removes reservation when revocation hits async Socket.IO join', async () => {
    const sid = server(), io = makeIo(), s = wire('revoked', sid, io);
    let releaseJoin!: () => void;
    let enteredJoin!: () => void;
    const joinReached = new Promise<void>(resolve => { enteredJoin = resolve; });
    const joinGate = new Promise<void>(resolve => { releaseJoin = resolve; });
    const originalJoin = s.join.bind(s);
    s.join = async (room: string) => {
      if (room === 'social-3d:' + sid) {
        enteredJoin();
        await joinGate;
      }
      await originalJoin(room);
    };
    const pending = s.trigger('social:join', { serverId: sid });
    await joinReached;
    expect((await socialRoomStore.load(sid)).peers).toHaveLength(1);
    // On another node the revoker can advance the shared Redis generation
    // while this socket's adapter is still processing its join.
    await socialRoomStore.withLock(sid, () => socialRoomStore.markRevocationFence(sid, 'revoked'));
    releaseJoin();
    await pending;
    expect(last(s, 'social:joined')).toBeUndefined();
    expect((await socialRoomStore.load(sid)).peers).toEqual([]);
    expect(s.rooms.has('social-3d:' + sid)).toBe(false);
  });

  it('rejects an expired in-flight join even after the short Redis fence could expire', async () => {
    const sid = server(), io = makeIo(), s = wire('slow-user', sid, io);
    let releaseMember!: (value: unknown) => void;
    let membershipEntered!: () => void;
    const entered = new Promise<void>(resolve => { membershipEntered = resolve; });
    const held = new Promise(resolve => { releaseMember = resolve; });
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      mockMembersFindOne.mockImplementationOnce(() => {
        membershipEntered();
        return held;
      });
      const pending = s.trigger('social:join', { serverId: sid });
      await entered;
      // Even if a short-lived revocation generation disappears from Redis,
      // an old stalled admission cannot become a newly authorized join.
      clock.mockReturnValue(20000);
      releaseMember({ userId: 'slow-user', banned: false });
      await pending;
      expect(last(s, 'social:joined')).toBeUndefined();
      expect((await socialRoomStore.load(sid)).peers).toEqual([]);
      expect(s.rooms.has('social-3d:' + sid)).toBe(false);
      expect(io.events).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  });

  it('rejects in-flight admission when a server-wide role revision is committed', async () => {
    const sid = server(), io = makeIo(), s = wire('member', sid, io);
    let releaseMembership!: (value: unknown) => void;
    let reached!: () => void;
    const started = new Promise<void>(resolve => { reached = resolve; });
    const held = new Promise(resolve => { releaseMembership = resolve; });
    mockMembersFindOne.mockImplementationOnce(() => {
      reached();
      return held;
    });
    const pending = s.trigger('social:join', { serverId: sid });
    await started;
    await socialRoomStore.withLock(sid, () => socialRoomStore.markRevocationFence(sid, '__all__'));
    releaseMembership({ userId: 'member', serverId: sid });
    await pending;
    expect(last(s, 'social:joined')).toBeUndefined();
    expect(s.rooms.has('social-3d:' + sid)).toBe(false);
    expect((await socialRoomStore.load(sid)).peers).toEqual([]);
  });

  it('refuses joining if the shared Redis generation cannot be read', async () => {
    const sid = server(), io = makeIo(), s = wire('u1', sid, io);
    mockRedisReadFailure = true;
    await s.trigger('social:join', { serverId: sid });
    expect(last(s, 'social:joined')).toBeUndefined();
    expect(last(s, 'error:message')).toMatchObject({ event: 'social:join' });
    expect(io.events).toEqual([]);
    mockRedisReadFailure = false;
    expect((await socialRoomStore.load(sid)).peers).toEqual([]);
  });

  it('double join does not create duplicate participant slots', async () => {
    const sid = server(), io = makeIo(), s = wire('user-one', sid, io);
    await s.trigger('social:join', { serverId: sid });
    await s.trigger('social:join', { serverId: sid });
    expect((await socialRoomStore.load(sid)).peers).toHaveLength(1);
    expect(s.emitted.filter(e => e.name === 'social:joined')).toHaveLength(1);
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


describe('3D social roster — membership revocation cleanup', () => {
  const makePeer = (socketId: string, userId: string) => ({
    socketId, userId, x: 0, z: 2.5, lastStepAt: 0,
  });

  it('removes all revoked user tabs but retains friends and other tenants', async () => {
    const sid = server(), other = server(), io = makeIo();
    await socialRoomStore.save(sid, {
      serverId: sid, peers: [
        makePeer('revoked-tab-a', 'revoked'),
        makePeer('friend-tab', 'friend'),
        makePeer('revoked-tab-b', 'revoked'),
      ],
    });
    await socialRoomStore.save(other, {
      serverId: other, peers: [makePeer('other-server-tab', 'revoked')],
    });
    const removed = await evictSocialUserFromRoom(io as never, 'revoked', sid);
    expect(removed).toBe(2);
    expect((await socialRoomStore.load(sid)).peers.map(p => p.userId)).toEqual(['friend']);
    expect((await socialRoomStore.load(other)).peers.map(p => p.userId)).toEqual(['revoked']);
    expect(io.events).toEqual([{
      room: 'social-3d:' + sid, name: 'social:peers',
      data: { serverId: sid, peers: [{ socketId: 'friend-tab', userId: 'friend', x: 0, z: 2.5 }] },
    }]);
  });

  it('is idempotent: no write or roster broadcast when no revoked peer exists', async () => {
    const sid = server(), io = makeIo();
    await socialRoomStore.save(sid, { serverId: sid, peers: [makePeer('friend-tab', 'friend')] });
    expect(await evictSocialUserFromRoom(io as never, 'missing', sid)).toBe(0);
    expect(await evictSocialUserFromRoom(io as never, '', sid)).toBe(0);
    expect(io.events).toEqual([]);
    expect((await socialRoomStore.load(sid)).peers.map(p => p.userId)).toEqual(['friend']);
  });

  it('fails closed on Redis read failure without publishing an unverified roster', async () => {
    const sid = server(), io = makeIo();
    await socialRoomStore.save(sid, {
      serverId: sid, peers: [makePeer('revoked-tab', 'revoked')],
    });
    mockRedisReadFailure = true;
    await expect(evictSocialUserFromRoom(io as never, 'revoked', sid))
      .rejects.toThrow('Redis read unavailable');
    expect(io.events).toEqual([]);
    mockRedisReadFailure = false;
    expect((await socialRoomStore.load(sid)).peers.map(p => p.userId)).toEqual(['revoked']);
  });
});


describe('3D Social Space — real role access change reconciliation contract', () => {
  const existingFlag = process.env.BRIDGE_SOCIAL_3D_MULTIPLAYER;
  beforeEach(() => { process.env.BRIDGE_SOCIAL_3D_MULTIPLAYER = '1'; });
  afterEach(() => {
    if (existingFlag === undefined) delete process.env.BRIDGE_SOCIAL_3D_MULTIPLAYER;
    else process.env.BRIDGE_SOCIAL_3D_MULTIPLAYER = existingFlag;
  });
  const peer = (socketId: string, userId: string) => ({
    socketId, userId, x: 0, z: 2.5, lastStepAt: 0,
  });

  it('globally revokes only users missing fresh server permissions and preserves another tenant', async () => {
    const sid = server(), other = server();
    await socialRoomStore.save(sid, {
      serverId: sid,
      peers: [peer('revoked-socket', 'revoked'), peer('friend-socket', 'friend')],
    });
    await socialRoomStore.save(other, {
      serverId: other, peers: [peer('other-tenant-socket', 'revoked')],
    });
    const target = {
      rooms: new Set(['user:revoked', 'social-3d:' + sid, 'social-3d:' + other]),
      left: [] as string[],
      emitted: [] as Array<{event:string;data:unknown}>,
      async leave(room: string) { this.rooms.delete(room); this.left.push(room); },
      emit(event: string, data: unknown) { this.emitted.push({ event, data }); },
    };
    const broadcasts: Event[] = [];
    const io = {
      in(room: string) {
        return { async fetchSockets() { return room === 'user:revoked' ? [target] : []; } };
      },
      to(room: string) {
        return { emit(name: string, data: unknown) { broadcasts.push({ room, name, data }); } };
      },
    };
    mockMembersFindOne.mockImplementation(async (userId: string) =>
      userId === 'friend' ? { userId, serverId: sid } : null);
    const removed = await reconcileSocialRoomAccess(io as never, sid);
    expect(removed).toBe(1);
    expect(target.left).toEqual(['social-3d:' + sid]);
    expect(target.rooms.has('social-3d:' + other)).toBe(true);
    expect(target.emitted).toEqual([{ event: 'social:left', data: { serverId: sid } }]);
    expect((await socialRoomStore.load(sid)).peers.map(p => p.userId)).toEqual(['friend']);
    expect((await socialRoomStore.load(other)).peers.map(p => p.userId)).toEqual(['revoked']);
    expect(broadcasts).toEqual([{
      room: 'social-3d:' + sid, name: 'social:peers',
      data: { serverId: sid, peers: [{ socketId: 'friend-socket', userId: 'friend', x: 0, z: 2.5 }] },
    }]);
    expect(typeof await socialRoomStore.readRevocationFence(sid, '__all__')).toBe('string');
  });

  it('targeted role removal marks only the target generation and retains other members', async () => {
    const sid = server();
    await socialRoomStore.save(sid, {
      serverId: sid, peers: [peer('revoked-tab-a', 'revoked'), peer('friend', 'friend'), peer('revoked-tab-b', 'revoked')],
    });
    const rooms = new Set(['social-3d:' + sid]);
    const leaves: string[] = [];
    const io = {
      in() {
        return { async fetchSockets() {
          return [{ rooms, async leave(room: string) { rooms.delete(room); leaves.push(room); }, emit() {} }];
        } };
      },
      to() { return { emit() {} }; },
    };
    mockMembersFindOne.mockResolvedValue(null);
    expect(await reconcileSocialRoomAccess(io as never, sid, 'revoked')).toBe(2);
    expect((await socialRoomStore.load(sid)).peers.map(p => p.userId)).toEqual(['friend']);
    expect(leaves).toEqual(['social-3d:' + sid]);
    expect(await socialRoomStore.readRevocationFence(sid, '__all__')).toBeNull();
    expect(typeof await socialRoomStore.readRevocationFence(sid, 'revoked')).toBe('string');
  });

  it('marks global revocation before any authorization read and fails closed on Redis errors', async () => {
    const sid = server(), broadcasts: unknown[] = [];
    await socialRoomStore.save(sid, { serverId: sid, peers: [peer('user-a', 'revoked')] });
    const io = {
      in() { return { async fetchSockets() { return []; } }; },
      to() { return { emit(...parts: unknown[]) { broadcasts.push(parts); } }; },
    };
    mockRedisReadFailure = true;
    await expect(reconcileSocialRoomAccess(io as never, sid)).rejects.toThrow('Redis read unavailable');
    expect(broadcasts).toEqual([]);
    mockRedisReadFailure = false;
    expect((await socialRoomStore.load(sid)).peers.map(p => p.userId)).toEqual(['revoked']);
  });

  it('keeps the disabled feature completely inert without Redis writes or socket access', async () => {
    const sid = server();
    const io = { in: jest.fn(), to: jest.fn() };
    const previous = process.env.BRIDGE_SOCIAL_3D_MULTIPLAYER;
    delete process.env.BRIDGE_SOCIAL_3D_MULTIPLAYER;
    try {
      expect(await reconcileSocialRoomAccess(io as never, sid)).toBe(0);
      expect(io.in).not.toHaveBeenCalled();
      expect(io.to).not.toHaveBeenCalled();
      expect(await socialRoomStore.readRevocationFence(sid, '__all__')).toBeNull();
    } finally {
      if (previous !== undefined) process.env.BRIDGE_SOCIAL_3D_MULTIPLAYER = previous;
    }
  });
});
