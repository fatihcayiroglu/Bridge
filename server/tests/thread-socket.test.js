// server/tests/thread-socket.test.js
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

const { registerThreadSocketEvents } = require('../socket/handlers/messages');

// ── Yardımcılar ────────────────────────────────────────────────

function makeSocket(id) {
  const handlers = {};
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
    avatarColor: '#5865f2',
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════
// thread:message:new
// ════════════════════════════════════════════════════════════════

describe('thread:message:new', () => {
  it('kanal odasına thread:message:new broadcast edilir', () => {
    const user   = makeUser();
    const socket = makeSocket('s-tmsg-1');
    const io     = makeIo();
    registerThreadSocketEvents(socket, io, user);

    const msg = {
      _id:       'msg-1',
      threadId:  'thread-abc',
      channelId: 'ch-general',
      content:   'Thread yanıtı',
      userId:    user._id,
    };

    socket._trigger('thread:message:new', { threadId: 'thread-abc', msg });

    const toChannel = io._emitted.find(
      e => e.ev === 'thread:message:new' && e._target === 'channel:ch-general'
    );
    expect(toChannel).toBeDefined();
    expect(toChannel.data.threadId).toBe('thread-abc');
    expect(toChannel.data.msg).toEqual(msg);
  });

  it('thread odasına da thread:message:new broadcast edilir', () => {
    const user   = makeUser();
    const socket = makeSocket('s-tmsg-2');
    const io     = makeIo();
    registerThreadSocketEvents(socket, io, user);

    const msg = {
      _id:       'msg-2',
      threadId:  'thread-xyz',
      channelId: 'ch-dev',
      content:   'İkinci yanıt',
      userId:    user._id,
    };

    socket._trigger('thread:message:new', { threadId: 'thread-xyz', msg });

    const toThread = io._emitted.find(
      e => e.ev === 'thread:message:new' && e._target === 'thread:thread-xyz'
    );
    expect(toThread).toBeDefined();
    expect(toThread.data.threadId).toBe('thread-xyz');
  });

  it('hem kanal hem thread odasına aynı anda emit edilir', () => {
    const user   = makeUser();
    const socket = makeSocket('s-tmsg-3');
    const io     = makeIo();
    registerThreadSocketEvents(socket, io, user);

    const msg = {
      _id: 'msg-3', threadId: 'th-1', channelId: 'ch-1', content: 'Çift broadcast', userId: user._id,
    };

    socket._trigger('thread:message:new', { threadId: 'th-1', msg });

    const toChannel = io._emitted.filter(e => e.ev === 'thread:message:new' && e._target === 'channel:ch-1');
    const toThread  = io._emitted.filter(e => e.ev === 'thread:message:new' && e._target === 'thread:th-1');

    expect(toChannel).toHaveLength(1);
    expect(toThread).toHaveLength(1);
  });

  it('channelId yoksa kanal odasına emit yapılmaz', () => {
    const user   = makeUser();
    const socket = makeSocket('s-tmsg-noch');
    const io     = makeIo();
    registerThreadSocketEvents(socket, io, user);

    // channelId'siz mesaj
    const msg = { _id: 'msg-4', threadId: 'th-2', content: 'Kanalsız', userId: user._id };

    socket._trigger('thread:message:new', { threadId: 'th-2', msg });

    const toChannel = io._emitted.find(e => e._target?.startsWith('channel:'));
    expect(toChannel).toBeUndefined();

    // Thread odasına yine de gönderilmeli
    const toThread = io._emitted.find(e => e._target === 'thread:th-2');
    expect(toThread).toBeDefined();
  });

  it('threadId eksikse işlem yapılmaz', () => {
    const user   = makeUser();
    const socket = makeSocket('s-tmsg-noth');
    const io     = makeIo();
    registerThreadSocketEvents(socket, io, user);

    socket._trigger('thread:message:new', { msg: { channelId: 'ch-1', content: 'test' } });

    expect(io._emitted).toHaveLength(0);
  });

  it('msg eksikse işlem yapılmaz', () => {
    const user   = makeUser();
    const socket = makeSocket('s-tmsg-nomsg');
    const io     = makeIo();
    registerThreadSocketEvents(socket, io, user);

    expect(() => socket._trigger('thread:message:new', { threadId: 'th-1' })).not.toThrow();
    expect(io._emitted).toHaveLength(0);
  });

  it('birden fazla thread mesajı ayrı ayrı doğru odalara gönderilir', () => {
    const user   = makeUser();
    const socket = makeSocket('s-tmsg-multi');
    const io     = makeIo();
    registerThreadSocketEvents(socket, io, user);

    const msg1 = { _id: 'm1', threadId: 'th-A', channelId: 'ch-A', content: 'A yanıtı', userId: user._id };
    const msg2 = { _id: 'm2', threadId: 'th-B', channelId: 'ch-B', content: 'B yanıtı', userId: user._id };

    socket._trigger('thread:message:new', { threadId: 'th-A', msg: msg1 });
    socket._trigger('thread:message:new', { threadId: 'th-B', msg: msg2 });

    expect(io._emitted.find(e => e._target === 'channel:ch-A')).toBeDefined();
    expect(io._emitted.find(e => e._target === 'channel:ch-B')).toBeDefined();
    expect(io._emitted.find(e => e._target === 'thread:th-A')).toBeDefined();
    expect(io._emitted.find(e => e._target === 'thread:th-B')).toBeDefined();
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
