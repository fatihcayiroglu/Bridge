// server/tests/thread-socket.test.ts
// registerThreadSocketEvents socket entegrasyon testleri
// Test kapsamı:
//   - thread:message:new  (kanal odasına ve thread odasına broadcast)
//   - thread:join         (thread odasına katılma, eski thread odasından çıkma)
//   - thread:leave        (thread odasından ayrılma)
//   - Edge case: eksik threadId / msg, boş content

'use strict';
process.env.NODE_ENV = 'test';

// messages.js bazı db/loader kullanımı yapabilir — stub'la
jest.mock('../db/loader', () => {
  const { createMockDb } = require('./helpers/mockDb');
  return createMockDb();
});

import { registerThreadSocketEvents } from '../socket/handlers/messages';

// ── Yardımcılar ────────────────────────────────────────────────

function makeSocket(id) {
  const handlers: Record<string, unknown> = {};
  const emitted  = [];
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
    _trigger(event, data) {
      if (handlers[event]) handlers[event](data);
    },
  };
  return socket;
}

function makeIo() {
  const emitted = [];
  return {
    _emitted: emitted,
    to(target) {
      return { emit(ev, data) { emitted.push({ ev, data, _target: target }); } };
    },
  };
}

function makeUser(overrides = {}) {
  return {
    _id:         `u-${Math.random().toString(36).slice(2)}`,
    displayName: 'ThreadUser',
    avatarColor: '#2d9cdb',
    ...overrides,
  };
}

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
  it('socket thread odasına katılır', () => {
    const user   = makeUser();
    const socket = makeSocket('s-tjoin-1');
    const io     = makeIo();
    registerThreadSocketEvents(socket, io, user);

    socket._trigger('thread:join', 'thread-123');

    expect(socket._rooms.has('thread:thread-123')).toBe(true);
  });

  it('yeni thread odasına katılınca önceki thread odası terk edilir', () => {
    const user   = makeUser();
    const socket = makeSocket('s-tjoin-switch');
    const io     = makeIo();
    registerThreadSocketEvents(socket, io, user);

    socket._trigger('thread:join', 'thread-AAA');
    expect(socket._rooms.has('thread:thread-AAA')).toBe(true);

    socket._trigger('thread:join', 'thread-BBB');
    expect(socket._rooms.has('thread:thread-BBB')).toBe(true);
    expect(socket._rooms.has('thread:thread-AAA')).toBe(false);
  });

  it('aynı thread odasına iki kez katılmak sorun çıkarmaz', () => {
    const user   = makeUser();
    const socket = makeSocket('s-tjoin-dup');
    const io     = makeIo();
    registerThreadSocketEvents(socket, io, user);

    socket._trigger('thread:join', 'thread-DUP');
    socket._trigger('thread:join', 'thread-DUP');

    expect(socket._rooms.has('thread:thread-DUP')).toBe(true);
    // Hata fırlatmamış olmalı — test zaten geçerse OK
  });

  it('thread:join önceki DM/kanal odalarını etkilemez', () => {
    const user   = makeUser();
    const socket = makeSocket('s-tjoin-iso');
    const io     = makeIo();
    registerThreadSocketEvents(socket, io, user);

    // Diğer tip odaları manuel olarak ekle
    socket.join('channel:ch-1');
    socket.join('dm:dm-abc');

    socket._trigger('thread:join', 'thread-NEW');

    // Sadece thread odaları temizlenmeli
    expect(socket._rooms.has('channel:ch-1')).toBe(true);
    expect(socket._rooms.has('dm:dm-abc')).toBe(true);
    expect(socket._rooms.has('thread:thread-NEW')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
// thread:leave
// ════════════════════════════════════════════════════════════════

describe('thread:leave', () => {
  it('socket thread odasından ayrılır', () => {
    const user   = makeUser();
    const socket = makeSocket('s-tleave-1');
    const io     = makeIo();
    registerThreadSocketEvents(socket, io, user);

    socket._trigger('thread:join',  'thread-leave-test');
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

  it('leave sonrası diğer odalar etkilenmez', () => {
    const user   = makeUser();
    const socket = makeSocket('s-tleave-iso');
    const io     = makeIo();
    registerThreadSocketEvents(socket, io, user);

    socket._trigger('thread:join', 'thread-A');
    socket._trigger('thread:join', 'thread-B'); // Bu thread-A'yı zaten çıkarır
    socket.join('thread:thread-extra');           // Manuel ekle

    socket._trigger('thread:leave', 'thread-B');

    expect(socket._rooms.has('thread:thread-B')).toBe(false);
    expect(socket._rooms.has('thread:thread-extra')).toBe(true);
  });
});
