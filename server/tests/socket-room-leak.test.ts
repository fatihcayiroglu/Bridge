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
import type { DisconnectOptions } from '../socket/handlers/infra';
import type { SocketDouble } from './helpers/socketDoubles';
import { makeSafeUser } from './helpers/userDoubles';

// ── Test yardımcıları ──────────────────────────────────────────

// ══════════════════════════════════════════════════════════════════════════
// IKIZLER URUN SOZLESMESINE BAGLANIR
// ══════════════════════════════════════════════════════════════════════════
// Eskiden bu ikizler tipsizdi ve `handleDisconnect(socket, user, ctx)` cagrisi
// `Map<any, any>` cikarimina dusuyordu: hata gorunmuyordu ama denetim de
// yoktu. Simdi ikizler URUNUN kendi tiplerine (`SocketDouble` -> `HandlerSocket`,
// `DisconnectOptions`) baglanmistir; urun imzasi degisirse burasi DERLEMEDE
// kirilir.
//
// Yan urun — bir GERCEKLIK HATASI duzeltildi: `voiceActivity` urunde
// `Map<string, number>`dur (son etkinlik zaman damgasi, voice.ts:355). Test
// ona `{ channelId, joinedAt }` nesneleri koyuyordu; yani olculen sey urunun
// gercekten tuttugu veri degildi.

/** `currentVoice*` alanlari testlerde DEGISTIRILDIGI icin acikca yazilir. */
interface DisconnectSocketDouble extends SocketDouble {
  currentVoiceChannel: string | null;
  currentVoiceServer: string | null;
}

function makeSocket(id = `sock-${Math.random().toString(36).slice(2)}`): DisconnectSocketDouble {
  const rooms = new Set([id]); // Socket.IO her socket'i kendi id'si ile bir room'a ekler
  return {
    id,
    rooms,
    currentVoiceChannel: null,
    currentVoiceServer:  null,
    leave: jest.fn((room: string) => rooms.delete(room)),
    emit:  jest.fn(),
    // Sozlesmenin geri kalani: `handleDisconnect` bunlari cagirmaz ama
    // `HandlerSocket` tasidigi icin ikiz de tasimak zorundadir. Cagrilmayan
    // uyeyi kurmak, cagrilan uyeyi tipsiz birakmaktan iyidir.
    join:  jest.fn((room: string) => rooms.add(room)),
    on:    jest.fn(),
    to:    jest.fn(() => ({ emit: jest.fn() })),
  };
}

const makeUser = makeSafeUser;

function makeDisconnectCtx(overrides: Partial<DisconnectOptions> = {}): DisconnectOptions {
  return {
    socketUsers:      new Map(),
    typingTimers:     new Map(),
    _socketRateStore: new Map(),
    leaveVoice:       jest.fn(),
    voiceActivity:    new Map(),
    tokenCheckTimer:  setInterval(() => {}, 99999), // temizlenecek
    tokenExpiryTimer: null,
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

    ctx.voiceActivity.set(socket.id, Date.now());

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
    // Tek bir baglam 100 dongu boyunca PAYLASILIR — sizinti tam olarak burada
    // gorunur: haritalar dongu sonunda bosalmiyorsa temizlik eksiktir.
    const ctx = makeDisconnectCtx();

    for (let i = 0; i < 100; i++) {
      const socket = makeSocket(`sock-${i}`);
      const user   = makeUser(`user-${i}`);

      // Bağlan
      ctx.socketUsers.set(socket.id, user);
      ctx._socketRateStore.set(`${user._id}:msg`, [Date.now()]);
      ctx.voiceActivity.set(socket.id, Date.now());

      // Ayrıl
      await handleDisconnect(socket, user, ctx);
    }

    expect(ctx.socketUsers.size).toBe(0);
    expect(ctx.voiceActivity.size).toBe(0);
    // _socketRateStore'da başkasının kaydı kalmamış olmalı
    expect(ctx._socketRateStore.size).toBe(0);
  });
});
