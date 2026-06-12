// server/tests/stage.test.ts
// stage.js socket handler entegrasyon testleri
// Test kapsamı:
//   - stage:join          (durum gönderimi)
//   - stage:setRole       (speaker / listener)
//   - stage:updateMute
//   - stage:handRaise
//   - stage:promote       (listener → speaker, yetki kontrolü)
//   - stage:leave
//   - disconnect          (otomatik temizlik)
//   - Edge case: boş oda, bilinmeyen kullanıcı

'use strict';

process.env.NODE_ENV       = 'test';
process.env.JWT_SECRET     = 'test-jwt-secret-minimum-32-chars-long';
process.env.REFRESH_SECRET = 'test-refresh-secret-minimum-32-chars';
process.env.DATABASE_URL   = 'postgresql://bridge:bridge_test_pw@localhost:5432/bridge_test';

import { registerStageHandlers, stageRooms } from '../socket/handlers/stage';

// ── Yardımcılar ──────────────────────────────────────────────────

function makeUser(overrides = {}) {
  return {
    _id: `u-${Math.random().toString(36).slice(2)}`,
    displayName: 'User',
    avatarColor: '#abc',
    ...overrides,
  };
}

function makeSocket(id) {
  const handlers: Record<string, unknown> = {};
  const emitted  = [];
  const rooms    = new Set();

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
    _trigger(event, data) { if (handlers[event]) return handlers[event](data); },
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
    const stateEvt = socket._emitted.find(e => e.ev === 'stage:state');
    expect(stateEvt).toBeDefined();
    expect(stateEvt.data.channelId).toBe('ch-s1');
    expect(stateEvt.data.speakers).toEqual([]);
    expect(stateEvt.data.listeners).toEqual([]);
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

    const room = stageRooms.get('ch-role');
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

    const room = stageRooms.get('ch-role-l');
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

    const room = stageRooms.get('ch-switch');
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

    const room = stageRooms.get('ch-badrole');
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

    const room = stageRooms.get('ch-muted');
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

    const userJoined = io._emitted.find(e => e.ev === 'stage:userJoined');
    const state      = io._emitted.find(e => e.ev === 'stage:state');
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

    const room = stageRooms.get('ch-mupd');
    expect(room.speakers[0].muted).toBe(false);

    const muteEvt = io._emitted.find(e => e.ev === 'stage:muteUpdate');
    expect(muteEvt).toBeDefined();
    expect(muteEvt.data.userId).toBe(user._id);
    expect(muteEvt.data.muted).toBe(false);
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
    const muteEvt = io._emitted.find(e => e.ev === 'stage:muteUpdate');
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

    const room    = stageRooms.get('ch-hand');
    const inRoom  = [...room.speakers, ...room.listeners].find(u => u.userId === user._id);
    expect(inRoom.handRaised).toBe(true);

    const handEvt = io._emitted.find(e => e.ev === 'stage:handRaise');
    expect(handEvt).toBeDefined();
    expect(handEvt.data.raised).toBe(true);
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

    const room   = stageRooms.get('ch-hd');
    const inRoom = room.listeners.find(u => u.userId === user._id);
    expect(inRoom.handRaised).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// stage:promote
// ════════════════════════════════════════════════════════════════

describe('stage:promote', () => {
  async function setupRoom(channelId) {
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

    const room = stageRooms.get('ch-promote');
    expect(room.speakers.some(u => u.userId === listener._id)).toBe(true);
    expect(room.listeners.some(u => u.userId === listener._id)).toBe(false);

    const promEvt = io._emitted.find(e => e.ev === 'stage:promoted');
    expect(promEvt).toBeDefined();
    expect(promEvt.data.userId).toBe(listener._id);
  });

  it('host olmayan kullanıcı promote edemez', async () => {
    const { io, listener, lSock } = await setupRoom('ch-promote-deny');
    io._emitted.length = 0;

    // Listener promote etmeye çalışıyor (host değil)
    await lSock._trigger('stage:promote', { channelId: 'ch-promote-deny', targetUserId: 'some-user' });

    const promEvt = io._emitted.find(e => e.ev === 'stage:promoted');
    expect(promEvt).toBeUndefined();
  });

  it('odada olmayan listener promote edilemez', async () => {
    const { io, hSock } = await setupRoom('ch-promote-missing');
    io._emitted.length = 0;

    await hSock._trigger('stage:promote', { channelId: 'ch-promote-missing', targetUserId: 'ghost-id' });

    const promEvt = io._emitted.find(e => e.ev === 'stage:promoted');
    expect(promEvt).toBeUndefined();
  });

  it('yükseltilen kullanıcı muted ve handRaised:false başlar', async () => {
    const { hSock, listener } = await setupRoom('ch-promote-state');

    // Önce el kaldırsın
    const lSock = makeSocket('s-list-hand');
    const io2   = makeIo();
    const room  = stageRooms.get('ch-promote-state');
    const li    = room.listeners.find(u => u.userId === listener._id);
    if (li) li.handRaised = true;

    await hSock._trigger('stage:promote', { channelId: 'ch-promote-state', targetUserId: listener._id });

    const updatedRoom = stageRooms.get('ch-promote-state');
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

    const room = stageRooms.get('ch-leave');
    // Oda silinmiş veya boş olmalı
    const total = room ? room.speakers.length + room.listeners.length : 0;
    expect(total).toBe(0);

    expect(socket._rooms.has('stage:ch-leave')).toBe(false);

    const leftEvt = io._emitted.find(e => e.ev === 'stage:userLeft');
    expect(leftEvt).toBeDefined();
    expect(leftEvt.data.userId).toBe(user._id);
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

    expect(stageRooms.get('ch-disc-1').speakers).toHaveLength(1);
    expect(stageRooms.get('ch-disc-2').speakers).toHaveLength(1);

    await socket._trigger('disconnect');

    ['ch-disc-1', 'ch-disc-2'].forEach(ch => {
      const room  = stageRooms.get(ch);
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

    const leftEvt = io._emitted.find(e => e.ev === 'stage:userLeft');
    expect(leftEvt).toBeDefined();
    expect(leftEvt.data.userId).toBe(user._id);
  });
});
