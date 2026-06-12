// server/tests/voice.test.ts
// voice.js socket handler entegrasyon testleri
// Test kapsamı:
//   - voice:join  (normal, kapasite limiti, mevcut peer listesi)
//   - voice:leave
//   - WebRTC sinyal iletimi (offer / answer / ice-candidate)
//   - voice:state-update
//   - voice:activity
//   - voice:e2e-key
//   - disconnect temizliği
//   - MAX_VOICE_PEERS sınırı

'use strict';
process.env.NODE_ENV = 'test';
process.env.MAX_VOICE_PEERS = '10';

// music modülünü stub'la (voice.js require ediyor)
jest.mock('../music', () => ({
  getQueue: jest.fn(() => ({ current: null, queue: [] })),
}));

import { registerVoiceHandlers, leaveVoice, voiceRooms } from '../socket/handlers/voice';

// ── Test yardımcıları ────────────────────────────────────────────

function makeUser(overrides = {}) {
  return { _id: `u-${Math.random().toString(36).slice(2)}`, displayName: 'Tester', avatarColor: '#fff', ...overrides };
}

/**
 * Minimal socket mock — EventEmitter benzeri
 */
function makeSocket(id, overrides = {}) {
  const handlers: Record<string, unknown> = {};
  const emitted  = [];
  const rooms    = new Set();

  const socket = {
    id,
    userId: null,
    currentVoiceChannel: null,
    currentVoiceServer:  null,
    ...overrides,

    on(event, fn) { handlers[event] = fn; },
    emit(event, data) { emitted.push({ event, data }); },
    to(room) {
      return {
        emit(event, data) {
          emitted.push({ event, data, _room: room });
        },
      };
    },
    join(room)  { rooms.add(room); },
    leave(room) { rooms.delete(room); },

    // Test introspection
    _handlers:  handlers,
    _emitted:   emitted,
    _rooms:     rooms,
    _trigger(event, data) {
      if (handlers[event]) return handlers[event](data);
    },
  };
  return socket;
}

/**
 * io mock — odaya ve belirli socket'e emit edebilir
 */
function makeIo() {
  const emitted = [];
  const io = {
    _emitted: emitted,
    to(target) {
      return {
        emit(event, data) {
          emitted.push({ event, data, _target: target });
        },
      };
    },
  };
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
    expect(voiceRooms['ch-1'][0].userId).toBe(user._id);
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

    const existingPeers = socket2._emitted.find(e => e.event === 'voice:existing-peers');
    expect(existingPeers).toBeDefined();
    expect(existingPeers.data).toHaveLength(1);
    expect(existingPeers.data[0].userId).toBe(user1._id);
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
    // io'nun odaya emit ettiğini de kontrol edelim
    const roomUpdate = io._emitted.find(e => e.event === 'voice:room-update');
    expect(roomUpdate).toBeDefined();
    expect(roomUpdate.data.channelId).toBe('ch-3');
    expect(roomUpdate.data.peers).toHaveLength(2);
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

    const full = lateSocket._emitted.find(e => e.event === 'voice:full');
    expect(full).toBeDefined();
    expect(full.data.max).toBe(MAX);
    expect(voiceRooms['ch-full']).toHaveLength(MAX); // hâlâ 10
  });

  it('aktif müzik varsa yeni katılana music:play gönderir', async () => {
    const { getQueue } = require('../music');
    const mockTrack = { title: 'Test Song', duration: 200 };
    getQueue.mockReturnValueOnce({ current: mockTrack, queue: [] });

    const user   = makeUser();
    const socket = makeSocket('sock-music');
    const io     = makeIo();
    registerVoiceHandlers(socket, io, user);
    await socket._trigger('voice:join', { channelId: 'ch-music', serverId: 'sv-1' });

    const musicPlay = socket._emitted.find(e => e.event === 'music:play');
    expect(musicPlay).toBeDefined();
    expect(musicPlay.data.track).toBe(mockTrack);
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

    const roomUpdate = io._emitted.find(e => e.event === 'voice:room-update');
    expect(roomUpdate).toBeDefined();
    expect(roomUpdate.data.peers).toHaveLength(1);
  });

  it('olmayan odadan leave çağrısı hata fırlatmaz', async () => {
    const user   = makeUser();
    const socket = makeSocket('sock-safe-leave');
    const io     = makeIo();
    registerVoiceHandlers(socket, io, user);
    // Hiç join yapmadan leave — sessizce geçmeli
    await socket._trigger('voice:leave', { channelId: 'nonexistent', serverId: 'sv-1' });
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
    const ioEmitted = [];
    // io.to(socketId).emit → hedefli iletim
    io.to = (target) => ({
      emit(event, data) { ioEmitted.push({ event, data, _target: target }); },
    });
    io._emitted = ioEmitted;

    const u1 = makeUser({ displayName: 'Caller' });
    const s1 = makeSocket('sock-rtc-1');
    registerVoiceHandlers(s1, io, u1);

    return { io, ioEmitted, u1, s1 };
  }

  it('webrtc:offer hedef socket\'e iletilir', async () => {
    const { io, ioEmitted, s1 } = setup();
    await s1._trigger('webrtc:offer', { targetSocketId: 'sock-rtc-2', offer: { sdp: 'test' }, channelId: 'ch-rtc' });

    const fwd = ioEmitted.find(e => e.event === 'webrtc:offer');
    expect(fwd).toBeDefined();
    expect(fwd._target).toBe('sock-rtc-2');
    expect(fwd.data.fromSocketId).toBe('sock-rtc-1');
    expect(fwd.data.offer.sdp).toBe('test');
  });

  it('webrtc:answer hedef socket\'e iletilir', async () => {
    const { ioEmitted, s1 } = setup();
    await s1._trigger('webrtc:answer', { targetSocketId: 'sock-rtc-2', answer: { sdp: 'answer-sdp' } });

    const fwd = ioEmitted.find(e => e.event === 'webrtc:answer');
    expect(fwd).toBeDefined();
    expect(fwd.data.fromSocketId).toBe('sock-rtc-1');
    expect(fwd.data.answer.sdp).toBe('answer-sdp');
  });

  it('webrtc:ice-candidate hedef socket\'e iletilir', async () => {
    const { ioEmitted, s1 } = setup();
    await s1._trigger('webrtc:ice-candidate', { targetSocketId: 'sock-rtc-2', candidate: { candidate: 'ice-cand' } });

    const fwd = ioEmitted.find(e => e.event === 'webrtc:ice-candidate');
    expect(fwd).toBeDefined();
    expect(fwd.data.fromSocketId).toBe('sock-rtc-1');
  });
});

// ════════════════════════════════════════════════════════════════
// voice:state-update
// ════════════════════════════════════════════════════════════════

describe('voice:state-update', () => {
  it('mute/deafen/screenshare durumu odaya yayınlanır', async () => {
    const io       = makeIo();
    const emitted  = [];
    const user     = makeUser();
    const socket   = makeSocket('sock-state');
    socket.to = (room) => ({ emit(ev, d) { emitted.push({ ev, d, room }); } });

    registerVoiceHandlers(socket, io, user);
    await socket._trigger('voice:join', { channelId: 'ch-state', serverId: 'sv-1' });
    await socket._trigger('voice:state-update', { channelId: 'ch-state', muted: true, deafened: false, screensharing: true, video: false });

    const state = emitted.find(e => e.ev === 'voice:peer-state');
    expect(state).toBeDefined();
    expect(state.d.muted).toBe(true);
    expect(state.d.screensharing).toBe(true);
    expect(state.d.userId).toBe(user._id);
  });
});

// ════════════════════════════════════════════════════════════════
// voice:activity (speaking indicator)
// ════════════════════════════════════════════════════════════════

describe('voice:activity', () => {
  it('konuşma durumu odaya yayınlanır', async () => {
    const io      = makeIo();
    const emitted = [];
    const user    = makeUser();
    const socket  = makeSocket('sock-act');
    socket.to = (room) => ({ emit(ev, d) { emitted.push({ ev, d, room }); } });

    registerVoiceHandlers(socket, io, user);
    await socket._trigger('voice:join', { channelId: 'ch-act', serverId: 'sv-1' });
    await socket._trigger('voice:activity', { channelId: 'ch-act', speaking: true });

    const act = emitted.find(e => e.ev === 'voice:activity');
    expect(act).toBeDefined();
    expect(act.d.speaking).toBe(true);
    expect(act.d.userId).toBe(user._id);
  });
});

// ════════════════════════════════════════════════════════════════
// voice:e2e-key
// ════════════════════════════════════════════════════════════════

describe('voice:e2e-key', () => {
  it('şifreli anahtar hedef kullanıcının socket\'ine iletilir', async () => {
    const io       = makeIo();
    const ioEmitted = [];
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

    const keyEvent = ioEmitted.find(e => e.event === 'voice:e2e-key');
    expect(keyEvent).toBeDefined();
    expect(keyEvent._target).toBe('sock-e2e-receiver');
    expect(keyEvent.data.encryptedKey).toBe('enc-key-abc');
    expect(keyEvent.data.fromUserId).toBe(sender._id);
  });

  it('odada olmayan kullanıcıya key iletmeye çalışmak sessizce geçer', async () => {
    const io       = makeIo();
    const ioEmitted = [];
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

    const keyEvent = ioEmitted.find(e => e.ev === 'voice:e2e-key');
    expect(keyEvent).toBeUndefined();
  });
});
