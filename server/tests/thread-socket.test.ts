// server/tests/thread-socket.test.ts
// registerThreadSocketEvents socket entegrasyon testleri
// Test kapsamı:
//   - thread:message:new  (kanal odasına ve thread odasına broadcast)
//   - thread:join         (thread odasına katılma, eski thread odasından çıkma)
//   - thread:leave        (thread odasından ayrılma)
//   - Edge case: eksik threadId / msg, boş content
import { EmittedLog, SocketDouble } from './helpers/socketDoubles';

'use strict';
process.env.NODE_ENV = 'test';

const mockFindThread = jest.fn();
const mockFindMember = jest.fn();
const mockResolvePermissions = jest.fn();

jest.mock('../db/repositories', () => ({
  Threads: { findById: (...args: unknown[]) => mockFindThread(...args) },
  Members: { findOne: (...args: unknown[]) => mockFindMember(...args) },
}));

jest.mock('../lib/permissions', () => ({
  PERMS: { VIEW_CHANNELS: 1, READ_HISTORY: 2 },
  resolvePermissions: (...args: unknown[]) => mockResolvePermissions(...args),
  hasPermission: (mask: number, bit: number) => (mask & bit) === bit,
}));

import { registerThreadSocketEvents } from '../socket/handlers/messages';
import type { AuthUser } from '../socket/handlers/messages-types';
import { deferred } from './helpers/deferred';

// ── Yardımcılar ────────────────────────────────────────────────

function makeSocket(id: string) {
  const handlers: Record<string, unknown> = {};
  const emitted: EmittedLog = [];
  const rooms    = new Set([id]);

  const socket = {
    id,
    rooms,
    on(event, fn)  { handlers[event] = fn; },
    emit(ev, data) { emitted.push({ ev, data }); },
    join(room)     { rooms.add(room); },
    leave(room)    { rooms.delete(room); },
    to(room) {
      return { emit(ev, data) { emitted.push({ ev, data, _room: room }); } };
    },
    _handlers: handlers,
    _emitted:  emitted,
    _rooms:    rooms,
    _trigger(event: string, data: unknown) {
      // `handlers` degerleri `unknown`tur (dogrusu budur: `on()` sozlesmesi
      // dinleyiciyi saklamak zorunda degil). Cagrilabilirlik IDDIA edilmez,
      // DENETLENIR — kayitli olmayan bir olay sessizce `undefined` doner.
      const fn = handlers[event];
      return typeof fn === 'function' ? (fn as (payload: unknown) => unknown)(data) : undefined;
    },
  } satisfies SocketDouble;
  return socket;
}

function makeIo() {
  const emitted: EmittedLog = [];
  return {
    _emitted: emitted,
    to(target: string) {
      return { emit(ev: string, data: unknown) { emitted.push({ ev, data, _target: target }); } };
    },
  };
}

// Urun sozlesmesi `AuthUser`dir ve `username` ISTER. Ikiz onu tasimiyordu;
// bu, 11 cagri yerinde TS2345 uretiyor ve daha onemlisi testi urunun
// gercekten gordugu nesneden uzaklastiriyordu.
function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  const id = `u-${Math.random().toString(36).slice(2)}`;
  return {
    _id:         id,
    username:    id,
    displayName: 'ThreadUser',
    avatarColor: '#2d9cdb',
    ...overrides,
  };
}

beforeEach(() => {
  mockFindThread.mockReset();
  mockFindMember.mockReset();
  mockResolvePermissions.mockReset();
  mockFindThread.mockImplementation(async (threadId) => ({ _id: threadId, serverId: 'srv-1', channelId: 'ch-1' }));
  mockFindMember.mockResolvedValue({ userId: 'member', serverId: 'srv-1' });
  mockResolvePermissions.mockResolvedValue(1 | 2);
});

// ════════════════════════════════════════════════════════════════
// thread:message:new
// ════════════════════════════════════════════════════════════════

describe('thread:message:new', () => {
  it('rejects valid-looking client payloads without broadcasting', () => {
    const user = makeUser();
    const socket = makeSocket('s-tmsg-1');
    const io = makeIo();
    registerThreadSocketEvents(socket, io, user);

    const msg = { _id: 'msg-1', threadId: 'thread-abc', channelId: 'ch-general', content: 'Thread response', userId: user._id };
    socket._trigger('thread:message:new', { threadId: 'thread-abc', msg });

    expect(io._emitted).toHaveLength(0);
  });

  it('rejects malformed client payloads without broadcasting', () => {
    const user = makeUser();
    const socket = makeSocket('s-tmsg-invalid');
    const io = makeIo();
    registerThreadSocketEvents(socket, io, user);

    expect(() => socket._trigger('thread:message:new', { threadId: 'thread-abc' })).not.toThrow();
    socket._trigger('thread:message:new', { msg: { channelId: 'ch-general', content: 'test' } });

    expect(io._emitted).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════
// thread:join
// ════════════════════════════════════════════════════════════════

describe('thread:join', () => {
  it('socket thread odasına katılır', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-tjoin-1');
    const io     = makeIo();
    registerThreadSocketEvents(socket, io, user);

    await socket._trigger('thread:join', 'thread-123');

    expect(socket._rooms.has('thread:thread-123')).toBe(true);
  });

  it('yeni thread odasına katılınca önceki thread odası terk edilir', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-tjoin-switch');
    const io     = makeIo();
    registerThreadSocketEvents(socket, io, user);

    await socket._trigger('thread:join', 'thread-AAA');
    expect(socket._rooms.has('thread:thread-AAA')).toBe(true);

    await socket._trigger('thread:join', 'thread-BBB');
    expect(socket._rooms.has('thread:thread-BBB')).toBe(true);
    expect(socket._rooms.has('thread:thread-AAA')).toBe(false);
  });

  it('aynı thread odasına iki kez katılmak sorun çıkarmaz', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-tjoin-dup');
    const io     = makeIo();
    registerThreadSocketEvents(socket, io, user);

    await socket._trigger('thread:join', 'thread-DUP');
    await socket._trigger('thread:join', 'thread-DUP');

    expect(socket._rooms.has('thread:thread-DUP')).toBe(true);
    // Hata fırlatmamış olmalı — test zaten geçerse OK
  });

  it('thread:join önceki DM/kanal odalarını etkilemez', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-tjoin-iso');
    const io     = makeIo();
    registerThreadSocketEvents(socket, io, user);

    // Diğer tip odaları manuel olarak ekle
    socket.join('channel:ch-1');
    socket.join('dm:dm-abc');

    await socket._trigger('thread:join', 'thread-NEW');

    // Sadece thread odaları temizlenmeli
    expect(socket._rooms.has('channel:ch-1')).toBe(true);
    expect(socket._rooms.has('dm:dm-abc')).toBe(true);
    expect(socket._rooms.has('thread:thread-NEW')).toBe(true);
  });
});


  it('slower stale join cannot overwrite a newer thread selection', async () => {
    const user = makeUser();
    const socket = makeSocket('s-tjoin-race');
    const io = makeIo();
    registerThreadSocketEvents(socket, io, user);

    // Cozucu fonksiyonlar `Promise` yapicisinin ICINDE atanir; TypeScript bu
    // atamayi goremez. `deferred()` bunu KESIN ATAMA IDDIASI (`!`) olmadan,
    // dogrulayarak cozer — bkz. helpers/deferred.ts.
    type ThreadRow = { _id: string; serverId: string; channelId: string };
    const a = deferred<ThreadRow>();
    const b = deferred<ThreadRow>();
    mockFindThread.mockImplementation((id: unknown) => id === 'thread-A' ? a.promise : b.promise);

    const pendingA = socket._trigger('thread:join', 'thread-A');
    const pendingB = socket._trigger('thread:join', 'thread-B');
    b.resolve({ _id: 'thread-B', serverId: 'srv-1', channelId: 'ch-1' });
    await pendingB;
    a.resolve({ _id: 'thread-A', serverId: 'srv-1', channelId: 'ch-1' });
    await pendingA;

    expect(socket._rooms.has('thread:thread-B')).toBe(true);
    expect(socket._rooms.has('thread:thread-A')).toBe(false);
    expect(socket._emitted.filter(e => e.ev === 'thread:joined')).toEqual([
      { ev: 'thread:joined', data: { threadId: 'thread-B' } },
    ]);
  });

// ════════════════════════════════════════════════════════════════
// thread:leave
// ════════════════════════════════════════════════════════════════

describe('thread:leave', () => {
  it('socket thread odasından ayrılır', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-tleave-1');
    const io     = makeIo();
    registerThreadSocketEvents(socket, io, user);

    await socket._trigger('thread:join',  'thread-leave-test');
    expect(socket._rooms.has('thread:thread-leave-test')).toBe(true);

    socket._trigger('thread:leave', 'thread-leave-test');
    expect(socket._rooms.has('thread:thread-leave-test')).toBe(false);
  });

  it('katılmadığı thread odasından ayrılmak hata fırlatmaz', () => {
    const user   = makeUser();
    const socket = makeSocket('s-tleave-noop');
    const io     = makeIo();
    registerThreadSocketEvents(socket, io, user);

    expect(() => socket._trigger('thread:leave', 'nonexistent-thread')).not.toThrow();
  });

  it('leave sonrası diğer odalar etkilenmez', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-tleave-iso');
    const io     = makeIo();
    registerThreadSocketEvents(socket, io, user);

    await socket._trigger('thread:join', 'thread-A');
    await socket._trigger('thread:join', 'thread-B'); // Bu thread-A'yı zaten çıkarır
    socket.join('thread:thread-extra');           // Manuel ekle

    socket._trigger('thread:leave', 'thread-B');

    expect(socket._rooms.has('thread:thread-B')).toBe(false);
    expect(socket._rooms.has('thread:thread-extra')).toBe(true);
  });
});
