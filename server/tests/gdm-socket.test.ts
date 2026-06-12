// server/tests/gdm-socket.test.ts
// registerGroupDmHandlers socket entegrasyon testleri
// Test kapsamı:
//   - gdm:send          (mesaj gönderme, üyelik kontrolü, limit)
//   - gdm:join          (odaya katılma)
//   - gdm:typing        (yazıyor bildirimi)
//   - gdm:call:start    (arama başlatma, üyelik kontrolü)
//   - gdm:call:join     (aramaya katılma, peer listesi)
//   - gdm:call:leave    (aramadan ayrılma)
//   - gdm:call:end      (aramayı sonlandırma)
//   - gdm:call:offer / answer / ice  (WebRTC sinyalleme)
//   - gdm:call:state    (mute/video durumu)
//   - joinGroupRooms    (connect'te otomatik oda katılımı)

'use strict';
process.env.NODE_ENV = 'test';

import { createMockDb, makeUser } from './helpers/mockDb';

let db;

// db/loader modülünü mock'la — registerGroupDmHandlers bu yolu kullanıyor
jest.mock('../db/loader', () => {
  const { createMockDb } = require('./helpers/mockDb');
  db = createMockDb();
  return db;
});

import { registerGroupDmHandlers } from '../socket/handlers/dm';

// ── Yardımcılar ────────────────────────────────────────────────

function makeSocket(id) {
  const handlers: Record<string, unknown> = {};
  const emitted  = [];
  const rooms    = new Set([id]); // Socket.IO her soketi kendi id'siyle odaya alır

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
    async _trigger(event, data) {
      if (handlers[event]) await handlers[event](data);
    },
  };
  return socket;
}

function makeIo(sockets = []) {
  const emitted = [];

  // fetchSockets — belirli bir room'daki soketleri döner
  const roomSockets = new Map();

  return {
    _emitted: emitted,
    _roomSockets: roomSockets,
    to(target) {
      return {
        emit(ev, data) { emitted.push({ ev, data, _target: target }); },
      };
    },
    async in(room) {
      return {
        async fetchSockets() {
          return roomSockets.get(room) || [];
        },
      };
    },
    // Yardımcı: bir soketi belirli bir room'a ekle (fetchSockets için)
    _addToRoom(room, socket) {
      if (!roomSockets.has(room)) roomSockets.set(room, []);
      roomSockets.get(room).push(socket);
    },
  };
}

async function setupGroup(overrides = {}) {
  db = createMockDb();
  Object.assign(require('../db/loader'), db);

  const user = makeUser({ displayName: 'Alice', avatarColor: '#2d9cdb', ...overrides });
  await db.users.insert(user);

  const group = {
    _id:         'grp-test-1',
    name:        'Test Group',
    createdBy:   user._id,
    createdAt:   Date.now(),
    lastMessageAt: Date.now(),
  };
  await db.groupDmConversations.insert(group);
  await db.groupDmMembers.insert({ _id: `m-${user._id}`, groupId: group._id, userId: user._id, joinedAt: Date.now() });

  return { user, group };
}

beforeEach(() => {
  db = createMockDb();
  Object.assign(require('../db/loader'), db);
});

// ════════════════════════════════════════════════════════════════
// joinGroupRooms — connect'te otomatik oda katılımı
// ════════════════════════════════════════════════════════════════

describe('joinGroupRooms — connect sonrası otomatik oda katılımı', () => {
  it('kullanıcının tüm grup DM odalarına katılır', async () => {
    const { user, group } = await setupGroup();
    const group2 = { _id: 'grp-test-2', name: 'Group2', createdBy: user._id, createdAt: Date.now() };
    await db.groupDmConversations.insert(group2);
    await db.groupDmMembers.insert({ _id: `m2-${user._id}`, groupId: group2._id, userId: user._id, joinedAt: Date.now() });

    const socket = makeSocket('s-auto');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());

    // joinGroupRooms async — bir tick bekle
    await new Promise(r => setImmediate(r));

    expect(socket._rooms.has(`gdm:${group._id}`)).toBe(true);
    expect(socket._rooms.has(`gdm:${group2._id}`)).toBe(true);
  });

  it('hiç üye olmayan kullanıcı hiçbir odaya katılmaz', async () => {
    const user = makeUser();
    await db.users.insert(user);

    const socket = makeSocket('s-no-groups');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());

    await new Promise(r => setImmediate(r));

    const gdmRooms = [...socket._rooms].filter(r => r.startsWith('gdm:'));
    expect(gdmRooms).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════
// gdm:send
// ════════════════════════════════════════════════════════════════

describe('gdm:send', () => {
  it('üye mesaj gönderebilir ve odaya yayınlanır', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-send-1');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());

    await socket._trigger('gdm:send', { groupId: group._id, content: 'Merhaba grup!' });

    const broadcast = io._emitted.find(e => e.ev === 'gdm:message' && e._target === `gdm:${group._id}`);
    expect(broadcast).toBeDefined();
    expect(broadcast.data.content).toBe('Merhaba grup!');
    expect(broadcast.data.userId).toBe(user._id);
    expect(broadcast.data.groupId).toBe(group._id);
  });

  it('mesaj veritabanına kaydedilir', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-send-db');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());

    await socket._trigger('gdm:send', { groupId: group._id, content: 'DB test' });

    const saved = await db.groupDmMessages.findOne({ groupId: group._id });
    expect(saved).not.toBeNull();
    expect(saved.content).toBe('DB test');
    expect(saved.userId).toBe(user._id);
  });

  it('boş içerik reddedilir', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-send-empty');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());

    await socket._trigger('gdm:send', { groupId: group._id, content: '   ' });

    expect(io._emitted.find(e => e.ev === 'gdm:message')).toBeUndefined();
  });

  it('2000 karakteri aşan içerik reddedilir', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-send-long');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());

    await socket._trigger('gdm:send', { groupId: group._id, content: 'x'.repeat(2001) });

    expect(io._emitted.find(e => e.ev === 'gdm:message')).toBeUndefined();
  });

  it('grup üyesi olmayan kullanıcı mesaj gönderemez', async () => {
    const { group } = await setupGroup();
    const outsider  = makeUser();
    await db.users.insert(outsider);

    const socket = makeSocket('s-send-out');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, outsider, new Map());

    await socket._trigger('gdm:send', { groupId: group._id, content: 'Yetkisiz' });

    expect(io._emitted.find(e => e.ev === 'gdm:message')).toBeUndefined();
  });

  it('gönderme sonrası grup lastMessageAt güncellenir', async () => {
    const { user, group } = await setupGroup();
    const before = group.lastMessageAt;
    await new Promise(r => setTimeout(r, 5));

    const socket = makeSocket('s-send-ts');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());

    await socket._trigger('gdm:send', { groupId: group._id, content: 'Timestamp' });

    const updated = await db.groupDmConversations.findOne({ _id: group._id });
    expect(updated.lastMessageAt).toBeGreaterThan(before);
  });
});

// ════════════════════════════════════════════════════════════════
// gdm:join
// ════════════════════════════════════════════════════════════════

describe('gdm:join', () => {
  it('socket belirtilen gdm odasına katılır', async () => {
    const { user } = await setupGroup();
    const socket   = makeSocket('s-join-1');
    const io       = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());

    await socket._trigger('gdm:join', 'grp-manual');

    expect(socket._rooms.has('gdm:grp-manual')).toBe(true);
  });

  it('farklı gruplara art arda katılabilir', async () => {
    const { user } = await setupGroup();
    const socket   = makeSocket('s-join-multi');
    const io       = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());

    await socket._trigger('gdm:join', 'grp-a');
    await socket._trigger('gdm:join', 'grp-b');

    expect(socket._rooms.has('gdm:grp-a')).toBe(true);
    expect(socket._rooms.has('gdm:grp-b')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
// gdm:typing
// ════════════════════════════════════════════════════════════════

describe('gdm:typing', () => {
  it('yazıyor bildirimi diğer üyelere yayınlanır', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-typing-1');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());

    await socket._trigger('gdm:typing', { groupId: group._id });

    // socket.to() ile emit edilmiş olmalı (kendine değil)
    const typingEvt = socket._emitted.find(e => e.ev === 'gdm:typing' && e._room === `gdm:${group._id}`);
    expect(typingEvt).toBeDefined();
    expect(typingEvt.data.groupId).toBe(group._id);
    expect(typingEvt.data.userId).toBe(user._id);
    expect(typingEvt.data.displayName).toBe(user.displayName);
  });
});

// ════════════════════════════════════════════════════════════════
// gdm:call:start
// ════════════════════════════════════════════════════════════════

describe('gdm:call:start', () => {
  it('üye sesli arama başlatabilir', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-call-start');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());

    await socket._trigger('gdm:call:start', { groupId: group._id, type: 'voice' });

    // Voice room'a katılmış olmalı
    expect(socket._rooms.has(`gdm:voice:${group._id}`)).toBe(true);

    // Caller'a gdm:call:started emit edilmiş olmalı
    const startedEvt = socket._emitted.find(e => e.ev === 'gdm:call:started');
    expect(startedEvt).toBeDefined();
    expect(startedEvt.data.groupId).toBe(group._id);
    expect(startedEvt.data.type).toBe('voice');
  });

  it('grup odasındaki diğerlerine gdm:call:incoming gönderilir', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-call-incoming');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());

    await socket._trigger('gdm:call:start', { groupId: group._id, type: 'voice' });

    // socket.to(gdm:groupId).emit('gdm:call:incoming', ...) çağrılmış olmalı
    const incomingEvt = socket._emitted.find(e => e.ev === 'gdm:call:incoming' && e._room === `gdm:${group._id}`);
    expect(incomingEvt).toBeDefined();
    expect(incomingEvt.data.callerId).toBe(user._id);
    expect(incomingEvt.data.groupId).toBe(group._id);
  });

  it('geçersiz type reddedilir', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-call-bad-type');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());

    await socket._trigger('gdm:call:start', { groupId: group._id, type: 'screenshare' });

    const startedEvt = socket._emitted.find(e => e.ev === 'gdm:call:started');
    expect(startedEvt).toBeUndefined();
  });

  it('grup üyesi olmayan kullanıcı arama başlatamaz', async () => {
    const { group } = await setupGroup();
    const outsider  = makeUser();
    await db.users.insert(outsider);

    const socket = makeSocket('s-call-unauth');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, outsider, new Map());

    await socket._trigger('gdm:call:start', { groupId: group._id, type: 'voice' });

    const startedEvt = socket._emitted.find(e => e.ev === 'gdm:call:started');
    expect(startedEvt).toBeUndefined();
    expect(socket._rooms.has(`gdm:voice:${group._id}`)).toBe(false);
  });

  it('video tipi de kabul edilir', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-call-video');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());

    await socket._trigger('gdm:call:start', { groupId: group._id, type: 'video' });

    const startedEvt = socket._emitted.find(e => e.ev === 'gdm:call:started');
    expect(startedEvt).toBeDefined();
    expect(startedEvt.data.type).toBe('video');
  });
});

// ════════════════════════════════════════════════════════════════
// gdm:call:join
// ════════════════════════════════════════════════════════════════

describe('gdm:call:join', () => {
  it('üye aramaya katılabilir', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-calljoin-1');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());

    await socket._trigger('gdm:call:join', { groupId: group._id, type: 'voice' });

    expect(socket._rooms.has(`gdm:voice:${group._id}`)).toBe(true);

    const joinedEvt = socket._emitted.find(e => e.ev === 'gdm:call:joined');
    expect(joinedEvt).toBeDefined();
    expect(joinedEvt.data.groupId).toBe(group._id);
  });

  it('mevcut katılımcılara gdm:call:peer:joined emit edilir', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-calljoin-peer');
    const io     = makeIo();

    // Voice room'da zaten biri var gibi simüle et
    const existingSocket = { id: 's-existing', data: { userId: 'existing-user', displayName: 'Mevcut' } };
    io._addToRoom(`gdm:voice:${group._id}`, existingSocket);

    registerGroupDmHandlers(socket, io, user, new Map());

    await socket._trigger('gdm:call:join', { groupId: group._id, type: 'voice' });

    // Diğerlerine peer:joined gönderilmeli
    const peerJoinedEvt = socket._emitted.find(e => e.ev === 'gdm:call:peer:joined');
    expect(peerJoinedEvt).toBeDefined();
    expect(peerJoinedEvt.data.userId).toBe(user._id);
    expect(peerJoinedEvt.data.groupId).toBe(group._id);
    expect(peerJoinedEvt.data.socketId).toBe(socket.id);
  });

  it('katılan sokete mevcut peer listesi gönderilir', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-calljoin-peers');
    const io     = makeIo();

    const existingSocket = { id: 's-peer-x', data: { userId: 'peer-x', displayName: 'Peer X' } };
    io._addToRoom(`gdm:voice:${group._id}`, existingSocket);

    registerGroupDmHandlers(socket, io, user, new Map());

    await socket._trigger('gdm:call:join', { groupId: group._id, type: 'voice' });

    const existingPeersEvt = socket._emitted.find(e => e.ev === 'gdm:call:existing:peers');
    expect(existingPeersEvt).toBeDefined();
    expect(existingPeersEvt.data.groupId).toBe(group._id);
    expect(Array.isArray(existingPeersEvt.data.peers)).toBe(true);
    expect(existingPeersEvt.data.peers.some(p => p.socketId === 's-peer-x')).toBe(true);
  });

  it('grup üyesi olmayan kullanıcı katılamaz', async () => {
    const { group } = await setupGroup();
    const outsider  = makeUser();
    await db.users.insert(outsider);

    const socket = makeSocket('s-calljoin-out');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, outsider, new Map());

    await socket._trigger('gdm:call:join', { groupId: group._id, type: 'voice' });

    const joinedEvt = socket._emitted.find(e => e.ev === 'gdm:call:joined');
    expect(joinedEvt).toBeUndefined();
    expect(socket._rooms.has(`gdm:voice:${group._id}`)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// gdm:call:leave
// ════════════════════════════════════════════════════════════════

describe('gdm:call:leave', () => {
  it('kullanıcı voice room\'dan ayrılır', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-leave-1');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());

    // Önce katıl
    await socket._trigger('gdm:call:join', { groupId: group._id });
    socket._emitted.length = 0;

    await socket._trigger('gdm:call:leave', { groupId: group._id });

    expect(socket._rooms.has(`gdm:voice:${group._id}`)).toBe(false);

    const leftEvt = socket._emitted.find(e => e.ev === 'gdm:call:left');
    expect(leftEvt).toBeDefined();
    expect(leftEvt.data.groupId).toBe(group._id);
  });

  it('diğer katılımcılara gdm:call:peer:left bildirilir', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-leave-peer');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());

    await socket._trigger('gdm:call:join', { groupId: group._id });
    socket._emitted.length = 0;

    await socket._trigger('gdm:call:leave', { groupId: group._id });

    const peerLeftEvt = socket._emitted.find(e => e.ev === 'gdm:call:peer:left');
    expect(peerLeftEvt).toBeDefined();
    expect(peerLeftEvt.data.userId).toBe(user._id);
    expect(peerLeftEvt.data.socketId).toBe(socket.id);
  });
});

// ════════════════════════════════════════════════════════════════
// gdm:call:end
// ════════════════════════════════════════════════════════════════

describe('gdm:call:end', () => {
  it('aramayı sonlandırır ve tüm katılımcılara bildirir', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-end-1');
    const io     = makeIo();

    // Odada 2 soket var gibi simüle et
    const peer = makeSocket('s-peer-end');
    peer.join(`gdm:voice:${group._id}`);
    io._addToRoom(`gdm:voice:${group._id}`, peer);

    registerGroupDmHandlers(socket, io, user, new Map());

    await socket._trigger('gdm:call:end', { groupId: group._id });

    const endedEvt = io._emitted.find(e => e.ev === 'gdm:call:ended' && e._target === `gdm:voice:${group._id}`);
    expect(endedEvt).toBeDefined();
    expect(endedEvt.data.groupId).toBe(group._id);
    expect(endedEvt.data.byUserId).toBe(user._id);
  });
});

// ════════════════════════════════════════════════════════════════
// WebRTC sinyalleme — offer / answer / ice
// ════════════════════════════════════════════════════════════════

describe('WebRTC sinyalleme', () => {
  async function setup() {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-webrtc-1');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());
    return { user, group, socket, io };
  }

  it('gdm:call:offer hedef sokete yönlendirilir', async () => {
    const { group, socket, io } = await setup();
    const offer = { type: 'offer', sdp: 'v=0...' };

    await socket._trigger('gdm:call:offer', {
      groupId: group._id,
      targetSocketId: 's-target',
      offer,
    });

    const fwd = io._emitted.find(e => e.ev === 'gdm:call:offer' && e._target === 's-target');
    expect(fwd).toBeDefined();
    expect(fwd.data.fromSocketId).toBe(socket.id);
    expect(fwd.data.offer).toEqual(offer);
    expect(fwd.data.groupId).toBe(group._id);
  });

  it('gdm:call:answer hedef sokete yönlendirilir', async () => {
    const { group, socket, io } = await setup();
    const answer = { type: 'answer', sdp: 'v=0...' };

    await socket._trigger('gdm:call:answer', {
      groupId: group._id,
      targetSocketId: 's-callee',
      answer,
    });

    const fwd = io._emitted.find(e => e.ev === 'gdm:call:answer' && e._target === 's-callee');
    expect(fwd).toBeDefined();
    expect(fwd.data.fromSocketId).toBe(socket.id);
    expect(fwd.data.answer).toEqual(answer);
  });

  it('gdm:call:ice hedef sokete yönlendirilir', async () => {
    const { group, socket, io } = await setup();
    const candidate = { candidate: 'candidate:1 ...', sdpMid: '0', sdpMLineIndex: 0 };

    await socket._trigger('gdm:call:ice', {
      groupId: group._id,
      targetSocketId: 's-peer',
      candidate,
    });

    const fwd = io._emitted.find(e => e.ev === 'gdm:call:ice' && e._target === 's-peer');
    expect(fwd).toBeDefined();
    expect(fwd.data.candidate).toEqual(candidate);
    expect(fwd.data.fromSocketId).toBe(socket.id);
  });
});

// ════════════════════════════════════════════════════════════════
// gdm:call:state — mute/video durumu
// ════════════════════════════════════════════════════════════════

describe('gdm:call:state', () => {
  it('mute durumu voice room\'a yayınlanır', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-state-1');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());

    await socket._trigger('gdm:call:state', { groupId: group._id, muted: true, video: false });

    const stateEvt = socket._emitted.find(
      e => e.ev === 'gdm:call:peer:state' && e._room === `gdm:voice:${group._id}`
    );
    expect(stateEvt).toBeDefined();
    expect(stateEvt.data.muted).toBe(true);
    expect(stateEvt.data.video).toBe(false);
    expect(stateEvt.data.userId).toBe(user._id);
    expect(stateEvt.data.socketId).toBe(socket.id);
    expect(stateEvt.data.groupId).toBe(group._id);
  });

  it('video aktifleştirme durumu iletilir', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-state-video');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());

    await socket._trigger('gdm:call:state', { groupId: group._id, muted: false, video: true });

    const stateEvt = socket._emitted.find(e => e.ev === 'gdm:call:peer:state');
    expect(stateEvt).toBeDefined();
    expect(stateEvt.data.muted).toBe(false);
    expect(stateEvt.data.video).toBe(true);
  });
});
