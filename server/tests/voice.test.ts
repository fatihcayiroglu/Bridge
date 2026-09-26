// server/tests/voice.test.ts
// voice.js socket handler entegrasyon testleri
// Test kapsamı:
//   - voice:join  (normal, kapasite limiti, mevcut peer listesi)
//   - voice:leave
//   - WebRTC sinyal iletimi (offer / answer / ice-candidate)
//   - voice:state-update
//   - voice:activity
import { EmittedLog, ServerDouble, SocketDouble, dataOf, findEmitted, requireEmitted, requireEmittedData, requireEmittedList } from './helpers/socketDoubles';
import { present, recordOf } from './helpers/narrow';
//   - voice:e2e-key
//   - disconnect temizliği
//   - MAX_VOICE_PEERS sınırı

'use strict';
process.env.NODE_ENV = 'test';
process.env.MAX_VOICE_PEERS = '10';

// music modülünü stub'la (voice.js require ediyor)
jest.mock('../music', () => ({
  readMusicQueue: jest.fn(async () => ({ current: null, queue: [] })),
}));

import { registerVoiceHandlers, leaveVoice, voiceRooms } from '../socket/handlers/voice';

// ── FAZ G6 — YETKI FIKSTURU ───────────────────────────────────────────────
//
// `voice:join` artik yetki dogrular (uyelik + VIEW_CHANNELS + CONNECT) ve
// payload'daki `serverId`nin kanalin GERCEK sunucusu oldugunu denetler.
//
// Bu testler daha once HIC db mock'u kullanmiyordu; cunku eski handler
// hicbir sey dogrulamiyordu — yani paket, yetkisiz katilimi "beklenen
// davranis" olarak kayit altina almisti. Fikstur, MESRU kullaniciyi modeller;
// yetkisiz durumlar ayri bir pakette (voice-authorization.test.ts) olculur.
// DIKKAT: `jest.mock` factory'si HOISTED edilir; disaridaki bir degiskene
// kapanamaz. Bu yuzden mock db factory ICINDE olusturulur (ayni bicim
// tests/dm-socket.test.ts ve socket-channel-join-visibility.test.ts icinde de
// kullanilir).
// `var`: handler import'u (satir 22) mock factory'sini TETIKLER ve o an
// `let` TDZ'de olurdu. `var` hoisted+undefined baslar, sorun cikmaz.
// eslint-disable-next-line no-var
var _voiceDb: ReturnType<typeof import('./helpers/mockDb').createMockDb>;
jest.mock('../db/loader', () => {
  const { createMockDb } = require('./helpers/mockDb');
  _voiceDb = createMockDb();
  return _voiceDb;
});
jest.mock('../db/index',  () => require('../db/loader'));

const _VOICE_SERVER = 'sv-1';
/** Testlerde gecen tum kanal adlari — hepsi ayni sunucuya baglanir. */
const _VOICE_CHANNELS = ['ch-1','ch-2','ch-3','ch-act','ch-e2e','ch-e2e-alone','ch-full','ch-leave','ch-lv','ch-music','ch-off','ch-pl','ch-rtc','ch-state'];

beforeEach(async () => {
  await _voiceDb.servers.insert({ _id: _VOICE_SERVER, name: 'SV', ownerId: 'sahip-sv', createdAt: 1 });
  for (const c of _VOICE_CHANNELS) {
    await _voiceDb.channels.insert({ _id: c, serverId: _VOICE_SERVER, name: c, type: 'voice', createdAt: 1 });
  }
});

/** Kullaniciyi sunucuya uye yapar (varsayilan izinler CONNECT icerir). */
async function _authorizeVoice(userId: string): Promise<void> {
  await _voiceDb.members.insert({ userId, serverId: _VOICE_SERVER, roles: [], joinedAt: 1 });
}


// ── Test yardımcıları ────────────────────────────────────────────

function makeUser(overrides = {}) {
  const u = { _id: `u-${Math.random().toString(36).slice(2)}`, displayName: 'Tester', avatarColor: '#fff', ...overrides };
  // FAZ G6 — bu paketteki kullanicilar MESRU uyelerdir. Mock `insert` govdesi
  // senkrondur (store'u hemen mutasyona ugratir), bu yuzden await gerekmez.
  void _authorizeVoice(u._id);
  return u;
}

/**
 * Minimal socket mock — EventEmitter benzeri
 */
type SocketLike = ReturnType<typeof makeSocket>;

function makeSocket(id: string, overrides: Partial<SocketDouble> = {}) {
  const handlers: Record<string, unknown> = {};
  const emitted: EmittedLog = [];
  const rooms    = new Set<string>();

  // `userId` / `currentVoice*` alanlari ÜRÜN sözleşmesinde `string | undefined`
  // (ve `string | null | undefined`). Burada `null` yazılıyordu; `userId: null`
  // sözleşmeyi ihlal ediyordu. Kimliği HENÜZ YOK durumunu `undefined` ile
  // ifade etmek hem sözleşmeye uyar hem de gerçeği söyler: kimlik doğrulama
  // ara katmanı çalışmadan önce alan MEVCUT DEĞİLDİR.
  const socket = {
    id,
    userId: undefined,
    currentVoiceChannel: null,
    currentVoiceServer:  null,
    rooms,
    ...overrides,

    on(event, fn) { handlers[event] = fn; },
    emit(event, ...args) { emitted.push({ event, data: args[0] }); },
    to(room) {
      return {
        emit(event, ...args) {
          emitted.push({ event, data: args[0], _room: room });
        },
      };
    },
    join(room)  { rooms.add(room); },
    leave(room) { rooms.delete(room); },

    // Test introspection
    _handlers:  handlers,
    _emitted:   emitted,
    _rooms:     rooms,
    _trigger(event: string, data?: unknown) {
      const handler = handlers[event];
      if (typeof handler === 'function') return handler(data);
      return undefined;
    },
  } satisfies SocketDouble;
  return socket;
}

/**
 * io mock — odaya ve belirli socket'e emit edebilir
 */
function makeIo() {
  const emitted: EmittedLog = [];
  const io = {
    _emitted: emitted,
    to(target) {
      return {
        emit(event, data) {
          emitted.push({ event, data, _target: target });
        },
      };
    },
  } satisfies ServerDouble;
  return io;
}

// ── Temizlik ─────────────────────────────────────────────────────

function clearVoiceRooms() {
  for (const k of Object.keys(voiceRooms)) delete voiceRooms[k];
}

beforeEach(() => clearVoiceRooms());
afterEach(()  => clearVoiceRooms());

// ════════════════════════════════════════════════════════════════
// voice:join
// ════════════════════════════════════════════════════════════════

describe('voice:join', () => {
  it('odaya katılır, socket odaya eklenir', async () => {
    const user   = makeUser();
    const socket = makeSocket('sock-1');
    const io     = makeIo();
    registerVoiceHandlers(socket, io, user);

    await socket._trigger('voice:join', { channelId: 'ch-1', serverId: 'sv-1' });

    expect(socket._rooms.has('voice:ch-1')).toBe(true);
    expect(socket.currentVoiceChannel).toBe('ch-1');
    expect(socket.currentVoiceServer).toBe('sv-1');
    expect(voiceRooms['ch-1']).toHaveLength(1);
    expect(present(voiceRooms['ch-1'], 'ch-1 odasi')[0]?.userId).toBe(user._id);
  });

  it('mevcut peer listesini yeni katılana gönderir', async () => {
    // Birinci kullanıcı zaten odada
    const user1   = makeUser({ displayName: 'Alice' });
    const socket1 = makeSocket('sock-1');
    const io      = makeIo();
    registerVoiceHandlers(socket1, io, user1);
    await socket1._trigger('voice:join', { channelId: 'ch-2', serverId: 'sv-1' });

    // İkinci kullanıcı katılıyor
    const user2   = makeUser({ displayName: 'Bob' });
    const socket2 = makeSocket('sock-2');
    registerVoiceHandlers(socket2, io, user2);
    await socket2._trigger('voice:join', { channelId: 'ch-2', serverId: 'sv-1' });

    const existingPeers = requireEmittedList(socket2._emitted, 'voice:existing-peers');
    expect(existingPeers).toBeDefined();
    expect(existingPeers).toHaveLength(1);
    expect(existingPeers[0].userId).toBe(user1._id);
  });

  it('odaya katılan herkese voice:peer-joined yayınlar', async () => {
    const user1   = makeUser();
    const socket1 = makeSocket('sock-1');
    const io      = makeIo();
    registerVoiceHandlers(socket1, io, user1);
    await socket1._trigger('voice:join', { channelId: 'ch-3', serverId: 'sv-1' });

    const user2   = makeUser({ displayName: 'NewPeer' });
    const socket2 = makeSocket('sock-2');
    registerVoiceHandlers(socket2, io, user2);
    await socket2._trigger('voice:join', { channelId: 'ch-3', serverId: 'sv-1' });

    // socket1'in emitted listesinde peer-joined olmalı
    // (socket2 socket1'in odasında olduğu için socket1.to('voice:ch-3') üzerinden)
    const peerJoined = socket2._emitted.find(e => e.event === 'voice:peer-joined' || e._room === 'voice:ch-3');
    // io'nun odaya emit ettiğini de kontrol edelim.
    // DİKKAT: `find` İLK olayı döndürür — o da user1'in katılımıdır (1 peer).
    // İki katılımdan SONRAKİ durumu ölçmek için SON olay alınır; aksi hâlde
    // iddia her zaman 1 peer görür ve "ikinci katılım yayınlanmadı" gibi
    // yanlış bir sonuç üretir.
    const roomUpdates = io._emitted.filter(e => e.event === 'voice:room-update');
    expect(roomUpdates.length).toBeGreaterThanOrEqual(2);
    const roomUpdate = roomUpdates[roomUpdates.length - 1];
    expect(roomUpdate).toBeDefined();
    expect(dataOf(roomUpdate).channelId).toBe('ch-3');
    expect(dataOf(roomUpdate).peers).toHaveLength(2);
    expect(roomUpdate._target).toEqual(['voice:ch-3', 'channel:ch-3']);
    expect(io._emitted.some(e => String(e._target).startsWith('server:') && e.event === 'voice:room-update')).toBe(false);
  });

  it('[CONCURRENCY] eşzamanlı katılımlar kapasite kontrolünü aşamaz ve peer kaybı oluşturmaz', async () => {
    const io = makeIo();
    const sockets = Array.from({ length: 11 }, (_, i) => {
      const user = makeUser({ displayName: `Concurrent-${i}` });
      const socket = makeSocket(`sock-concurrent-${i}`);
      registerVoiceHandlers(socket, io, user);
      return socket;
    });

    await Promise.all(sockets.map(socket => socket._trigger('voice:join', { channelId: 'ch-full', serverId: 'sv-1' })));

    expect(voiceRooms['ch-full']).toHaveLength(10);
    expect(new Set(present(voiceRooms['ch-full'], 'ch-full odasi').map(peer => peer.socketId)).size).toBe(10);
    expect(sockets.filter(socket => socket._emitted.some(e => e.event === 'voice:full'))).toHaveLength(1);
  });

  it('kapasite doluysa voice:full gönderir ve odaya eklemez', async () => {
    const io = makeIo();
    const MAX = 10;

    // 10 kullanıcı ekle
    for (let i = 0; i < MAX; i++) {
      const u = makeUser();
      const s = makeSocket(`sock-cap-${i}`);
      registerVoiceHandlers(s, io, u);
      await s._trigger('voice:join', { channelId: 'ch-full', serverId: 'sv-1' });
    }
    expect(voiceRooms['ch-full']).toHaveLength(MAX);

    // 11. kullanıcı — reddedilmeli
    const lateUser   = makeUser();
    const lateSocket = makeSocket('sock-late');
    registerVoiceHandlers(lateSocket, io, lateUser);
    await lateSocket._trigger('voice:join', { channelId: 'ch-full', serverId: 'sv-1' });

    const full = requireEmittedData(lateSocket._emitted, 'voice:full');
    expect(full).toBeDefined();
    expect(full.max).toBe(MAX);
    expect(voiceRooms['ch-full']).toHaveLength(MAX); // hâlâ 10
  });

  it('başka voice kanalına geçiş eski room üyeliğini ve peer kaydını temizler', async () => {
    const user = makeUser();
    const socket = makeSocket('sock-switch');
    const io = makeIo();
    registerVoiceHandlers(socket, io, user);

    await socket._trigger('voice:join', { channelId: 'ch-1', serverId: 'sv-1' });
    await socket._trigger('voice:join', { channelId: 'ch-2', serverId: 'sv-1' });

    expect(socket.currentVoiceChannel).toBe('ch-2');
    expect(socket._rooms.has('voice:ch-1')).toBe(false);
    expect(socket._rooms.has('voice:ch-2')).toBe(true);
    expect((voiceRooms['ch-1'] ?? []).some(p => p.socketId === socket.id)).toBe(false);
    expect((voiceRooms['ch-2'] ?? []).filter(p => p.socketId === socket.id)).toHaveLength(1);
  });

  it('aynı voice kanalına tekrar join duplicate peer üretmez', async () => {
    const user = makeUser();
    const socket = makeSocket('sock-dup-room');
    const io = makeIo();
    registerVoiceHandlers(socket, io, user);

    await socket._trigger('voice:join', { channelId: 'ch-1', serverId: 'sv-1' });
    await socket._trigger('voice:join', { channelId: 'ch-1', serverId: 'sv-1' });

    expect((voiceRooms['ch-1'] ?? []).filter(p => p.socketId === socket.id)).toHaveLength(1);
  });

  it('yavaş eski join, daha yeni voice seçimini geri alamaz', async () => {
    const user = makeUser();
    const socket = makeSocket('sock-join-race');
    const io = makeIo();
    registerVoiceHandlers(socket, io, user);

    const originalFindOne = _voiceDb.channels.findOne.bind(_voiceDb.channels);
    // `new Promise` geri çağrısı senkron çalışır, ama TypeScript bunu bilemez;
    // bildirime tip vermek `releaseA`yı örtük `any` olmaktan çıkarır.
    let releaseA: (() => void) | undefined;
    const gateA = new Promise<void>(resolve => { releaseA = resolve; });
    _voiceDb.channels.findOne = jest.fn(async (query) => {
      if (query?._id === 'ch-1') await gateA;
      return originalFindOne(query);
    });

    try {
      const oldJoin = socket._trigger('voice:join', { channelId: 'ch-1', serverId: 'sv-1' });
      const newJoin = socket._trigger('voice:join', { channelId: 'ch-2', serverId: 'sv-1' });
      await newJoin;
      present(releaseA, 'releaseA')();
      await oldJoin;

      expect(socket.currentVoiceChannel).toBe('ch-2');
      expect(socket._rooms.has('voice:ch-2')).toBe(true);
      expect(socket._rooms.has('voice:ch-1')).toBe(false);
      expect((voiceRooms['ch-1'] ?? []).some(p => p.socketId === socket.id)).toBe(false);
    } finally {
      _voiceDb.channels.findOne = originalFindOne;
    }
  });

  it('aktif müzik varsa yeni katılana music:play gönderir', async () => {
    const { readMusicQueue } = require('../music');
    const mockTrack = { title: 'Test Song', duration: 200 };
    readMusicQueue.mockResolvedValueOnce({ current: mockTrack, queue: [] });

    const user   = makeUser();
    const socket = makeSocket('sock-music');
    const io     = makeIo();
    registerVoiceHandlers(socket, io, user);
    await socket._trigger('voice:join', { channelId: 'ch-music', serverId: 'sv-1' });

    const musicPlay = requireEmittedData(socket._emitted, 'music:play');
    expect(musicPlay).toBeDefined();
    expect(musicPlay.track).toBe(mockTrack);
  });
});

// ════════════════════════════════════════════════════════════════
// voice:leave
// ════════════════════════════════════════════════════════════════

describe('voice:leave', () => {
  it('odadan ayrılır, voiceRooms güncellenir', async () => {
    const user   = makeUser();
    const socket = makeSocket('sock-leave');
    const io     = makeIo();
    registerVoiceHandlers(socket, io, user);
    await socket._trigger('voice:join',  { channelId: 'ch-leave', serverId: 'sv-1' });
    await socket._trigger('voice:leave', { channelId: 'ch-leave', serverId: 'sv-1' });

    expect(voiceRooms['ch-leave'] ?? []).toHaveLength(0);
    expect(socket.currentVoiceChannel).toBeNull();
    expect(socket._rooms.has('voice:ch-leave')).toBe(false);
  });

  it('voice:peer-left diğer kullanıcılara bildirilir', async () => {
    const io = makeIo();

    const u1 = makeUser();
    const s1 = makeSocket('sock-left-1');
    registerVoiceHandlers(s1, io, u1);
    await s1._trigger('voice:join', { channelId: 'ch-pl', serverId: 'sv-1' });

    const u2 = makeUser();
    const s2 = makeSocket('sock-left-2');
    registerVoiceHandlers(s2, io, u2);
    await s2._trigger('voice:join', { channelId: 'ch-pl', serverId: 'sv-1' });

    // u2 ayrılıyor — s1 odada kalmalı ve peer-left almalı
    io._emitted.length = 0; // geçmişi temizle
    await s2._trigger('voice:leave', { channelId: 'ch-pl', serverId: 'sv-1' });

    const roomUpdate = requireEmitted(io._emitted, 'voice:room-update');
    expect(roomUpdate).toBeDefined();
    expect(dataOf(roomUpdate).peers).toHaveLength(1);
  });

  it('olmayan odadan leave hata firlatmaz VE sahte ayrilma yayini yapmaz', async () => {
    // Yalnizca "firlatmadi" demek yetersizdi. Hic katilmamis bir kullanici
    // icin `voice:left` yayinlamak, diger istemcilerde var olmayan bir
    // katilimciyi kaldirmaya calisirdi.
    const user   = makeUser();
    const socket = makeSocket('sock-safe-leave');
    const io     = makeIo();
    registerVoiceHandlers(socket, io, user);

    // Handler artik ERKEN DONER (soket hicbir odada degil), yani bir promise
    // dondurmez. Bu, capraz-kiraci duzeltmesinin beklenen davranisidir.
    await expect(
      (async () => socket._trigger('voice:leave', { channelId: 'nonexistent', serverId: 'sv-1' }))(),
    ).resolves.not.toThrow();
    expect(io._emitted).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════
// leaveVoice yardımcı fonksiyonu
// ════════════════════════════════════════════════════════════════

describe('await leaveVoice() yardımcısı', () => {
  it('doğrudan çağrılınca da odayı temizler', async () => {
    const user   = makeUser();
    const socket = makeSocket('sock-lv');
    const io     = makeIo();
    registerVoiceHandlers(socket, io, user);
    await socket._trigger('voice:join', { channelId: 'ch-lv', serverId: 'sv-1' });

    await leaveVoice(socket, 'ch-lv', 'sv-1', io);

    expect(voiceRooms['ch-lv'] ?? []).toHaveLength(0);
    expect(socket.currentVoiceChannel).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════
// WebRTC sinyal iletimi
// ════════════════════════════════════════════════════════════════

describe('WebRTC sinyal iletimi', () => {
  function setup() {
    const io  = makeIo();
    const ioEmitted: EmittedLog = [];
    // io.to(socketId).emit → hedefli iletim
    io.to = (target) => ({
      emit(event, data) { ioEmitted.push({ event, data, _target: target }); },
    });
    io._emitted = ioEmitted;

    const u1 = makeUser({ displayName: 'Caller' });
    const s1 = makeSocket('sock-rtc-1');
    registerVoiceHandlers(s1, io, u1);

    const u2 = makeUser({ displayName: 'Callee' });
    const s2 = makeSocket('sock-rtc-2');
    registerVoiceHandlers(s2, io, u2);

    return { io, ioEmitted, u1, s1, u2, s2 };
  }

  /**
   * FAZ G6 — sinyallesme artik GERCEK bir ses odasi gerektirir.
   *
   * Bu testler eskiden hicbir odaya katilmadan `targetSocketId`ye sinyal
   * gonderiyor ve GECIYORDU; gecmesinin nedeni tam olarak guvenlik kusuruydu:
   * relay, arayan/hedefin ayni gorusmede olup olmadigini HIC dogrulamiyordu.
   * Yani paket, capraz-oda sinyal enjeksiyonunu "beklenen" diye kaydetmisti.
   * Artik once ikisi de ayni odaya katilir; MESRU yol olculur.
   */
  async function joinBoth(ctx: { s1: SocketLike; s2: SocketLike; ioEmitted: EmittedLog }) {
    await ctx.s1._trigger('voice:join', { channelId: 'ch-off', serverId: 'sv-1' });
    await ctx.s2._trigger('voice:join', { channelId: 'ch-off', serverId: 'sv-1' });
    ctx.ioEmitted.length = 0;
  }

  it('webrtc:offer hedef socket\'e iletilir', async () => {
    const ctx = setup();
    await joinBoth(ctx);
    const { io, ioEmitted, s1 } = ctx;
    await s1._trigger('webrtc:offer', { targetSocketId: 'sock-rtc-2', offer: { sdp: 'test' }, channelId: 'ch-rtc' });

    const fwd = requireEmitted(ioEmitted, 'webrtc:offer');
    expect(fwd).toBeDefined();
    expect(fwd._target).toBe('sock-rtc-2');
    expect(dataOf(fwd).fromSocketId).toBe('sock-rtc-1');
    expect(recordOf(dataOf(fwd).offer, 'offer').sdp).toBe('test');
  });

  it('webrtc:answer hedef socket\'e iletilir', async () => {
    const ctx = setup();
    await joinBoth(ctx);
    const { ioEmitted, s1 } = ctx;
    await s1._trigger('webrtc:answer', { targetSocketId: 'sock-rtc-2', answer: { sdp: 'answer-sdp' } });

    const fwd = requireEmitted(ioEmitted, 'webrtc:answer');
    expect(fwd).toBeDefined();
    expect(dataOf(fwd).fromSocketId).toBe('sock-rtc-1');
    expect(recordOf(dataOf(fwd).answer, 'answer').sdp).toBe('answer-sdp');
  });

  it('webrtc:ice-candidate hedef socket\'e iletilir', async () => {
    const ctx = setup();
    await joinBoth(ctx);
    const { ioEmitted, s1 } = ctx;
    await s1._trigger('webrtc:ice-candidate', { targetSocketId: 'sock-rtc-2', candidate: { candidate: 'ice-cand' } });

    const fwd = requireEmitted(ioEmitted, 'webrtc:ice-candidate');
    expect(fwd).toBeDefined();
    expect(dataOf(fwd).fromSocketId).toBe('sock-rtc-1');
  });
});

// ════════════════════════════════════════════════════════════════
// voice:state-update
// ════════════════════════════════════════════════════════════════

describe('voice:state-update', () => {
  it('mute/deafen/screenshare durumu odaya yayınlanır', async () => {
    const io       = makeIo();
    const emitted: EmittedLog = [];
    const user     = makeUser();
    const socket   = makeSocket('sock-state');
    socket.to = (room) => ({ emit(ev, d) { emitted.push({ ev, d, room }); } });

    registerVoiceHandlers(socket, io, user);
    await socket._trigger('voice:join', { channelId: 'ch-state', serverId: 'sv-1' });
    await socket._trigger('voice:state-update', { channelId: 'ch-state', muted: true, deafened: false, screensharing: true, video: false });

    const state = requireEmitted(emitted, 'voice:peer-state');
    expect(state).toBeDefined();
    expect(recordOf(state.d, 'state.d').muted).toBe(true);
    expect(recordOf(state.d, 'state.d').screensharing).toBe(true);
    expect(recordOf(state.d, 'state.d').userId).toBe(user._id);
  });
});

// ════════════════════════════════════════════════════════════════
// voice:activity (speaking indicator)
// ════════════════════════════════════════════════════════════════

describe('voice:activity', () => {
  it('konuşma durumu odaya yayınlanır', async () => {
    const io      = makeIo();
    const emitted: EmittedLog = [];
    const user    = makeUser();
    const socket  = makeSocket('sock-act');
    socket.to = (room) => ({ emit(ev, d) { emitted.push({ ev, d, room }); } });

    registerVoiceHandlers(socket, io, user);
    await socket._trigger('voice:join', { channelId: 'ch-act', serverId: 'sv-1' });
    await socket._trigger('voice:activity', { channelId: 'ch-act', speaking: true });

    const act = requireEmitted(emitted, 'voice:activity');
    expect(act).toBeDefined();
    expect(recordOf(act.d, 'act.d').speaking).toBe(true);
    expect(recordOf(act.d, 'act.d').userId).toBe(user._id);
  });
});

// ════════════════════════════════════════════════════════════════
// voice:e2e-key
// ════════════════════════════════════════════════════════════════

describe('voice:e2e-key', () => {
  it('şifreli anahtar hedef kullanıcının socket\'ine iletilir', async () => {
    const io       = makeIo();
    const ioEmitted: EmittedLog = [];
    io.to = (target) => ({
      emit(event, data) { ioEmitted.push({ event, data, _target: target }); },
    });
    io._emitted = ioEmitted;

    const sender   = makeUser({ displayName: 'Sender' });
    const receiver = makeUser({ displayName: 'Receiver' });

    const senderSocket   = makeSocket('sock-e2e-sender');
    const receiverSocket = makeSocket('sock-e2e-receiver');

    registerVoiceHandlers(senderSocket,   io, sender);
    registerVoiceHandlers(receiverSocket, io, receiver);

    // Her ikisi de aynı odada
    await senderSocket._trigger('voice:join',   { channelId: 'ch-e2e', serverId: 'sv-1' });
    await receiverSocket._trigger('voice:join', { channelId: 'ch-e2e', serverId: 'sv-1' });

    ioEmitted.length = 0; // join event'lerini temizle

    await senderSocket._trigger('voice:e2e-key', {
      channelId:    'ch-e2e',
      targetUserId: receiver._id,
      encryptedKey: 'enc-key-abc',
    });

    const keyEvent = requireEmitted(ioEmitted, 'voice:e2e-key');
    expect(keyEvent).toBeDefined();
    expect(keyEvent._target).toBe('sock-e2e-receiver');
    expect(dataOf(keyEvent).encryptedKey).toBe('enc-key-abc');
    expect(dataOf(keyEvent).fromUserId).toBe(sender._id);
  });

  it('odada olmayan kullanıcıya key iletmeye çalışmak sessizce geçer', async () => {
    const io       = makeIo();
    const ioEmitted: EmittedLog = [];
    io.to = (t) => ({ emit(ev, d) { ioEmitted.push({ ev, d, _t: t }); } });

    const user   = makeUser();
    const socket = makeSocket('sock-e2e-alone');
    registerVoiceHandlers(socket, io, user);
    await socket._trigger('voice:join', { channelId: 'ch-e2e-alone', serverId: 'sv-1' });
    ioEmitted.length = 0;

    await socket._trigger('voice:e2e-key', {
      channelId:    'ch-e2e-alone',
      targetUserId: 'ghost-user',
      encryptedKey: 'enc-key',
    });

    const keyEvent = findEmitted(ioEmitted, 'voice:e2e-key');
    expect(keyEvent).toBeUndefined();
  });
});
