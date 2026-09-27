// server/tests/activities-socket-ownership-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// AKTİVİTE SOKETLERİ — BAĞLANTI SAHİPLİĞİ VE YETKİ SINIRI
// ════════════════════════════════════════════════════════════════════════════
//
// `tests/activities.server.test.ts` mutlu yolu ve klasik hataları ölçer. Bu
// tamamlayıcı takım aynı handler'ın SAHİPLİK muhasebesini ve yetki
// kenarlarını ölçer:
//
//   · ÇOKLU SEKME. Aynı kullanıcı iki sekmeden katılabilir. Bir sekmenin
//     kapanması kullanıcıyı katılımcı listesinden DÜŞÜRMEMELİDİR; düşerse
//     oturum sahibi (host) ayrıldı sanılıp aktivite herkes için KAPANIR.
//   · ESKİ OTURUMLAR. Soket sahipliği taşımayan (eski biçim) kalıcı bir
//     oturum yine de temiz biçimde bırakılabilmelidir.
//   · YETKİ. Kanal bulunamıyorsa, sunucusu yoksa ya da istemcinin bildirdiği
//     `serverId` kanalın gerçek sunucusundan FARKLIYSA hiçbir şey yapılmaz —
//     ve bu, oturumun VAR OLUP OLMADIĞINI sızdırmadan yapılır.
//   · YARIŞLAR. Okuma ile kilit arasında oturum silinir ya da başka bir
//     sunucuya taşınırsa katılım REDDEDİLİR.

'use strict';
process.env.NODE_ENV = 'test';
delete process.env.REDIS_URL;

const mockValidate = jest.fn(() => ({ valid: true }));
const mockResolvePerms = jest.fn();
const mockHasPerm = jest.fn();
const mockFindChannel = jest.fn();

jest.mock('../middleware/validate', () => ({
  validateSocketPayload: (...a: unknown[]) => mockValidate(...(a as [])),
  socketSchemas: { activityStart: {}, activityJoin: {}, activityChannelId: {} },
}));
jest.mock('../lib/permissions', () => ({
  resolvePermissions: (...a: unknown[]) => mockResolvePerms(...(a as [])),
  hasPermission: (...a: unknown[]) => mockHasPerm(...(a as [])),
  PERMS: { VIEW_CHANNELS: 0x400, CONNECT: 0x100 },
}));
jest.mock('../db/repositories', () => ({
  Channels: { findById: (...a: unknown[]) => mockFindChannel(...(a as [])) },
}));
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../socket/handlers/activities/draw-together', () => ({ registerDrawTogetherHandlers: jest.fn() }));
jest.mock('../socket/handlers/activities/chess-arbiter', () => ({ registerChessHandlers: jest.fn() }));

import { registerActivityHandlers, getActivitySession } from '../socket/handlers/activities';
import { activityStore, type ActivitySession } from '../socket/handlers/activity-store';

type Emitted = { ev: string; data: unknown; room?: string };

let socketSeq = 0;
function makeSocket(options: { id?: string | null; inVoice?: boolean } = {}) {
  const handlers: Record<string, (p: unknown) => unknown> = {};
  const emitted: Emitted[] = [];
  return {
    id: options.id === undefined ? `act-socket-${++socketSeq}` : options.id,
    rooms: { has: jest.fn((room: string) => (options.inVoice ?? true) && room.startsWith('voice:')) },
    on(ev: string, fn: (p: unknown) => unknown) { handlers[ev] = fn; },
    emit(ev: string, data?: unknown) { emitted.push({ ev, data }); },
    join() {}, leave() {},
    _emitted: emitted,
    async _trigger(ev: string, payload?: unknown) { return handlers[ev]?.(payload); },
  };
}

function makeIo() {
  const emitted: Emitted[] = [];
  return {
    _emitted: emitted,
    to(room: string) { return { emit(ev: string, data: unknown) { emitted.push({ ev, data, room }); } }; },
  };
}

let channelSeq = 0;
const uniqueChannel = () => `ch-own-${Date.now()}-${++channelSeq}`;

function wire(userId: string, options: { io?: ReturnType<typeof makeIo>; socket?: ReturnType<typeof makeSocket> } = {}) {
  const socket = options.socket ?? makeSocket();
  const io = options.io ?? makeIo();
  registerActivityHandlers(socket as never, io as never, userId);
  return { socket, io };
}

const errorsOf = (s: ReturnType<typeof makeSocket>) => s._emitted.filter(e => e.ev === 'activity:error');
const eventsOf = (io: ReturnType<typeof makeIo>, ev: string) => io._emitted.filter(e => e.ev === ev);

beforeEach(() => {
  jest.clearAllMocks();
  activityStore._localSessions_TEST_ONLY.clear();
  mockValidate.mockReturnValue({ valid: true });
  mockResolvePerms.mockResolvedValue(0xffffffff);
  mockHasPerm.mockReturnValue(true);
  mockFindChannel.mockResolvedValue({ serverId: 'srv-1' });
});

describe('channel authorization is derived from the channel, never from the client', () => {
  it('a channel that does not exist yields no session and no oracle', async () => {
    mockFindChannel.mockResolvedValue(null);
    const ch = uniqueChannel();
    const { socket, io } = wire('u1');

    await socket._trigger('activity:start', { activityId: 'chess', channelId: ch, serverId: 'srv-1' });

    expect(errorsOf(socket)).toHaveLength(1);
    expect(errorsOf(socket)[0]!.data).toEqual({ message: 'Bu kanala bağlanma izniniz yok.' });
    expect(eventsOf(io, 'activity:started')).toHaveLength(0);
    expect(getActivitySession(ch)).toBeUndefined();
  });

  it('a channel row with no server cannot host an activity', async () => {
    mockFindChannel.mockResolvedValue({ _id: 'c1' });
    const ch = uniqueChannel();
    const { socket } = wire('u1');

    await socket._trigger('activity:start', { activityId: 'chess', channelId: ch, serverId: 'srv-1' });

    expect(errorsOf(socket)).toHaveLength(1);
    expect(getActivitySession(ch)).toBeUndefined();
  });

  it('a claimed server id that disagrees with the channel is refused', async () => {
    mockFindChannel.mockResolvedValue({ serverId: 'srv-real' });
    const ch = uniqueChannel();
    const { socket } = wire('u1');

    await socket._trigger('activity:start', { activityId: 'chess', channelId: ch, serverId: 'srv-claimed' });

    expect(errorsOf(socket)).toHaveLength(1);
    expect(getActivitySession(ch)).toBeUndefined();
  });

  it('a socket that never joined the voice room is refused', async () => {
    const ch = uniqueChannel();
    const socket = makeSocket({ inVoice: false });
    const { io } = wire('u1', { socket });

    await socket._trigger('activity:start', { activityId: 'chess', channelId: ch, serverId: 'srv-1' });

    expect(errorsOf(socket)).toHaveLength(1);
    expect(eventsOf(io, 'activity:started')).toHaveLength(0);
    // Channel lookup is not even reached: room membership is checked first.
    expect(mockFindChannel).not.toHaveBeenCalled();
  });

  it('a connection with no user identity is refused before the channel is read', async () => {
    const ch = uniqueChannel();
    const { socket } = wire('');

    await socket._trigger('activity:start', { activityId: 'chess', channelId: ch, serverId: 'srv-1' });

    expect(errorsOf(socket)).toHaveLength(1);
    expect(mockFindChannel).not.toHaveBeenCalled();
  });

  it('missing permissions are refused even for an existing channel', async () => {
    mockHasPerm.mockReturnValue(false);
    const ch = uniqueChannel();
    const { socket } = wire('u1');

    await socket._trigger('activity:start', { activityId: 'chess', channelId: ch, serverId: 'srv-1' });

    expect(errorsOf(socket)).toHaveLength(1);
    expect(getActivitySession(ch)).toBeUndefined();
  });

  it('a failing permission lookup is treated as no permission', async () => {
    mockResolvePerms.mockRejectedValue(new Error('permission store down'));
    mockHasPerm.mockImplementation((perms: number) => perms !== 0);
    const ch = uniqueChannel();
    const { socket } = wire('u1');

    await socket._trigger('activity:start', { activityId: 'chess', channelId: ch, serverId: 'srv-1' });

    expect(errorsOf(socket)).toHaveLength(1);
    expect(getActivitySession(ch)).toBeUndefined();
  });
});

describe('payload guards', () => {
  const incompleteStarts: Array<[string, Record<string, unknown>]> = [
    ['no activity id', { channelId: 'c', serverId: 's' }],
    ['no channel id', { activityId: 'chess', serverId: 's' }],
    ['no server id', { activityId: 'chess', channelId: 'c' }],
    ['nothing at all', {}],
  ];
  for (const [name, payload] of incompleteStarts) {
    it(`activity:start with ${name} does nothing`, async () => {
      const { socket, io } = wire('u1');
      await socket._trigger('activity:start', payload);
      expect(socket._emitted).toHaveLength(0);
      expect(io._emitted).toHaveLength(0);
    });
  }

  it('an undefined payload is tolerated on every activity event', async () => {
    const { socket, io } = wire('u1');
    for (const ev of ['activity:start', 'activity:join', 'activity:leave', 'activity:list']) {
      await socket._trigger(ev, undefined);
    }
    expect(socket._emitted).toHaveLength(0);
    expect(io._emitted).toHaveLength(0);
  });

  it('a payload rejected by the schema never reaches the store', async () => {
    mockValidate.mockReturnValue({ valid: false } as never);
    const { socket, io } = wire('u1');
    for (const ev of ['activity:start', 'activity:join', 'activity:leave', 'activity:list']) {
      await socket._trigger(ev, { channelId: 'c', sessionId: 's', activityId: 'chess', serverId: 'srv-1' });
    }
    expect(socket._emitted).toHaveLength(0);
    expect(io._emitted).toHaveLength(0);
    expect(mockFindChannel).not.toHaveBeenCalled();
  });

  const incompleteJoins: Array<[string, Record<string, unknown>]> = [
    ['no channel id', { sessionId: 's' }],
    ['no session id', { channelId: 'c' }],
  ];
  for (const [name, payload] of incompleteJoins) {
    it(`activity:join with ${name} does nothing`, async () => {
      const { socket } = wire('u1');
      await socket._trigger('activity:join', payload);
      expect(socket._emitted).toHaveLength(0);
    });
  }

  it('activity:leave and activity:list without a channel id do nothing', async () => {
    const { socket } = wire('u1');
    await socket._trigger('activity:leave', {});
    await socket._trigger('activity:list', {});
    expect(socket._emitted).toHaveLength(0);
  });
});

describe('one user across two connections', () => {
  async function startedSession() {
    const ch = uniqueChannel();
    const io = makeIo();
    const first = makeSocket();
    wire('host', { io, socket: first });
    await first._trigger('activity:start', { activityId: 'chess', channelId: ch, serverId: 'srv-1' });
    expect(getActivitySession(ch)).toBeDefined();
    return { ch, io, first };
  }

  it('a second tab joining does not duplicate the participant', async () => {
    const { ch, io } = await startedSession();
    const second = makeSocket();
    wire('host', { io, socket: second });
    const sessionId = getActivitySession(ch)!.sessionId;

    await second._trigger('activity:join', { channelId: ch, sessionId });

    expect([...getActivitySession(ch)!.participants]).toEqual(['host']);
    expect(getActivitySession(ch)!.participantSockets!.size).toBe(2);
  });

  it('closing one tab keeps the user in the activity', async () => {
    const { ch, io, first } = await startedSession();
    const second = makeSocket();
    wire('host', { io, socket: second });
    await second._trigger('activity:join', { channelId: ch, sessionId: getActivitySession(ch)!.sessionId });

    await first._trigger('activity:leave', { channelId: ch });

    // The host is still present, so the activity must not have ended.
    expect(getActivitySession(ch)).toBeDefined();
    expect([...getActivitySession(ch)!.participants]).toEqual(['host']);
    expect(eventsOf(io, 'activity:ended')).toHaveLength(0);
  });

  it('closing the last tab ends the activity', async () => {
    const { ch, io, first } = await startedSession();
    const second = makeSocket();
    wire('host', { io, socket: second });
    await second._trigger('activity:join', { channelId: ch, sessionId: getActivitySession(ch)!.sessionId });

    await first._trigger('activity:leave', { channelId: ch });
    await second._trigger('activity:leave', { channelId: ch });

    expect(getActivitySession(ch)).toBeUndefined();
    expect(eventsOf(io, 'activity:ended')).toHaveLength(1);
  });

  it('a disconnect releases only the connection that dropped', async () => {
    const { ch, io, first } = await startedSession();
    const second = makeSocket();
    wire('host', { io, socket: second });
    await second._trigger('activity:join', { channelId: ch, sessionId: getActivitySession(ch)!.sessionId });

    await first._trigger('disconnect');

    expect(getActivitySession(ch)).toBeDefined();
    expect(eventsOf(io, 'activity:ended')).toHaveLength(0);

    await second._trigger('disconnect');
    expect(getActivitySession(ch)).toBeUndefined();
    expect(eventsOf(io, 'activity:ended')).toHaveLength(1);
  });

  it('a disconnect for a channel whose session already vanished is a no-op', async () => {
    const { ch, io, first } = await startedSession();
    activityStore._localSessions_TEST_ONLY.delete(ch);

    await first._trigger('disconnect');

    expect(eventsOf(io, 'activity:ended')).toHaveLength(0);
    expect(eventsOf(io, 'activity:participants_updated')).toHaveLength(0);
  });

  it('a connection with no socket id still owns its participation', async () => {
    const ch = uniqueChannel();
    const io = makeIo();
    const anonymous = makeSocket({ id: null });
    wire('host', { io, socket: anonymous });

    await anonymous._trigger('activity:start', { activityId: 'chess', channelId: ch, serverId: 'srv-1' });
    const sockets = [...getActivitySession(ch)!.participantSockets!.keys()];
    expect(sockets).toHaveLength(1);
    expect(sockets[0]).toMatch(/^activity-socket:[0-9a-f-]{36}$/);

    await anonymous._trigger('activity:leave', { channelId: ch });
    expect(getActivitySession(ch)).toBeUndefined();
  });
});

describe('legacy sessions without socket ownership', () => {
  function seedLegacy(channelId: string, participants: string[], hostUserId: string): ActivitySession {
    const session = {
      activityId: 'chess', channelId, serverId: 'srv-1', hostUserId,
      participants: new Set(participants),
      startedAt: Date.now(), sessionId: 'legacy-session',
    } as ActivitySession;
    activityStore._localSessions_TEST_ONLY.set(channelId, session);
    return session;
  }

  it('a participant can still leave and the activity ends when the host goes', async () => {
    const ch = uniqueChannel();
    seedLegacy(ch, ['host'], 'host');
    const io = makeIo();
    const socket = makeSocket();
    wire('host', { io, socket });

    await socket._trigger('activity:leave', { channelId: ch });

    expect(getActivitySession(ch)).toBeUndefined();
    expect(eventsOf(io, 'activity:ended')).toHaveLength(1);
  });

  it('a non-host leaving a legacy session keeps it alive', async () => {
    const ch = uniqueChannel();
    seedLegacy(ch, ['host', 'guest'], 'host');
    const io = makeIo();
    const socket = makeSocket();
    wire('guest', { io, socket });

    await socket._trigger('activity:leave', { channelId: ch });

    expect([...getActivitySession(ch)!.participants]).toEqual(['host']);
    expect(eventsOf(io, 'activity:participants_updated')).toHaveLength(1);
  });

  it('leaving a channel the user is not part of changes nothing', async () => {
    const ch = uniqueChannel();
    seedLegacy(ch, ['host'], 'host');
    const io = makeIo();
    const socket = makeSocket();
    wire('stranger', { io, socket });

    await socket._trigger('activity:leave', { channelId: ch });

    expect([...getActivitySession(ch)!.participants]).toEqual(['host']);
    expect(io._emitted).toHaveLength(0);
  });
});

describe('join races', () => {
  async function existingSession() {
    const ch = uniqueChannel();
    const io = makeIo();
    const host = makeSocket();
    wire('host', { io, socket: host });
    await host._trigger('activity:start', { activityId: 'chess', channelId: ch, serverId: 'srv-1' });
    return { ch, io, sessionId: getActivitySession(ch)!.sessionId };
  }

  it('a stale session id cannot join', async () => {
    const { ch } = await existingSession();
    const guest = makeSocket();
    wire('guest', { socket: guest });

    await guest._trigger('activity:join', { channelId: ch, sessionId: 'not-this-one' });

    expect(errorsOf(guest)).toHaveLength(1);
    expect([...getActivitySession(ch)!.participants]).toEqual(['host']);
  });

  it('a session deleted between the read and the lock is not joined', async () => {
    const { ch, sessionId } = await existingSession();
    const guest = makeSocket();
    wire('guest', { socket: guest });

    const original = activityStore.withLock.bind(activityStore);
    const spy = jest.spyOn(activityStore, 'withLock').mockImplementationOnce(async (channelId, fn) => {
      activityStore._localSessions_TEST_ONLY.delete(channelId);
      return original(channelId, fn);
    });
    try {
      await guest._trigger('activity:join', { channelId: ch, sessionId });
    } finally { spy.mockRestore(); }

    expect(errorsOf(guest)).toHaveLength(1);
    expect(getActivitySession(ch)).toBeUndefined();
  });

  it('a session that changed server between the read and the lock is not joined', async () => {
    const { ch, sessionId } = await existingSession();
    const guest = makeSocket();
    wire('guest', { socket: guest });

    const original = activityStore.withLock.bind(activityStore);
    const spy = jest.spyOn(activityStore, 'withLock').mockImplementationOnce(async (channelId, fn) => {
      // Replace the stored session with a DIFFERENT object, the way another
      // node's write would: mutating the observed object in place would leave
      // both sides pointing at the same reference and prove nothing.
      const observed = activityStore._localSessions_TEST_ONLY.get(channelId)!;
      activityStore._localSessions_TEST_ONLY.set(channelId, {
        ...observed,
        serverId: 'srv-somewhere-else',
        participants: new Set(observed.participants),
        participantSockets: new Map(observed.participantSockets ?? []),
      });
      return original(channelId, fn);
    });
    try {
      await guest._trigger('activity:join', { channelId: ch, sessionId });
    } finally { spy.mockRestore(); }

    expect(errorsOf(guest)).toHaveLength(1);
    expect([...getActivitySession(ch)!.participants]).toEqual(['host']);
  });

  it('a guest without channel permission cannot join an existing session', async () => {
    const { ch, sessionId } = await existingSession();
    const guest = makeSocket();
    wire('guest', { socket: guest });
    mockHasPerm.mockReturnValue(false);

    await guest._trigger('activity:join', { channelId: ch, sessionId });

    expect(errorsOf(guest)[0]!.data).toEqual({ message: 'Bu aktiviteye erişim izniniz yok.' });
    expect([...getActivitySession(ch)!.participants]).toEqual(['host']);
  });
});

describe('activity:list', () => {
  it('returns null for a channel with no activity', async () => {
    const { socket } = wire('u1');
    await socket._trigger('activity:list', { channelId: uniqueChannel() });
    expect(socket._emitted).toEqual([{ ev: 'activity:list_result', data: null }]);
  });

  it('returns null rather than leaking a session to an unauthorized caller', async () => {
    const ch = uniqueChannel();
    const host = makeSocket();
    wire('host', { socket: host });
    await host._trigger('activity:start', { activityId: 'chess', channelId: ch, serverId: 'srv-1' });

    const stranger = makeSocket();
    wire('stranger', { socket: stranger });
    mockHasPerm.mockReturnValue(false);
    await stranger._trigger('activity:list', { channelId: ch });

    expect(stranger._emitted).toEqual([{ ev: 'activity:list_result', data: null }]);
  });

  it('returns the serialized session to an authorized caller', async () => {
    const ch = uniqueChannel();
    const host = makeSocket();
    wire('host', { socket: host });
    await host._trigger('activity:start', { activityId: 'chess', channelId: ch, serverId: 'srv-1' });

    const guest = makeSocket();
    wire('guest', { socket: guest });
    await guest._trigger('activity:list', { channelId: ch });

    expect(guest._emitted[0]!.data).toMatchObject({
      activityId: 'chess', channelId: ch, serverId: 'srv-1',
      hostUserId: 'host', participants: ['host'],
    });
  });
});
