// server/tests/gdm-socket.test.ts
// registerGroupDmHandlers socket entegrasyon testleri
// Test kapsamı:
//   - gdm:send          (mesaj gönderme, üyelik kontrolü, limit)
//   - gdm:join          (odaya katılma)
//   - gdm:typing        (yazıyor bildirimi)
//   - gdm:call:start    (arama başlatma, üyelik kontrolü)
//   - gdm:call:join     (aramaya katılma, peer listesi)
import { EmittedLog, ServerDouble, SocketDouble, dataOf, findEmitted, requireEmitted, requireEmittedData } from './helpers/socketDoubles';
//   - gdm:call:leave    (aramadan ayrılma)
//   - gdm:call:end      (aramayı sonlandırma)
//   - gdm:call:offer / answer / ice  (WebRTC sinyalleme)
//   - gdm:call:state    (mute/video durumu)
//   - joinGroupRooms    (connect'te otomatik oda katılımı)

'use strict';
process.env.NODE_ENV = 'test';

import { createMockDb, makeUser } from './helpers/mockDb';
import type { MockDb } from './helpers/mockDb';

let db: MockDb;

// db/loader modülünü mock'la — registerGroupDmHandlers bu yolu kullanıyor
jest.mock('../db/loader', () => {
  const { createMockDb } = require('./helpers/mockDb');
  db = createMockDb();
  return db;
});

import { registerGroupDmHandlers } from '../socket/handlers/dm';
import { requireDoc } from './helpers/mockDb';
import { present, recordsOf } from './helpers/narrow';

// ── Yardımcılar ────────────────────────────────────────────────

function makeSocket(id: string) {
  const handlers: Record<string, unknown> = {};
  const emitted: EmittedLog = [];
  const rooms    = new Set([id]); // Socket.IO her soketi kendi id'siyle odaya alır

  // `satisfies SocketDouble`: ikizin ÜRÜN sözleşmesine (`HandlerSocket`)
  // uyduğu derleme zamanında kanıtlanır. Üye parametreleri sözleşmeden
  // bağlamsal tip aldığı için tek tek yazılmaz.
  //
  // `emit` artık gerçek imzayı taşıyor (`...args`): üretim kodu tek argümanlı
  // da yayım yapabiliyor ve iki parametreli sabit bir ikiz o çağrıyı taklit
  // edemezdi.
  const socket = {
    id,
    rooms,
    on(event, fn)  { handlers[event] = fn; },
    emit(ev, ...args) { emitted.push({ ev, data: args[0] }); },
    join(room)     { rooms.add(room); },
    leave(room)    { rooms.delete(room); },
    to(room) {
      return { emit(ev, ...args) { emitted.push({ ev, data: args[0], _room: room }); } };
    },
    _handlers: handlers,
    _emitted:  emitted,
    _rooms:    rooms,
    async _trigger(event: string, data?: unknown) {
      const handler = handlers[event];
      if (typeof handler === 'function') await handler(data);
    },
  } satisfies SocketDouble;
  return socket;
}

function makeIo() {
  const emitted: EmittedLog = [];

  // fetchSockets — belirli bir room'daki soketleri döner
  const roomSockets = new Map<string, Array<{ id: string }>>();

  // `satisfies ServerDouble`: ikiz, ÜRÜN sözleşmesine (`HandlerServer`)
  // uyduğunu derleme zamaninda kanitlar; kendi denetim alanlarini (`_emitted`,
  // `_roomSockets`, `_addToRoom`) korur ve üye parametreleri sözleşmeden
  // bağlamsal tip alır.
  //
  // DÜZELTME: `in()` eskiden `async` idi, yani bir `Promise` dönüyordu.
  // Gerçek `socket.io` kapsamı SENKRON döndürür; `io.in(room).fetchSockets()`
  // yazan üretim kodu bu ikizle çalışmazdı. Sözleşme bu sapmayi yakaladi.
  return {
    _emitted: emitted,
    _roomSockets: roomSockets,
    to(target) {
      return {
        emit(ev, data) { emitted.push({ ev, data, _target: target }); },
      };
    },
    in(room) {
      return {
        async fetchSockets() {
          return roomSockets.get(room) ?? [];
        },
      };
    },
    // Yardımcı: bir soketi belirli bir room'a ekle (fetchSockets için)
    _addToRoom(room: string, socket: { id: string }) {
      const list = roomSockets.get(room);
      if (list) list.push(socket);
      else roomSockets.set(room, [socket]);
    },
  } satisfies ServerDouble;
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

    const senderEcho = socket._emitted.find(e => e.ev === 'gdm:message' && !e._room);
    const broadcast = requireEmittedData(socket._emitted, 'gdm:message', { room: `gdm:${group._id}` });
    expect(senderEcho).toBeDefined();
    expect(broadcast).toBeDefined();
    expect(broadcast.content).toBe('Merhaba grup!');
    expect(broadcast.userId).toBe(user._id);
    expect(broadcast.groupId).toBe(group._id);
  });

  it('mesaj veritabanına kaydedilir', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-send-db');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());

    await socket._trigger('gdm:send', { groupId: group._id, content: 'DB test' });

    const saved = await db.groupDmMessages.findOne({ groupId: group._id });
    expect(saved).not.toBeNull();
    expect(present(saved, 'kayitli mesaj').content).toBe('DB test');
    expect(present(saved, 'kayitli mesaj').userId).toBe(user._id);
  });

  it('boş içerik reddedilir', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-send-empty');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());

    await socket._trigger('gdm:send', { groupId: group._id, content: '   ' });

    expect(findEmitted(io._emitted, 'gdm:message')).toBeUndefined();
  });

  it('2000 karakteri aşan içerik reddedilir', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-send-long');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());

    await socket._trigger('gdm:send', { groupId: group._id, content: 'x'.repeat(2001) });

    expect(findEmitted(io._emitted, 'gdm:message')).toBeUndefined();
  });

  it('grup üyesi olmayan kullanıcı mesaj gönderemez', async () => {
    const { group } = await setupGroup();
    const outsider  = makeUser();
    await db.users.insert(outsider);

    const socket = makeSocket('s-send-out');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, outsider, new Map());

    await socket._trigger('gdm:send', { groupId: group._id, content: 'Yetkisiz' });

    expect(findEmitted(io._emitted, 'gdm:message')).toBeUndefined();
  });

  it('aynı clientNonce retry tek grup mesajı üretir ve nonce yalnız gönderene döner', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-send-retry');
    const io = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());
    const clientNonce = 'gdm-nonce-retry-001';

    await socket._trigger('gdm:send', { groupId: group._id, content: 'Tek grup mesajı', clientNonce });
    await socket._trigger('gdm:send', { groupId: group._id, content: 'Tek grup mesajı', clientNonce });

    const saved = await db.groupDmMessages.find({ groupId: group._id, userId: user._id, clientNonce });
    expect(saved).toHaveLength(1);

    const senderEchoes = socket._emitted.filter(e => e.ev === 'gdm:message' && !e._room && dataOf(e).clientNonce === clientNonce);
    expect(senderEchoes).toHaveLength(2);
    expect(dataOf(senderEchoes[0])._id).toBe(dataOf(senderEchoes[1])._id);

    const peerMessages = socket._emitted.filter(e => e.ev === 'gdm:message' && e._room === `gdm:${group._id}`);
    expect(peerMessages).toHaveLength(1);
    expect(dataOf(peerMessages[0]).clientNonce).toBeUndefined();
  });

  it('reddedilen GDM gönderimi clientNonce ile tam bir kez hata üretir', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-send-error');
    const io = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());
    const clientNonce = 'gdm-nonce-error-001';

    await socket._trigger('gdm:send', { groupId: group._id, content: '   ', clientNonce });

    const errors = socket._emitted.filter(e => e.ev === 'error:message' && dataOf(e).clientNonce === clientNonce);
    expect(errors).toHaveLength(1);
    expect(errors[0].data).toEqual(expect.objectContaining({ event: 'gdm:send', code: 'EMPTY_MESSAGE', clientNonce }));
  });

  it('gönderme sonrası grup lastMessageAt güncellenir', async () => {
    const { user, group } = await setupGroup();
    const before = group.lastMessageAt;
    await new Promise(r => setTimeout(r, 5));

    const socket = makeSocket('s-send-ts');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());

    await socket._trigger('gdm:send', { groupId: group._id, content: 'Timestamp' });

    const updated = await requireDoc(db.groupDmConversations, { _id: group._id });
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

    await db.groupDmMembers.insert({ _id: 'manual-member', groupId: 'grp-manual', userId: user._id });

    await socket._trigger('gdm:join', 'grp-manual');

    expect(socket._rooms.has('gdm:grp-manual')).toBe(true);
  });

  it('farklı gruplara art arda katılabilir', async () => {
    const { user } = await setupGroup();
    const socket   = makeSocket('s-join-multi');
    const io       = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());

    await db.groupDmMembers.insert({ _id: 'multi-member-a', groupId: 'grp-a', userId: user._id });
    await db.groupDmMembers.insert({ _id: 'multi-member-b', groupId: 'grp-b', userId: user._id });

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
    const typingEvt = requireEmittedData(socket._emitted, 'gdm:typing', { room: `gdm:${group._id}` });
    expect(typingEvt).toBeDefined();
    expect(typingEvt.groupId).toBe(group._id);
    expect(typingEvt.userId).toBe(user._id);
    expect(typingEvt.displayName).toBe(user.displayName);
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
    const startedEvt = requireEmittedData(socket._emitted, 'gdm:call:started');
    expect(startedEvt).toBeDefined();
    expect(startedEvt.groupId).toBe(group._id);
    expect(startedEvt.type).toBe('voice');
  });

  it('grup odasındaki diğerlerine gdm:call:incoming gönderilir', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-call-incoming');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());

    await socket._trigger('gdm:call:start', { groupId: group._id, type: 'voice' });

    // socket.to(gdm:groupId).emit('gdm:call:incoming', ...) çağrılmış olmalı
    const incomingEvt = requireEmittedData(socket._emitted, 'gdm:call:incoming', { room: `gdm:${group._id}` });
    expect(incomingEvt).toBeDefined();
    expect(incomingEvt.callerId).toBe(user._id);
    expect(incomingEvt.groupId).toBe(group._id);
  });

  it('geçersiz type reddedilir', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-call-bad-type');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());

    await socket._trigger('gdm:call:start', { groupId: group._id, type: 'screenshare' });

    const startedEvt = findEmitted(socket._emitted, 'gdm:call:started');
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

    const startedEvt = findEmitted(socket._emitted, 'gdm:call:started');
    expect(startedEvt).toBeUndefined();
    expect(socket._rooms.has(`gdm:voice:${group._id}`)).toBe(false);
  });

  it('video tipi de kabul edilir', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-call-video');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());

    await socket._trigger('gdm:call:start', { groupId: group._id, type: 'video' });

    const startedEvt = requireEmittedData(socket._emitted, 'gdm:call:started');
    expect(startedEvt).toBeDefined();
    expect(startedEvt.type).toBe('video');
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

    const joinedEvt = requireEmittedData(socket._emitted, 'gdm:call:joined');
    expect(joinedEvt).toBeDefined();
    expect(joinedEvt.groupId).toBe(group._id);
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
    const peerJoinedEvt = requireEmittedData(socket._emitted, 'gdm:call:peer:joined');
    expect(peerJoinedEvt).toBeDefined();
    expect(peerJoinedEvt.userId).toBe(user._id);
    expect(peerJoinedEvt.groupId).toBe(group._id);
    expect(peerJoinedEvt.socketId).toBe(socket.id);
  });

  it('katılan sokete mevcut peer listesi gönderilir', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-calljoin-peers');
    const io     = makeIo();

    const existingSocket = { id: 's-peer-x', data: { userId: 'peer-x', displayName: 'Peer X' } };
    io._addToRoom(`gdm:voice:${group._id}`, existingSocket);

    registerGroupDmHandlers(socket, io, user, new Map());

    await socket._trigger('gdm:call:join', { groupId: group._id, type: 'voice' });

    const existingPeersEvt = requireEmittedData(socket._emitted, 'gdm:call:existing:peers');
    expect(existingPeersEvt).toBeDefined();
    expect(existingPeersEvt.groupId).toBe(group._id);
    expect(Array.isArray(existingPeersEvt.peers)).toBe(true);
    expect(recordsOf(existingPeersEvt.peers, 'peers').some(p => p.socketId === 's-peer-x')).toBe(true);
  });

  it('grup üyesi olmayan kullanıcı katılamaz', async () => {
    const { group } = await setupGroup();
    const outsider  = makeUser();
    await db.users.insert(outsider);

    const socket = makeSocket('s-calljoin-out');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, outsider, new Map());

    await socket._trigger('gdm:call:join', { groupId: group._id, type: 'voice' });

    const joinedEvt = findEmitted(socket._emitted, 'gdm:call:joined');
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

    const leftEvt = requireEmittedData(socket._emitted, 'gdm:call:left');
    expect(leftEvt).toBeDefined();
    expect(leftEvt.groupId).toBe(group._id);
  });

  it('diğer katılımcılara gdm:call:peer:left bildirilir', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-leave-peer');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());

    await socket._trigger('gdm:call:join', { groupId: group._id });
    socket._emitted.length = 0;

    await socket._trigger('gdm:call:leave', { groupId: group._id });

    const peerLeftEvt = requireEmittedData(socket._emitted, 'gdm:call:peer:left');
    expect(peerLeftEvt).toBeDefined();
    expect(peerLeftEvt.userId).toBe(user._id);
    expect(peerLeftEvt.socketId).toBe(socket.id);
  });

  it('ani disconnect sırasında her aktif voice room için peer:left yayınlar', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-disconnect-peer');
    const io = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());

    await socket._trigger('gdm:call:join', { groupId: group._id });
    socket.join('unrelated-room');
    socket._emitted.length = 0;

    // Socket.IO `disconnecting` eventini odalar otomatik boşaltılmadan önce
    // gönderir; handler bu pencereyi remote peer cleanup için kullanmalıdır.
    await socket._trigger('disconnecting', 'transport close');

    const peerLeft = socket._emitted.filter(e => e.ev === 'gdm:call:peer:left');
    expect(peerLeft).toHaveLength(1);
    expect(peerLeft[0]).toEqual({
      ev: 'gdm:call:peer:left',
      _room: `gdm:voice:${group._id}`,
      data: {
        groupId: group._id,
        userId: user._id,
        socketId: socket.id,
        reason: 'disconnect',
      },
    });
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
    socket.join(`gdm:voice:${group._id}`);

    await socket._trigger('gdm:call:end', { groupId: group._id });

    const endedEvt = requireEmittedData(io._emitted, 'gdm:call:ended', { target: `gdm:voice:${group._id}` });
    expect(endedEvt).toBeDefined();
    expect(endedEvt.groupId).toBe(group._id);
    expect(endedEvt.byUserId).toBe(user._id);
  });
});

// ════════════════════════════════════════════════════════════════
// WebRTC sinyalleme — offer / answer / ice
// ════════════════════════════════════════════════════════════════

describe('WebRTC sinyalleme', () => {
  /**
   * FAZ C4.4 — GERÇEK ÖN KOŞUL MODELLENİR.
   *
   * Sinyalleşme yalnızca görüşme odasındaki eşlere yapılır: istemci bir eşin
   * soket kimliğini SADECE `gdm:call:existing:peers` / `gdm:call:peer:joined`
   * olaylarından öğrenir ve bunlar yalnız `gdm:voice:<groupId>` odasındaki
   * soketleri içerir. Bu testler eskiden hiç odaya alınmamış kimliklere
   * yönlendirme yapıyordu — üretimde oluşamayacak bir durum. Sunucu artık
   * hedefin O GÖRÜŞMEYE ait olduğunu doğruladığı için ön koşul burada da
   * kurulur. Assertion'lar aynen korunmuştur.
   */
  async function setup(peerIds: string[] = []) {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-webrtc-1');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());
    // Signaling is call-scoped: both sender and target must belong to the
    // current GDM voice room, not merely to the group.
    socket.join(`gdm:voice:${group._id}`);
    for (const pid of peerIds) io._addToRoom(`gdm:voice:${group._id}`, { id: pid });
    return { user, group, socket, io };
  }

  it('gdm:call:offer hedef sokete yönlendirilir', async () => {
    const { group, socket, io } = await setup(['s-target']);
    const offer = { type: 'offer', sdp: 'v=0...' };

    await socket._trigger('gdm:call:offer', {
      groupId: group._id,
      targetSocketId: 's-target',
      offer,
    });

    const fwd = requireEmittedData(io._emitted, 'gdm:call:offer', { target: 's-target' });
    expect(fwd).toBeDefined();
    expect(fwd.fromSocketId).toBe(socket.id);
    expect(fwd.offer).toEqual(offer);
    expect(fwd.groupId).toBe(group._id);
  });

  it('gdm:call:answer hedef sokete yönlendirilir', async () => {
    const { group, socket, io } = await setup(['s-callee']);
    const answer = { type: 'answer', sdp: 'v=0...' };

    await socket._trigger('gdm:call:answer', {
      groupId: group._id,
      targetSocketId: 's-callee',
      answer,
    });

    const fwd = requireEmittedData(io._emitted, 'gdm:call:answer', { target: 's-callee' });
    expect(fwd).toBeDefined();
    expect(fwd.fromSocketId).toBe(socket.id);
    expect(fwd.answer).toEqual(answer);
  });

  it('gdm:call:ice hedef sokete yönlendirilir', async () => {
    const { group, socket, io } = await setup(['s-peer']);
    const candidate = { candidate: 'candidate:1 ...', sdpMid: '0', sdpMLineIndex: 0 };

    await socket._trigger('gdm:call:ice', {
      groupId: group._id,
      targetSocketId: 's-peer',
      candidate,
    });

    const fwd = requireEmittedData(io._emitted, 'gdm:call:ice', { target: 's-peer' });
    expect(fwd).toBeDefined();
    expect(fwd.candidate).toEqual(candidate);
    expect(fwd.fromSocketId).toBe(socket.id);
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
    socket.join(`gdm:voice:${group._id}`);

    await socket._trigger('gdm:call:state', { groupId: group._id, muted: true, video: false });

    const stateEvt = requireEmittedData(socket._emitted, 'gdm:call:peer:state', { room: `gdm:voice:${group._id}` });
    expect(stateEvt).toBeDefined();
    expect(stateEvt.muted).toBe(true);
    expect(stateEvt.video).toBe(false);
    expect(stateEvt.userId).toBe(user._id);
    expect(stateEvt.socketId).toBe(socket.id);
    expect(stateEvt.groupId).toBe(group._id);
  });

  it('video aktifleştirme durumu iletilir', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-state-video');
    const io     = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());
    socket.join(`gdm:voice:${group._id}`);

    await socket._trigger('gdm:call:state', { groupId: group._id, muted: false, video: true });

    const stateEvt = requireEmittedData(socket._emitted, 'gdm:call:peer:state');
    expect(stateEvt).toBeDefined();
    expect(stateEvt.muted).toBe(false);
    expect(stateEvt.video).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
// FAZ C4.3 — ÜYELİK İPTALİNDEN SONRA `gdm:join` TEKRARI (REPLAY)
// ════════════════════════════════════════════════════════════════
//
// Soket bağlanırken kullanıcının TÜM gruplarına katılır (joinGroupRooms).
// Üyelik iptal edildiğinde sunucu onu odadan çıkarır; ancak eski/kötü niyetli
// bir istemci `gdm:join` olayını YENİDEN gönderebilir. Handler bağlanma
// anındaki anlık görüntüye değil, HER SEFERİNDE arka uçtaki GÜNCEL üyeliğe
// bakmak zorundadır. Aksi hâlde çıkarılan üye odaya geri girip canlı mesaj
// yayınlarını almaya devam ederdi.
describe('C4.3 — GÜVENLİK: üyelik iptalinden sonra gdm:join reddedilir', () => {
  it('GÜVENLİK: üyelik silindikten sonra gdm:join odaya GERİ SOKMAZ', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-revoked');
    registerGroupDmHandlers(socket, makeIo(), user, new Map());

    // 1) Geçerli üyeyken katılabiliyor (pozitif kontrol).
    await socket._trigger('gdm:join', group._id);
    expect(socket._rooms.has(`gdm:${group._id}`)).toBe(true);

    // 2) Üyelik iptal edilir ve soket odadan çıkarılır.
    await db.groupDmMembers.remove({ groupId: group._id, userId: user._id });
    socket.leave(`gdm:${group._id}`);
    expect(socket._rooms.has(`gdm:${group._id}`)).toBe(false);

    // 3) Eski istemci olayı TEKRAR gönderir → reddedilmeli.
    await socket._trigger('gdm:join', group._id);

    expect(socket._rooms.has(`gdm:${group._id}`)).toBe(false);
  });

  it('GÜVENLİK: hiç üye olmayan kullanıcı gdm:join ile odaya giremez', async () => {
    const { group } = await setupGroup();
    const yabanci = makeUser({ displayName: 'Yabanci' });
    await db.users.insert(yabanci);
    const socket = makeSocket('s-yabanci');
    registerGroupDmHandlers(socket, makeIo(), yabanci, new Map());

    await socket._trigger('gdm:join', group._id);

    expect(socket._rooms.has(`gdm:${group._id}`)).toBe(false);
  });

  it('GÜVENLİK: tahmin edilen/var olmayan grup kimliği reddedilir', async () => {
    const { user } = await setupGroup();
    const socket = makeSocket('s-tahmin');
    registerGroupDmHandlers(socket, makeIo(), user, new Map());

    await socket._trigger('gdm:join', 'grp-tahmin-edilen');

    expect(socket._rooms.has('gdm:grp-tahmin-edilen')).toBe(false);
  });

  it('GÜVENLİK: üyelik iptalinden sonra gdm:send de reddedilir', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-revoked-send');
    const io = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());

    await db.groupDmMembers.remove({ groupId: group._id, userId: user._id });
    await socket._trigger('gdm:send', { groupId: group._id, content: 'gecmis olsun' });

    expect(io._emitted.filter(e => e.ev === 'gdm:message')).toHaveLength(0);
    expect(await db.groupDmMessages.find({ groupId: group._id })).toHaveLength(0);
  });

  it('GÜVENLİK: üyelik iptalinden sonra gdm:typing yayınlanmaz', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-revoked-typing');
    registerGroupDmHandlers(socket, makeIo(), user, new Map());

    await db.groupDmMembers.remove({ groupId: group._id, userId: user._id });
    await socket._trigger('gdm:typing', { groupId: group._id });

    expect(socket._emitted.filter(e => e.ev === 'gdm:typing')).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════
// FAZ C4.4 — SESLİ GÖRÜŞME OLAYLARINDA ÜYELİK YETKİLENDİRMESİ
// ════════════════════════════════════════════════════════════════
//
// ── KAPATILAN GERÇEK AÇIKLAR ────────────────────────────────────
// `gdm:call:end`, `gdm:call:state`, `gdm:call:leave` ve WebRTC sinyalleşme
// olayları YALNIZCA payload şeklini doğruluyordu. Kimliği doğrulanmış
// HERHANGİ bir kullanıcı, üyesi OLMADIĞI bir grubun kimliğini vererek:
//   · o grubun görüşmesini herkes için SONLANDIRABİLİYOR (uzaktan kesinti),
//   · sahte "peer state" / "peer left" yayınlayabiliyor,
//   · sinyalleşme mesajlarını sunucudaki herhangi bir sokete yollayabiliyordu.
// Odada BULUNMAK yetki değildir; güncel üyelik her olayda doğrulanır.
describe('C4.4 — GÜVENLİK: sesli görüşme olayları üyelik ister', () => {
  async function yabanciSocket(groupId: string) {
    const yabanci = makeUser({ displayName: 'Yabanci' });
    await db.users.insert(yabanci);
    const socket = makeSocket('s-dis');
    const io = makeIo();
    registerGroupDmHandlers(socket, io, yabanci, new Map());
    void groupId;
    return { socket, io };
  }

  it('GÜVENLİK: üye olmayan görüşmeyi SONLANDIRAMAZ', async () => {
    const { group } = await setupGroup();
    const { socket, io } = await yabanciSocket(group._id);

    await socket._trigger('gdm:call:end', { groupId: group._id });

    expect(io._emitted.filter(e => e.ev === 'gdm:call:ended')).toHaveLength(0);
  });

  it('grup üyesi olsa da aktif call room dışında görüşmeyi sonlandıramaz', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-uye-disarida');
    const io = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());

    await socket._trigger('gdm:call:end', { groupId: group._id });

    expect(io._emitted.filter(e => e.ev === 'gdm:call:ended')).toHaveLength(0);
  });

  it('aktif call room içindeki üye görüşmeyi sonlandırabilir (pozitif kontrol)', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-uye');
    const io = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());
    socket.join(`gdm:voice:${group._id}`);

    await socket._trigger('gdm:call:end', { groupId: group._id });

    expect(io._emitted.filter(e => e.ev === 'gdm:call:ended')).toHaveLength(1);
  });

  it('GÜVENLİK: üye olmayan sahte peer:state yayınlayamaz', async () => {
    const { group } = await setupGroup();
    const { socket } = await yabanciSocket(group._id);

    await socket._trigger('gdm:call:state', { groupId: group._id, muted: true });

    expect(socket._emitted.filter(e => e.ev === 'gdm:call:peer:state')).toHaveLength(0);
  });

  it('GÜVENLİK: üye olmayan sahte peer:left yayınlayamaz', async () => {
    const { group } = await setupGroup();
    const { socket } = await yabanciSocket(group._id);

    await socket._trigger('gdm:call:leave', { groupId: group._id });

    expect(socket._emitted.filter(e => e.ev === 'gdm:call:peer:left')).toHaveLength(0);
  });

  it('GÜVENLİK: üye olmayan sinyalleşme mesajı YÖNLENDİREMEZ', async () => {
    const { group } = await setupGroup();
    const { socket, io } = await yabanciSocket(group._id);
    io._addToRoom(`gdm:voice:${group._id}`, { id: 's-kurban' });

    await socket._trigger('gdm:call:offer', {
      groupId: group._id, targetSocketId: 's-kurban', offer: { sdp: 'x' },
    });

    expect(io._emitted.filter(e => e.ev === 'gdm:call:offer')).toHaveLength(0);
  });

  it('GÜVENLİK: grup üyesi ama görüşme odasında olmayan kullanıcı signaling ENJEKTE EDEMEZ', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-member-outside-call');
    const io = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());
    io._addToRoom(`gdm:voice:${group._id}`, { id: 's-victim-in-call' });

    await socket._trigger('gdm:call:offer', {
      groupId: group._id,
      targetSocketId: 's-victim-in-call',
      offer: { type: 'offer', sdp: 'x' },
    });

    expect(io._emitted.filter(e => e.ev === 'gdm:call:offer')).toHaveLength(0);
  });

  it('GÜVENLİK: grup üyesi ama görüşme odasında olmayan kullanıcı peer state ENJEKTE EDEMEZ', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-member-state-outside-call');
    registerGroupDmHandlers(socket, makeIo(), user, new Map());

    await socket._trigger('gdm:call:state', { groupId: group._id, muted: true, video: true });

    expect(socket._emitted.filter(e => e.ev === 'gdm:call:peer:state')).toHaveLength(0);
  });

  it('GÜVENLİK: grup üyesi ama görüşme odasında olmayan kullanıcı sahte peer:left ENJEKTE EDEMEZ', async () => {
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-member-leave-outside-call');
    registerGroupDmHandlers(socket, makeIo(), user, new Map());

    await socket._trigger('gdm:call:leave', { groupId: group._id });

    expect(socket._emitted.filter(e => e.ev === 'gdm:call:peer:left')).toHaveLength(0);
    expect(socket._emitted.filter(e => e.ev === 'gdm:call:left')).toHaveLength(0);
  });

  it('GÜVENLİK: üye olsa bile GÖRÜŞME ODASINDA OLMAYAN sokete sinyal gönderilemez', async () => {
    // C2 dersi: iç içe kimlik aidiyet kanıtlamaz — hedefin bu görüşmeye ait
    // olduğu ayrıca doğrulanır.
    const { user, group } = await setupGroup();
    const socket = makeSocket('s-uye-2');
    const io = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map());

    await socket._trigger('gdm:call:ice', {
      groupId: group._id, targetSocketId: 's-baska-gruptan', candidate: { c: 1 },
    });

    expect(io._emitted.filter(e => e.ev === 'gdm:call:ice')).toHaveLength(0);
  });
});
