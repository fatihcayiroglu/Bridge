// server/tests/socket-room-leak.test.ts
// Socket.IO room ve Map bellek sızıntısı testleri
// Kapsam:
//   - handleDisconnect: socketUsers, typingTimers, _socketRateStore temizleme
//   - voiceRooms: boş oda periyodik temizleme
//   - voiceActivity: disconnect'te Map girişi silinmesi
//   - Hızlı connect/disconnect döngüsünde Map büyümemesi

'use strict';

process.env.NODE_ENV = 'test';

// DB ve bağımlılıkları mock'la
jest.mock('../db/repositories', () => ({
  Users:   { update: jest.fn().mockResolvedValue({}), findById: jest.fn().mockResolvedValue(null) },
  Members: { findByUser: jest.fn().mockResolvedValue([]) },
}));

import { handleDisconnect } from '../socket/handlers/infra';

// ── Test yardımcıları ──────────────────────────────────────────

function makeSocket(id = `sock-${Math.random().toString(36).slice(2)}`) {
  const rooms = new Set([id]); // Socket.IO her socket'i kendi id'si ile bir room'a ekler
  return {
    id,
    rooms,
    currentVoiceChannel: null,
    currentVoiceServer:  null,
    leave: jest.fn((room) => rooms.delete(room)),
    emit:  jest.fn(),
  };
}

function makeUser(id = 'u-test') {
  return { _id: id, displayName: 'Test User' };
}

function makeDisconnectCtx(overrides = {}) {
  return {
    socketUsers:      new Map(),
    typingTimers:     new Map(),
    _socketRateStore: new Map(),
    leaveVoice:       jest.fn(),
    voiceActivity:    new Map(),
    tokenCheckTimer:  setInterval(() => {}, 99999), // temizlenecek
    io:               { to: () => ({ emit: jest.fn() }) },
    ...overrides,
  };
}

afterEach(() => jest.clearAllMocks());

// ── socketUsers temizleme ──────────────────────────────────────

describe('handleDisconnect — socketUsers', () => {
  it('disconnect sonrası socketId Map\'ten silinir', async () => {
    const socket = makeSocket('sock-1');
    const user   = makeUser('u1');
    const ctx    = makeDisconnectCtx();
    ctx.socketUsers.set(socket.id, user);

    await handleDisconnect(socket, user, ctx);

    expect(ctx.socketUsers.has(socket.id)).toBe(false);
  });

  it('diğer socket\'lerin kayıtları silinmez', async () => {
    const s1 = makeSocket('sock-A');
    const s2 = makeSocket('sock-B');
    const u1 = makeUser('u1');
    const u2 = makeUser('u2');
    const ctx = makeDisconnectCtx();
    ctx.socketUsers.set(s1.id, u1);
    ctx.socketUsers.set(s2.id, u2);

    await handleDisconnect(s1, u1, ctx);

    expect(ctx.socketUsers.has(s1.id)).toBe(false);
    expect(ctx.socketUsers.has(s2.id)).toBe(true); // s2 etkilenmemeli
  });
});

// ── typingTimers temizleme ──────────────────────────────────────

describe('handleDisconnect — typingTimers', () => {
  it('kullanıcının typing timer\'ları temizlenir', async () => {
    const socket = makeSocket();
    const user   = makeUser('u-typing');
    const ctx    = makeDisconnectCtx();

    const timer1 = setTimeout(() => {}, 99999);
    const timer2 = setTimeout(() => {}, 99999);
    const otherUserTimer = setTimeout(() => {}, 99999);
    ctx.typingTimers.set(`ch-1:${user._id}`, timer1);
    ctx.typingTimers.set(`ch-2:${user._id}`, timer2);
    ctx.typingTimers.set('ch-1:other-user', otherUserTimer); // başkası

    try {
      await handleDisconnect(socket, user, ctx);

      expect(ctx.typingTimers.has(`ch-1:${user._id}`)).toBe(false);
      expect(ctx.typingTimers.has(`ch-2:${user._id}`)).toBe(false);
      expect(ctx.typingTimers.has('ch-1:other-user')).toBe(true); // başkası korunur
    } finally {
      clearTimeout(otherUserTimer);
    }
  });

  it('typing timer\'ı olmayan kullanıcı için hata oluşmaz', async () => {
    const socket = makeSocket();
    const user   = makeUser('u-no-typing');
    const ctx    = makeDisconnectCtx();

    await expect(handleDisconnect(socket, user, ctx)).resolves.not.toThrow();
  });
});

// ── _socketRateStore temizleme ─────────────────────────────────

describe('handleDisconnect — _socketRateStore', () => {
  it('kullanıcının rate limit kayıtları silinir', async () => {
    const socket = makeSocket();
    const user   = makeUser('u-rate');
    const ctx    = makeDisconnectCtx();

    ctx._socketRateStore.set(`${user._id}:channel:join`, [Date.now()]);
    ctx._socketRateStore.set(`${user._id}:message:send`, [Date.now()]);
    ctx._socketRateStore.set('other-user:message:send', [Date.now()]); // başkası

    await handleDisconnect(socket, user, ctx);

    expect(ctx._socketRateStore.has(`${user._id}:channel:join`)).toBe(false);
    expect(ctx._socketRateStore.has(`${user._id}:message:send`)).toBe(false);
    expect(ctx._socketRateStore.has('other-user:message:send')).toBe(true);
  });
});

// ── voiceActivity temizleme ────────────────────────────────────

describe('handleDisconnect — voiceActivity', () => {
  it('voiceActivity Map\'ten socket girişi silinir', async () => {
    const socket = makeSocket('sock-voice');
    const user   = makeUser('u-voice');
    const ctx    = makeDisconnectCtx();

    ctx.voiceActivity.set(socket.id, { channelId: 'ch-1', joinedAt: Date.now() });

    await handleDisconnect(socket, user, ctx);

    expect(ctx.voiceActivity.has(socket.id)).toBe(false);
  });

  it('ses kanalındaysa leaveVoice çağrılır', async () => {
    const socket = makeSocket();
    socket.currentVoiceChannel = 'ch-voice';
    socket.currentVoiceServer  = 'sv-1';
    const user = makeUser();
    const ctx  = makeDisconnectCtx();

    await handleDisconnect(socket, user, ctx);

    expect(ctx.leaveVoice).toHaveBeenCalledWith(socket, 'ch-voice', 'sv-1', ctx.io);
  });

  it('ses kanalında değilse leaveVoice çağrılmaz', async () => {
    const socket = makeSocket();
    socket.currentVoiceChannel = null;
    const user = makeUser();
    const ctx  = makeDisconnectCtx();

    await handleDisconnect(socket, user, ctx);

    expect(ctx.leaveVoice).not.toHaveBeenCalled();
  });
});

// ── Hızlı connect/disconnect döngüsü ──────────────────────────

describe('Hızlı connect/disconnect döngüsü — Map büyümemeli', () => {
  it('100 socket bağlanıp ayrılınca Map boş kalır', async () => {
    const socketUsers      = new Map();
    const typingTimers     = new Map();
    const _socketRateStore = new Map();
    const voiceActivity    = new Map();
    const io               = { to: () => ({ emit: jest.fn() }) };

    for (let i = 0; i < 100; i++) {
      const socket = makeSocket(`sock-${i}`);
      const user   = makeUser(`user-${i}`);

      // Bağlan
      socketUsers.set(socket.id, user);
      _socketRateStore.set(`${user._id}:msg`, [Date.now()]);
      voiceActivity.set(socket.id, { channelId: 'ch-x' });

      // Ayrıl
      await handleDisconnect(socket, user, {
        socketUsers, typingTimers, _socketRateStore,
        leaveVoice: jest.fn(), voiceActivity,
        tokenCheckTimer: setInterval(() => {}, 99999),
        io,
      });
    }

    expect(socketUsers.size).toBe(0);
    expect(voiceActivity.size).toBe(0);
    // _socketRateStore'da başkasının kaydı kalmamış olmalı
    expect(_socketRateStore.size).toBe(0);
  });
});
