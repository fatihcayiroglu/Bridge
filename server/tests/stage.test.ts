// server/tests/stage.test.ts
// stage.js socket handler entegrasyon testleri
// Test kapsamı:
//   - stage:join          (durum gönderimi)
//   - stage:setRole       (speaker / listener)
//   - stage:updateMute
//   - stage:handRaise
//   - stage:promote       (listener → speaker, yetki kontrolü)
import { ClusterServerDouble, EmittedLog, SocketDouble, findEmitted, readString, requireEmitted, requireEmittedData } from './helpers/socketDoubles';
//   - stage:leave
//   - disconnect          (otomatik temizlik)
//   - Edge case: boş oda, bilinmeyen kullanıcı

'use strict';
import { present } from './helpers/narrow';

process.env.NODE_ENV       = 'test';
process.env.JWT_SECRET     = 'test-jwt-secret-minimum-32-chars-long';
process.env.REFRESH_SECRET = 'test-refresh-secret-minimum-32-chars';
process.env.DATABASE_URL   = 'postgresql://bridge:bridge_test_pw@localhost:5432/bridge_test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

import { registerStageHandlers as registerStageHandlersProduction, stageRooms } from '../socket/handlers/stage';
const db = require('../db/loader');
const stageSocketUsers = new WeakMap<object, { _id: string }>();

async function ensureStageFixture(channelId: string, user: { _id: string }, serverId: string = 'sv-1') {
  // EKSIK FIXTURE: `_stageAccess` -> `resolvePermissions` ILK IS olarak
  // `Servers.findById(serverId)` yapar; satir yoksa 0 izin doner ve stage
  // olaylari SESSIZCE reddedilir. Sahip BASKA biri olsun ki testler sahiplik
  // kestirmesini degil GERCEK uye izin cozumunu olcsun.
  if (!(await db.servers.findOne({ _id: serverId }))) {
    await db.servers.insert({ _id: serverId, name: `srv-${serverId}`, ownerId: 'stage-owner', createdAt: Date.now() });
  }
  if (!(await db.channels.findOne({ _id: channelId }))) {
    await db.channels.insert({ _id: channelId, serverId, name: channelId, type: 'stage' });
  }
  const channel = await db.channels.findOne({ _id: channelId });
  if (channel?.serverId && !(await db.members.findOne({ userId: user._id, serverId: channel.serverId }))) {
    await db.members.insert({ _id: `member-${user._id}-${channel.serverId}`, userId: user._id, serverId: channel.serverId });
  }
}

function registerStageHandlers(socket: SocketDouble, io: ClusterServerDouble, user: StageUserDouble) {
  stageSocketUsers.set(socket, user);
  return registerStageHandlersProduction(socket, io, user);
}

// ── Yardımcılar ──────────────────────────────────────────────────

/** Sahne handler'larinin kullanicidan okudugu yuzey (`AuthenticatedUser`). */
interface StageUserDouble { _id: string; displayName?: string; avatarColor?: string }

function makeUser(overrides: Partial<StageUserDouble> = {}): StageUserDouble {
  return {
    _id: `u-${Math.random().toString(36).slice(2)}`,
    displayName: 'User',
    avatarColor: '#abc',
    ...overrides,
  };
}

function makeSocket(id: string) {
  const handlers: Record<string, unknown> = {};
  const emitted: EmittedLog = [];
  const rooms    = new Set<string>();

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
    async _trigger(event: string, data?: unknown) {
      // Yuk GUVENILMEZDIR; alanlar dogrulanarak okunur.
      const channelId = readString(data, 'channelId');
      if (event === 'stage:join' && channelId) {
        await ensureStageFixture(channelId, stageSocketUsers.get(socket)!, readString(data, 'serverId'));
      }
      const handler = handlers[event];
      if (typeof handler === 'function') return handler(data);
      return undefined;
    },
  } satisfies SocketDouble;
  return socket;
}

function makeIo() {
  const emitted: EmittedLog = [];
  // Kume denetimi (`on` + `serverSideEmit`) sahne handler'larinin GERCEK
  // bagimliligidir: medya yetkisi iptali Redis adapter'i uzerinden diger
  // dugumlere tasinir. Ikiz bunlari tasimadan sozlesmeyi karsilamazdi.
  const clusterListeners: Record<string, unknown> = {};
  const clusterEmits: EmittedLog = [];
  return {
    _emitted: emitted,
    _clusterEmits: clusterEmits,
    _clusterListeners: clusterListeners,
    to(target) {
      return { emit(ev, ...args) { emitted.push({ ev, data: args[0], _target: target }); } };
    },
    on(event, listener) { clusterListeners[event] = listener; },
    serverSideEmit(event, ...args) { clusterEmits.push({ event, data: args[0] }); },
  } satisfies ClusterServerDouble;
}

function clearStageRooms() {
  stageRooms.clear();
}

beforeEach(() => clearStageRooms());
afterEach(()  => clearStageRooms());

// ════════════════════════════════════════════════════════════════
// stage:join
// ════════════════════════════════════════════════════════════════

describe('stage:join', () => {
  it('socket odaya katılır ve mevcut state alır', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-join-1');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);

    await socket._trigger('stage:join', { channelId: 'ch-s1', serverId: 'sv-1' });

    expect(socket._rooms.has('stage:ch-s1')).toBe(true);
    const stateEvt = requireEmittedData(socket._emitted, 'stage:state');
    expect(stateEvt).toBeDefined();
    expect(stateEvt.channelId).toBe('ch-s1');
    expect(stateEvt.speakers).toEqual([]);
    expect(stateEvt.listeners).toEqual([]);
  });

  it('channelId yoksa işlem yapılmaz', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-join-noop');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);

    await socket._trigger('stage:join', {});
    expect(socket._rooms.size).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════
// stage:setRole
// ════════════════════════════════════════════════════════════════

describe('stage:setRole', () => {
  it('kullanıcı speaker olarak eklenir', async () => {
    const user   = makeUser({ displayName: 'Host' });
    const socket = makeSocket('s-role-1');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);
    await socket._trigger('stage:join',    { channelId: 'ch-role', serverId: 'sv-1' });
    await socket._trigger('stage:setRole', { channelId: 'ch-role', role: 'speaker' });

    const room = present(stageRooms.get('ch-role'), 'room');
    expect(room.speakers).toHaveLength(1);
    expect(room.speakers[0].userId).toBe(user._id);
    expect(room.listeners).toHaveLength(0);
  });

  it('kullanıcı listener olarak eklenir', async () => {
    const user   = makeUser({ displayName: 'Audience' });
    const socket = makeSocket('s-role-2');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);
    await socket._trigger('stage:join',    { channelId: 'ch-role-l', serverId: 'sv-1' });
    await socket._trigger('stage:setRole', { channelId: 'ch-role-l', role: 'listener' });

    const room = present(stageRooms.get('ch-role-l'), 'room');
    expect(room.listeners).toHaveLength(1);
    expect(room.speakers).toHaveLength(0);
  });

  it('rol değiştirilince eski listeden kaldırılır', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-role-switch');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);
    await socket._trigger('stage:join',    { channelId: 'ch-switch', serverId: 'sv-1' });
    await socket._trigger('stage:setRole', { channelId: 'ch-switch', role: 'speaker'  });
    await socket._trigger('stage:setRole', { channelId: 'ch-switch', role: 'listener' });

    const room = present(stageRooms.get('ch-switch'), 'room');
    expect(room.speakers).toHaveLength(0);
    expect(room.listeners).toHaveLength(1);
  });

  it('geçersiz rol sessizce reddedilir', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-role-bad');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);
    await socket._trigger('stage:join',    { channelId: 'ch-badrole', serverId: 'sv-1' });
    await socket._trigger('stage:setRole', { channelId: 'ch-badrole', role: 'moderator' });

    const room = present(stageRooms.get('ch-badrole'), 'room');
    expect(room.speakers).toHaveLength(0);
    expect(room.listeners).toHaveLength(0);
  });

  it('speaker muted:true olarak başlar', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-muted-start');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);
    await socket._trigger('stage:join',    { channelId: 'ch-muted', serverId: 'sv-1' });
    await socket._trigger('stage:setRole', { channelId: 'ch-muted', role: 'speaker'  });

    const room = present(stageRooms.get('ch-muted'), 'room');
    expect(room.speakers[0].muted).toBe(true);
  });

  it('stage:userJoined ve stage:state odaya emit edilir', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-joined-emit');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);
    await socket._trigger('stage:join',    { channelId: 'ch-emit', serverId: 'sv-1' });
    io._emitted.length = 0;
    await socket._trigger('stage:setRole', { channelId: 'ch-emit', role: 'speaker' });

    const userJoined = requireEmitted(io._emitted, 'stage:userJoined');
    const state      = requireEmitted(io._emitted, 'stage:state');
    expect(userJoined).toBeDefined();
    expect(state).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════
// stage:updateMute
// ════════════════════════════════════════════════════════════════

describe('stage:updateMute', () => {
  it('speaker\'ın mute durumu güncellenir ve odaya yayınlanır', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-mute-upd');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);
    await socket._trigger('stage:join',        { channelId: 'ch-mupd', serverId: 'sv-1' });
    await socket._trigger('stage:setRole',     { channelId: 'ch-mupd', role: 'speaker'  });
    io._emitted.length = 0;
    await socket._trigger('stage:updateMute',  { channelId: 'ch-mupd', muted: false });

    const room = present(stageRooms.get('ch-mupd'), 'room');
    expect(room.speakers[0].muted).toBe(false);

    const muteEvt = requireEmittedData(io._emitted, 'stage:muteUpdate');
    expect(muteEvt).toBeDefined();
    expect(muteEvt.userId).toBe(user._id);
    expect(muteEvt.muted).toBe(false);
  });

  it('odada olmayan channel\'da updateMute hata fırlatmaz', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-mute-noop');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);
    await expect(socket._trigger('stage:updateMute', { channelId: 'nonexistent', muted: true })).resolves.toBeUndefined();
  });

  it('listener updateMute gönderirse speaker listesi değişmez', async () => {
    const host     = makeUser({ displayName: 'Host' });
    const listener = makeUser({ displayName: 'Listener' });
    const io       = makeIo();

    const hSocket = makeSocket('s-host');
    registerStageHandlers(hSocket, io, host);
    await hSocket._trigger('stage:join',    { channelId: 'ch-listmute', serverId: 'sv-1' });
    await hSocket._trigger('stage:setRole', { channelId: 'ch-listmute', role: 'speaker' });

    const lSocket = makeSocket('s-listener');
    registerStageHandlers(lSocket, io, listener);
    await lSocket._trigger('stage:join',        { channelId: 'ch-listmute', serverId: 'sv-1' });
    await lSocket._trigger('stage:setRole',     { channelId: 'ch-listmute', role: 'listener' });
    io._emitted.length = 0;
    await lSocket._trigger('stage:updateMute',  { channelId: 'ch-listmute', muted: false });

    // muteUpdate emit edilmemeli (listener speaker değil)
    const muteEvt = findEmitted(io._emitted, 'stage:muteUpdate');
    expect(muteEvt).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════
// stage:handRaise
// ════════════════════════════════════════════════════════════════

describe('stage:handRaise', () => {
  it('el kaldırma durumu odaya yayınlanır', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-hand');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);
    await socket._trigger('stage:join',      { channelId: 'ch-hand', serverId: 'sv-1' });
    await socket._trigger('stage:setRole',   { channelId: 'ch-hand', role: 'listener' });
    io._emitted.length = 0;
    await socket._trigger('stage:handRaise', { channelId: 'ch-hand', raised: true });

    const room = present(stageRooms.get('ch-hand'), 'room');
    const inRoom = present([...room.speakers, ...room.listeners].find(u => u.userId === user._id), 'inRoom');
    expect(inRoom.handRaised).toBe(true);

    const handEvt = requireEmittedData(io._emitted, 'stage:handRaise');
    expect(handEvt).toBeDefined();
    expect(handEvt.raised).toBe(true);
  });

  it('el indirme çalışır', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-hand-down');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);
    await socket._trigger('stage:join',      { channelId: 'ch-hd', serverId: 'sv-1' });
    await socket._trigger('stage:setRole',   { channelId: 'ch-hd', role: 'listener' });
    await socket._trigger('stage:handRaise', { channelId: 'ch-hd', raised: true  });
    await socket._trigger('stage:handRaise', { channelId: 'ch-hd', raised: false });

    const room = present(stageRooms.get('ch-hd'), 'room');
    const inRoom = present(room.listeners.find(u => u.userId === user._id), 'inRoom');
    expect(inRoom.handRaised).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// stage:promote
// ════════════════════════════════════════════════════════════════

describe('stage:promote', () => {
  async function setupRoom(channelId: string) {
    const io   = makeIo();
    const host = makeUser({ displayName: 'Host' });
    const hSock = makeSocket('s-host-promote');
    registerStageHandlers(hSock, io, host);
    await hSock._trigger('stage:join',    { channelId, serverId: 'sv-1' });
    await hSock._trigger('stage:setRole', { channelId, role: 'speaker' });

    const listener = makeUser({ displayName: 'Listener' });
    const lSock    = makeSocket('s-list-promote');
    registerStageHandlers(lSock, io, listener);
    await lSock._trigger('stage:join',    { channelId, serverId: 'sv-1' });
    await lSock._trigger('stage:setRole', { channelId, role: 'listener' });

    return { io, host, hSock, listener, lSock };
  }

  it('host listener\'ı speaker\'a yükseltebilir', async () => {
    const { io, host, hSock, listener } = await setupRoom('ch-promote');
    io._emitted.length = 0;

    await hSock._trigger('stage:promote', { channelId: 'ch-promote', targetUserId: listener._id });

    const room = present(stageRooms.get('ch-promote'), 'room');
    expect(room.speakers.some(u => u.userId === listener._id)).toBe(true);
    expect(room.listeners.some(u => u.userId === listener._id)).toBe(false);

    const promEvt = requireEmittedData(io._emitted, 'stage:promoted');
    expect(promEvt).toBeDefined();
    expect(promEvt.userId).toBe(listener._id);
  });

  it('host olmayan kullanıcı promote edemez', async () => {
    const { io, listener, lSock } = await setupRoom('ch-promote-deny');
    io._emitted.length = 0;

    // Listener promote etmeye çalışıyor (host değil)
    await lSock._trigger('stage:promote', { channelId: 'ch-promote-deny', targetUserId: 'some-user' });

    const promEvt = findEmitted(io._emitted, 'stage:promoted');
    expect(promEvt).toBeUndefined();
  });

  it('odada olmayan listener promote edilemez', async () => {
    const { io, hSock } = await setupRoom('ch-promote-missing');
    io._emitted.length = 0;

    await hSock._trigger('stage:promote', { channelId: 'ch-promote-missing', targetUserId: 'ghost-id' });

    const promEvt = findEmitted(io._emitted, 'stage:promoted');
    expect(promEvt).toBeUndefined();
  });

  it('yükseltilen kullanıcı muted ve handRaised:false başlar', async () => {
    const { hSock, listener } = await setupRoom('ch-promote-state');

    // Önce el kaldırsın
    const lSock = makeSocket('s-list-hand');
    const io2   = makeIo();
    const room = present(stageRooms.get('ch-promote-state'), 'room');
    const li    = room.listeners.find(u => u.userId === listener._id);
    if (li) li.handRaised = true;

    await hSock._trigger('stage:promote', { channelId: 'ch-promote-state', targetUserId: listener._id });

    const updatedRoom = present(stageRooms.get('ch-promote-state'), 'updatedRoom');
    const promoted    = updatedRoom.speakers.find(u => u.userId === listener._id);
    if (promoted) {
      expect(promoted.muted).toBe(true);
      expect(promoted.handRaised).toBe(false);
    }
  });
});

// ════════════════════════════════════════════════════════════════
// stage:leave
// ════════════════════════════════════════════════════════════════

describe('stage:leave', () => {
  it('kullanıcı ayrılınca odadan kaldırılır', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-leave');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);
    await socket._trigger('stage:join',    { channelId: 'ch-leave', serverId: 'sv-1' });
    await socket._trigger('stage:setRole', { channelId: 'ch-leave', role: 'speaker' });
    io._emitted.length = 0;
    await socket._trigger('stage:leave',   { channelId: 'ch-leave' });

    // Oda SİLİNMİŞ ya da BOŞ olmalı — yokluk burada geçerli bir sonuçtur,
    // bu yüzden `present()` KULLANILMAZ.
    const room = stageRooms.get('ch-leave');
    const total = room ? room.speakers.length + room.listeners.length : 0;
    expect(total).toBe(0);

    expect(socket._rooms.has('stage:ch-leave')).toBe(false);

    const leftEvt = requireEmittedData(io._emitted, 'stage:userLeft');
    expect(leftEvt).toBeDefined();
    expect(leftEvt.userId).toBe(user._id);
  });

  it('son kullanıcı ayrılınca oda Map\'ten silinir', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-last');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);
    await socket._trigger('stage:join',    { channelId: 'ch-last', serverId: 'sv-1' });
    await socket._trigger('stage:setRole', { channelId: 'ch-last', role: 'listener' });
    await socket._trigger('stage:leave',   { channelId: 'ch-last' });

    expect(stageRooms.has('ch-last')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// disconnect otomatik temizlik
// ════════════════════════════════════════════════════════════════

describe('disconnect — otomatik temizlik', () => {
  it('disconnect olunca tüm odalardan kaldırılır', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-disc');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);

    // İki ayrı odaya katıl
    for (const ch of ['ch-disc-1', 'ch-disc-2']) {
      await socket._trigger('stage:join',    { channelId: ch, serverId: 'sv-1' });
      await socket._trigger('stage:setRole', { channelId: ch, role: 'speaker' });
    }

    expect(present(stageRooms.get('ch-disc-1'), 'stageRooms kaydi').speakers).toHaveLength(1);
    expect(present(stageRooms.get('ch-disc-2'), 'stageRooms kaydi').speakers).toHaveLength(1);

    await socket._trigger('disconnect');

    ['ch-disc-1', 'ch-disc-2'].forEach(ch => {
      // Yokluk geçerli bir sonuç (oda tamamen silinmiş olabilir).
      const room = stageRooms.get(ch);
      const total = room ? room.speakers.length + room.listeners.length : 0;
      expect(total).toBe(0);
    });
  });

  it('disconnect sonrası stage:userLeft emit edilir', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-disc-evt');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);
    await socket._trigger('stage:join',    { channelId: 'ch-disc-evt', serverId: 'sv-1' });
    await socket._trigger('stage:setRole', { channelId: 'ch-disc-evt', role: 'listener' });
    io._emitted.length = 0;

    await socket._trigger('disconnect');

    const leftEvt = requireEmittedData(io._emitted, 'stage:userLeft');
    expect(leftEvt).toBeDefined();
    expect(leftEvt.userId).toBe(user._id);
  });
});
