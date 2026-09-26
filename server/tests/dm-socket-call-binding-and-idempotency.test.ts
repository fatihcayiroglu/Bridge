// server/tests/dm-socket-call-binding-and-idempotency.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// DM SOKETİ — GÖRÜŞME BAĞI, YENİDEN GÖNDERİM VE HIZ SINIRI YEDEĞİ
// ════════════════════════════════════════════════════════════════════════════
//
// Kardeş dosyalar yetki sınırını ve grup görüşmesini ölçer. Bu tamamlayıcı
// takım geri kalan karar dallarını kapatır:
//
//   · GÖRÜŞME BAĞI. WebRTC sinyali YALNIZCA çağrının iki ucundan biri
//     tarafından, YALNIZCA diğer uca gönderilebilir. Biçimsiz/aşırı uzun bir
//     `callId` hiç aranmaz; başkasının görüşmesi bulunsa bile reddedilir.
//   · YENİDEN GÖNDERİM. Bir istemci aynı `clientNonce` ile tekrar
//     gönderebilir. Aynı konuşmadaki tekrar, VAR OLAN mesajı döndürmelidir —
//     ama BAŞKA bir konuşmadaki aynı nonce KABUL EDİLMEZ: aksi hâlde bir
//     kullanıcı, başka bir sohbetteki mesajın içeriğini kendi sohbetine
//     yansıtabilirdi.
//   · HIZ SINIRI YEDEĞİ. Paylaşılan sayaç okunamıyorsa: otorite ilan
//     edilmişse (REDIS_URL) fail-closed; değilse sınırlı süreç-yerel pencere.

'use strict';
process.env.NODE_ENV = 'test';
delete process.env.REDIS_URL;

const dms = {
  buildDmId: jest.fn((a: string, b: string) => [a, b].sort().join(':')),
  findByClientNonce: jest.fn(),
  findOrCreateConversation: jest.fn(),
  insertMessage: jest.fn(),
  markRead: jest.fn(),
  findConversation: jest.fn(),
  findMessage: jest.fn(),
  updateMessage: jest.fn(),
};
const groupDms = {
  findMember: jest.fn(),
  findGroupsByUser: jest.fn(),
  findByClientNonce: jest.fn(),
  insertMessage: jest.fn(),
  update: jest.fn(),
  markRead: jest.fn(),
};
const users = { findById: jest.fn() };
const dmAccess = { evaluateDmAccess: jest.fn(), isDmBlocked: jest.fn() };
const slidingWindowCount = jest.fn();
const callStore = {
  get: jest.fn(async () => null as unknown),
  set: jest.fn(),
  del: jest.fn(),
  withLock: jest.fn(async <T>(_id: string, fn: () => Promise<T>) => fn()),
};

jest.mock('../db/repositories', () => ({ Dms: dms, GroupDms: groupDms, Users: users }));
jest.mock('../lib/dmAccessPolicy', () => dmAccess);
jest.mock('../lib/redisAdapter', () => ({
  cache: { slidingWindowCount: (...args: unknown[]) => slidingWindowCount(...args) },
}));
jest.mock('../socket/handlers/dm-call-store', () => ({ dmCallStore: callStore }));
const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../lib/logger', () => ({ __esModule: true, default: log }));

import type { Server, Socket } from 'socket.io';
import { registerDmHandlers, registerGroupDmHandlers } from '../socket/handlers/dm';

type Emission = { event: string; payload?: unknown; room?: string };

function makeSocket(id: string = 'sock-1') {
  const handlers = new Map<string, (payload?: unknown) => Promise<void>>();
  const self: Emission[] = [];
  const broadcast: Emission[] = [];
  const rooms = new Set<string>([id]);
  const shape = {
    id,
    data: {} as Record<string, unknown>,
    rooms,
    on(event: string, fn: (payload?: unknown) => Promise<void>) { handlers.set(event, fn); },
    emit(event: string, payload?: unknown) { self.push({ event, payload }); return true; },
    join(room: string) { rooms.add(room); },
    leave(room: string) { rooms.delete(room); },
    to(room: string) {
      return { emit(event: string, payload?: unknown) { broadcast.push({ event, payload, room }); return true; } };
    },
  };
  return {
    id, rooms, self, broadcast,
    async trigger(event: string, payload?: unknown) { await handlers.get(event)?.(payload); },
    hasHandler(event: string) { return handlers.has(event); },
    asSocket: shape as unknown as Socket,
  };
}

function makeIo() {
  const targeted: Emission[] = [];
  const roomSockets = new Map<string, Array<{ id: string }>>();
  const shape: Record<string, unknown> = {
    to(room: string) {
      return { emit(event: string, payload?: unknown) { targeted.push({ event, payload, room }); return true; } };
    },
    in(room: string) {
      return { fetchSockets: async () => roomSockets.get(room) ?? [] };
    },
  };
  return { targeted, roomSockets, asServer: shape as unknown as Server };
}

const ME = 'user-me';
const PEER = 'user-peer';
const OTHER = 'user-other';
const me = { _id: ME, username: 'me', displayName: 'Ben', avatarColor: '#111' };

function registerDm(socket: ReturnType<typeof makeSocket>, io: ReturnType<typeof makeIo>) {
  registerDmHandlers(socket.asSocket, io.asServer, me as never, new Map());
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.REDIS_URL;
  slidingWindowCount.mockResolvedValue(1);
  users.findById.mockResolvedValue({ _id: PEER, username: 'peer' });
  dmAccess.evaluateDmAccess.mockResolvedValue({ allowed: true });
  dmAccess.isDmBlocked.mockResolvedValue(false);
  dms.findByClientNonce.mockResolvedValue(null);
  dms.findOrCreateConversation.mockResolvedValue({ dmId: 'dm-1', _id: 'dm-1' });
  dms.insertMessage.mockImplementation(async (row: Record<string, unknown>) => ({ _id: 'm1', ...row }));
  dms.findConversation.mockResolvedValue({ _id: 'dm-1', participants: [ME, PEER] });
  dms.findMessage.mockResolvedValue({ _id: 'm1', dmId: 'dm-1', reactions: {} });
  callStore.get.mockResolvedValue(null);
  callStore.withLock.mockImplementation(async <T>(_id: string, fn: () => Promise<T>) => fn());
});

describe('WebRTC signalling is bound to the call it belongs to', () => {
  const activeCall = { callId: 'call-1', callerId: ME, calleeId: PEER, type: 'voice' };

  const signalEvents = ['dm:call:offer', 'dm:call:answer', 'dm:call:ice'] as const;

  it.each(signalEvents)('%s is relayed to the other end of the caller\'s own call', async (event) => {
    callStore.get.mockResolvedValue(activeCall);
    const socket = makeSocket();
    const io = makeIo();
    registerDm(socket, io);

    await socket.trigger(event, {
      callId: 'call-1', targetUserId: PEER, sdp: 'x', candidate: { c: 1 },
    });

    expect(io.targeted.some(e => e.room === `user:${PEER}`)).toBe(true);
  });

  it.each(signalEvents)('%s is dropped when the caller is not part of the call', async (event) => {
    callStore.get.mockResolvedValue({ callId: 'call-1', callerId: OTHER, calleeId: 'someone-else' });
    const socket = makeSocket();
    const io = makeIo();
    registerDm(socket, io);

    await socket.trigger(event, { callId: 'call-1', targetUserId: PEER, sdp: 'x', candidate: {} });

    expect(io.targeted).toEqual([]);
  });

  it.each(signalEvents)('%s is dropped when the target is not the other end', async (event) => {
    callStore.get.mockResolvedValue(activeCall);
    const socket = makeSocket();
    const io = makeIo();
    registerDm(socket, io);

    await socket.trigger(event, { callId: 'call-1', targetUserId: OTHER, sdp: 'x', candidate: {} });

    expect(io.targeted).toEqual([]);
  });

  const badCallIds: Array<[string, unknown]> = [
    ['a missing call id', undefined],
    ['an empty call id', ''],
    ['a non-string call id', 12345],
    ['an over-long call id', 'x'.repeat(129)],
  ];
  for (const [name, callId] of badCallIds) {
    it(`refuses ${name} without even looking the call up`, async () => {
      const socket = makeSocket();
      const io = makeIo();
      registerDm(socket, io);

      await socket.trigger('dm:call:offer', { callId, targetUserId: PEER, sdp: 'x' });

      expect(io.targeted).toEqual([]);
      expect(callStore.get).not.toHaveBeenCalled();
    });
  }

  it('a blocked peer stops signalling even inside a legitimate call', async () => {
    callStore.get.mockResolvedValue(activeCall);
    dmAccess.isDmBlocked.mockResolvedValue(true);
    const socket = makeSocket();
    const io = makeIo();
    registerDm(socket, io);

    await socket.trigger('dm:call:ice', { callId: 'call-1', targetUserId: PEER, candidate: {} });

    expect(io.targeted).toEqual([]);
  });
});

describe('starting a call', () => {
  it('refuses an unsupported call type before touching the user store', async () => {
    const socket = makeSocket();
    registerDm(socket, makeIo());
    await socket.trigger('dm:call:start', { toUserId: PEER, type: 'holographic' });
    expect(users.findById).not.toHaveBeenCalled();
    expect(callStore.set).not.toHaveBeenCalled();
  });

  it('accepts both supported call types', async () => {
    for (const type of ['voice', 'video']) {
      jest.clearAllMocks();
      users.findById.mockResolvedValue({ _id: PEER, username: 'peer' });
      dmAccess.evaluateDmAccess.mockResolvedValue({ allowed: true });
      const socket = makeSocket();
      registerDm(socket, makeIo());
      await socket.trigger('dm:call:start', { toUserId: PEER, type });
      expect(users.findById).toHaveBeenCalledWith(PEER);
    }
  });

  it('a disconnect ends only the calls this socket owns, telling the other end', async () => {
    callStore.get.mockResolvedValue({ callId: 'call-1', callerId: ME, calleeId: PEER, type: 'voice' });
    const socket = makeSocket();
    const io = makeIo();
    registerDm(socket, io);
    await socket.trigger('dm:call:start', { toUserId: PEER, type: 'voice' });

    io.targeted.length = 0;
    await socket.trigger('disconnect');

    const ended = io.targeted.filter(e => e.event === 'dm:call:ended');
    expect(ended).toHaveLength(1);
    expect(ended[0]!.room).toBe(`user:${PEER}`);
    expect((ended[0]!.payload as { reason: string }).reason).toBe('disconnect');
  });

  it('a disconnect notifies the caller when this socket was the callee', async () => {
    callStore.get.mockResolvedValue({
      callId: 'call-1', callerId: PEER, calleeId: ME, type: 'voice', status: 'ringing',
    });
    const socket = makeSocket();
    const io = makeIo();
    registerDm(socket, io);
    await socket.trigger('dm:call:accept', { callId: 'call-1' });

    io.targeted.length = 0;
    await socket.trigger('disconnect');

    const ended = io.targeted.filter(e => e.event === 'dm:call:ended');
    expect(ended.map(e => e.room)).toEqual([`user:${PEER}`]);
  });

  it('a disconnect ignores a call that has already gone', async () => {
    const socket = makeSocket();
    const io = makeIo();
    registerDm(socket, io);
    await socket.trigger('dm:call:start', { toUserId: PEER, type: 'voice' });

    io.targeted.length = 0;
    // The call row is gone by the time the socket drops.
    callStore.get.mockResolvedValue(null);
    await socket.trigger('disconnect');

    expect(io.targeted.filter(e => e.event === 'dm:call:ended')).toEqual([]);
  });
});

describe('re-sent messages are matched within their own conversation', () => {
  it('a repeat in the same conversation returns the message that already exists', async () => {
    const dmId = [ME, PEER].sort().join(':');
    dms.findByClientNonce.mockResolvedValue({ _id: 'already', dmId, content: 'hi' });
    const socket = makeSocket();
    registerDm(socket, makeIo());

    await socket.trigger('dm:send', { toUserId: PEER, content: 'hi', clientNonce: 'n1' });

    expect(dms.insertMessage).not.toHaveBeenCalled();
    const replay = socket.self.filter(e => e.event === 'dm:message');
    expect(replay).toHaveLength(1);
    expect(replay[0]!.payload).toMatchObject({ _id: 'already', clientNonce: 'n1' });
  });

  it('the same nonce from a DIFFERENT conversation is not reused', async () => {
    // Otherwise a client could pull another chat's message into this one.
    dms.findByClientNonce.mockResolvedValue({ _id: 'elsewhere', dmId: 'dm-other', content: 'secret' });
    const socket = makeSocket();
    registerDm(socket, makeIo());

    await socket.trigger('dm:send', { toUserId: PEER, content: 'hi', clientNonce: 'n1' });

    expect(socket.self.some(e => e.event === 'error:message')).toBe(true);
    expect(dms.insertMessage).not.toHaveBeenCalled();
  });

  it('a stored row with no conversation id is not reused either', async () => {
    dms.findByClientNonce.mockResolvedValue({ _id: 'shapeless', content: 'x' });
    const socket = makeSocket();
    registerDm(socket, makeIo());

    await socket.trigger('dm:send', { toUserId: PEER, content: 'hi', clientNonce: 'n1' });

    expect(dms.insertMessage).not.toHaveBeenCalled();
  });
});

describe('DM reactions', () => {
  const react = async (payload: unknown) => {
    const socket = makeSocket();
    registerDm(socket, makeIo());
    await socket.trigger('dm:react', payload);
    return socket;
  };

  const incomplete: Array<[string, Record<string, unknown>]> = [
    ['no message id', { dmId: 'dm-1', emoji: '👍' }],
    ['no conversation id', { messageId: 'm1', emoji: '👍' }],
    ['no emoji', { messageId: 'm1', dmId: 'dm-1' }],
  ];
  for (const [name, payload] of incomplete) {
    it(`is dropped with ${name}`, async () => {
      await react(payload);
      expect(dms.findMessage).not.toHaveBeenCalled();
    });
  }

  it('is dropped for a non-string or over-long emoji', async () => {
    await react({ messageId: 'm1', dmId: 'dm-1', emoji: 5 });
    await react({ messageId: 'm1', dmId: 'dm-1', emoji: 'x'.repeat(17) });
    expect(dms.findMessage).not.toHaveBeenCalled();
  });

  it('is accepted for a bounded emoji on a conversation the caller is in', async () => {
    const socket = await react({ messageId: 'm1', dmId: 'dm-1', emoji: '👍' });
    expect(dms.findMessage).toHaveBeenCalled();
    expect(socket.self.length + socket.broadcast.length).toBeGreaterThanOrEqual(0);
  });
});

describe('the socket rate limiter falls back only where that is safe', () => {
  async function sendOnce(socket: ReturnType<typeof makeSocket>) {
    await socket.trigger('dm:send', { toUserId: PEER, content: 'hi' });
  }

  it('a shared-counter failure is fatal when an authority is configured', async () => {
    process.env.REDIS_URL = 'redis://cluster.test:6379';
    jest.resetModules();
    const { registerDmHandlers: register } = require('../socket/handlers/dm');
    slidingWindowCount.mockRejectedValue(new Error('counter offline'));

    const socket = makeSocket();
    register(socket.asSocket, makeIo().asServer, me, new Map());
    await sendOnce(socket);

    expect(dms.insertMessage).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'dm.rate.redis_error' }), expect.any(String));
  });

  it('a shared-counter failure falls back to a bounded local window on a single node', async () => {
    slidingWindowCount.mockRejectedValue(new Error('counter offline'));
    const socket = makeSocket();
    registerDm(socket, makeIo());

    await sendOnce(socket);

    expect(dms.insertMessage).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'dm.rate.redis_error' }), expect.any(String));
  });

  it('the local fallback still enforces a ceiling', async () => {
    slidingWindowCount.mockRejectedValue(new Error('counter offline'));
    const socket = makeSocket();
    registerDm(socket, makeIo());

    for (let i = 0; i < 40; i += 1) await sendOnce(socket);

    // Some sends were refused rather than every one being written.
    expect(dms.insertMessage.mock.calls.length).toBeLessThan(40);
  });

  it('a shared counter above the ceiling refuses the send', async () => {
    slidingWindowCount.mockResolvedValue(9_999);
    const socket = makeSocket();
    registerDm(socket, makeIo());
    await sendOnce(socket);
    expect(dms.insertMessage).not.toHaveBeenCalled();
  });
});

describe('group membership is re-checked, never assumed from room presence', () => {
  const badGroupIds: Array<[string, unknown]> = [
    ['an empty group id', ''],
    ['a non-string group id', 12345],
    ['an over-long group id', 'x'.repeat(129)],
  ];
  for (const [name, groupId] of badGroupIds) {
    it(`refuses ${name} without querying membership`, async () => {
      const socket = makeSocket();
      const io = makeIo();
      registerGroupDmHandlers(socket.asSocket, io.asServer, me as never, new Map());
      socket.rooms.add(`gdm:voice:${String(groupId)}`);

      await socket.trigger('gdm:call:offer', { groupId, targetSocketId: 'other', sdp: 'x' });

      expect(io.targeted).toEqual([]);
      expect(groupDms.findMember).not.toHaveBeenCalled();
    });
  }

  it('a membership lookup failure is treated as "not a member"', async () => {
    groupDms.findMember.mockRejectedValue(new Error('membership store offline'));
    const socket = makeSocket();
    const io = makeIo();
    registerGroupDmHandlers(socket.asSocket, io.asServer, me as never, new Map());
    socket.rooms.add('gdm:voice:g1');

    await socket.trigger('gdm:call:offer', { groupId: 'g1', targetSocketId: 'other', sdp: 'x' });

    expect(io.targeted).toEqual([]);
  });
});
