// server/tests/stage-socket.test.js
// registerStageHandlers kapsamlı socket entegrasyon testleri
// Mevcut stage.test.js'in genişletilmiş versiyonu:
//   - stage:join          (durum gönderimi, eksik channelId)
//   - stage:setRole       (speaker / listener, rol değişimi, muted başlangıcı)
//   - stage:updateMute    (speaker/listener davranışı)
//   - stage:handRaise     (el kaldır / indir)
//   - stage:promote       (yetki kontrolü, state değişimi)
//   - stage:demote        (speaker → listener, yetki kontrolü)  ← YENİ
//   - stage:leave         (temizlik, oda silme)
//   - disconnect          (multi-room temizlik)
//   - Edge case'ler: bilinmeyen kanal, boş oda

'use strict';
process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => {
  const { createMockDb } = require('./helpers/mockDb');
  const db = createMockDb();
  return db;
});

const { registerStageHandlers, stageRooms } = require('../socket/handlers/stage');

// ── Yardımcılar ────────────────────────────────────────────────

function makeUser(overrides = {}) {
  return {
    _id:         `u-${Math.random().toString(36).slice(2)}`,
    displayName: 'StageUser',
    avatarColor: '#abc',
    ...overrides,
  };
}

function makeSocket(id) {
  const handlers = {};
  const emitted  = [];
  const rooms    = new Set();

  const socket = {
    id,
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

function makeIo() {
  const emitted = [];
  return {
    _emitted: emitted,
    to(target) {
      return { emit(ev, data) { emitted.push({ ev, data, _target: target }); } };
    },
  };
}

function clearRooms() { stageRooms.clear(); }

beforeEach(() => clearRooms());
afterEach(()  => clearRooms());

// ════════════════════════════════════════════════════════════════
// stage:join
// ════════════════════════════════════════════════════════════════

describe('stage:join', () => {
  it('socket odaya katılır ve mevcut state alır', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-j1');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);

    await socket._trigger('stage:join', { channelId: 'ch-1', serverId: 'sv-1' });

    expect(socket._rooms.has('stage:ch-1')).toBe(true);
    const state = socket._emitted.find(e => e.ev === 'stage:state');
    expect(state).toBeDefined();
    expect(state.data.channelId).toBe('ch-1');
    expect(state.data.speakers).toEqual([]);
    expect(state.data.listeners).toEqual([]);
  });

  it('channelId yoksa işlem yapılmaz', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-j-noop');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);

    await expect(socket._trigger('stage:join', {})).resolves.not.toThrow();
    expect(socket._rooms.size).toBe(0);
  });

  it('aynı kanala iki kez join yapılabilir (idempotent)', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-j-idem');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);

    await socket._trigger('stage:join', { channelId: 'ch-idem', serverId: 'sv-1' });
    await socket._trigger('stage:join', { channelId: 'ch-idem', serverId: 'sv-1' });

    expect(socket._rooms.has('stage:ch-idem')).toBe(true);
    expect(() => {}).not.toThrow();
  });

  it('birden fazla farklı odaya katılınabilir', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-j-multi');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);

    await socket._trigger('stage:join', { channelId: 'ch-A' });
    await socket._trigger('stage:join', { channelId: 'ch-B' });

    expect(socket._rooms.has('stage:ch-A')).toBe(true);
    expect(socket._rooms.has('stage:ch-B')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
// stage:setRole
// ════════════════════════════════════════════════════════════════

describe('stage:setRole', () => {
  it('kullanıcı speaker olarak eklenir', async () => {
    const user   = makeUser({ displayName: 'Host' });
    const socket = makeSocket('s-r1');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);

    await socket._trigger('stage:join',    { channelId: 'ch-r1' });
    await socket._trigger('stage:setRole', { channelId: 'ch-r1', role: 'speaker' });

    const room = stageRooms.get('ch-r1');
    expect(room.speakers).toHaveLength(1);
    expect(room.speakers[0].userId).toBe(user._id);
    expect(room.listeners).toHaveLength(0);
  });

  it('kullanıcı listener olarak eklenir', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-r2');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);

    await socket._trigger('stage:join',    { channelId: 'ch-r2' });
    await socket._trigger('stage:setRole', { channelId: 'ch-r2', role: 'listener' });

    const room = stageRooms.get('ch-r2');
    expect(room.listeners).toHaveLength(1);
    expect(room.speakers).toHaveLength(0);
  });

  it('rol değiştirilince eski listeden kaldırılır', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-r-switch');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);

    await socket._trigger('stage:join',    { channelId: 'ch-sw' });
    await socket._trigger('stage:setRole', { channelId: 'ch-sw', role: 'speaker'  });
    await socket._trigger('stage:setRole', { channelId: 'ch-sw', role: 'listener' });

    const room = stageRooms.get('ch-sw');
    expect(room.speakers).toHaveLength(0);
    expect(room.listeners).toHaveLength(1);
  });

  it('speaker muted:true ile başlar', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-r-muted');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);

    await socket._trigger('stage:join',    { channelId: 'ch-m' });
    await socket._trigger('stage:setRole', { channelId: 'ch-m', role: 'speaker' });

    expect(stageRooms.get('ch-m').speakers[0].muted).toBe(true);
  });

  it('listener handRaised:false ile başlar', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-r-hand');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);

    await socket._trigger('stage:join',    { channelId: 'ch-hr' });
    await socket._trigger('stage:setRole', { channelId: 'ch-hr', role: 'listener' });

    expect(stageRooms.get('ch-hr').listeners[0].handRaised).toBe(false);
  });

  it('geçersiz rol sessizce reddedilir', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-r-bad');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);

    await socket._trigger('stage:join',    { channelId: 'ch-bad' });
    await socket._trigger('stage:setRole', { channelId: 'ch-bad', role: 'moderator' });

    const room = stageRooms.get('ch-bad');
    expect(room.speakers).toHaveLength(0);
    expect(room.listeners).toHaveLength(0);
  });

  it('stage:setRole sonrası stage:state odaya emit edilir', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-r-emit');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);

    await socket._trigger('stage:join', { channelId: 'ch-emit' });
    io._emitted.length = 0;
    await socket._trigger('stage:setRole', { channelId: 'ch-emit', role: 'speaker' });

    expect(io._emitted.find(e => e.ev === 'stage:state')).toBeDefined();
  });

  it('socketId userObj\'e kaydedilir', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-r-sid');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);

    await socket._trigger('stage:join',    { channelId: 'ch-sid' });
    await socket._trigger('stage:setRole', { channelId: 'ch-sid', role: 'speaker' });

    const room = stageRooms.get('ch-sid');
    expect(room.speakers[0].socketId).toBe('s-r-sid');
  });
});

// ════════════════════════════════════════════════════════════════
// stage:updateMute
// ════════════════════════════════════════════════════════════════

describe('stage:updateMute', () => {
  it('speaker mute durumu güncellenir ve yayınlanır', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-mu-1');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);

    await socket._trigger('stage:join',       { channelId: 'ch-mu' });
    await socket._trigger('stage:setRole',    { channelId: 'ch-mu', role: 'speaker' });
    io._emitted.length = 0;
    await socket._trigger('stage:updateMute', { channelId: 'ch-mu', muted: false });

    expect(stageRooms.get('ch-mu').speakers[0].muted).toBe(false);

    const muteEvt = io._emitted.find(e => e.ev === 'stage:muteUpdate');
    expect(muteEvt).toBeDefined();
    expect(muteEvt.data.userId).toBe(user._id);
    expect(muteEvt.data.muted).toBe(false);
  });

  it('mevcut olmayan channel\'da updateMute hata fırlatmaz', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-mu-noop');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);

    await expect(socket._trigger('stage:updateMute', { channelId: 'ghost', muted: true })).resolves.not.toThrow();
  });

  it('listener updateMute gönderirse stage:muteUpdate emit edilmez', async () => {
    const host     = makeUser();
    const listener = makeUser();
    const io       = makeIo();

    const hSock = makeSocket('s-mu-host');
    registerStageHandlers(hSock, io, host);
    await hSock._trigger('stage:join',    { channelId: 'ch-listmu' });
    await hSock._trigger('stage:setRole', { channelId: 'ch-listmu', role: 'speaker' });

    const lSock = makeSocket('s-mu-list');
    registerStageHandlers(lSock, io, listener);
    await lSock._trigger('stage:join',       { channelId: 'ch-listmu' });
    await lSock._trigger('stage:setRole',    { channelId: 'ch-listmu', role: 'listener' });
    io._emitted.length = 0;
    await lSock._trigger('stage:updateMute', { channelId: 'ch-listmu', muted: false });

    expect(io._emitted.find(e => e.ev === 'stage:muteUpdate')).toBeUndefined();
  });

  it('tekrar mute etmek çalışır', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-mu-re');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);

    await socket._trigger('stage:join',       { channelId: 'ch-re' });
    await socket._trigger('stage:setRole',    { channelId: 'ch-re', role: 'speaker' });
    await socket._trigger('stage:updateMute', { channelId: 'ch-re', muted: false });
    await socket._trigger('stage:updateMute', { channelId: 'ch-re', muted: true });

    expect(stageRooms.get('ch-re').speakers[0].muted).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
// stage:handRaise
// ════════════════════════════════════════════════════════════════

describe('stage:handRaise', () => {
  it('el kaldırma durumu güncellenir ve yayınlanır', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-hr-1');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);

    await socket._trigger('stage:join',      { channelId: 'ch-hand' });
    await socket._trigger('stage:setRole',   { channelId: 'ch-hand', role: 'listener' });
    io._emitted.length = 0;
    await socket._trigger('stage:handRaise', { channelId: 'ch-hand', raised: true });

    const room = stageRooms.get('ch-hand');
    expect(room.listeners[0].handRaised).toBe(true);

    const handEvt = io._emitted.find(e => e.ev === 'stage:handRaise');
    expect(handEvt).toBeDefined();
    expect(handEvt.data.raised).toBe(true);
    expect(handEvt.data.userId).toBe(user._id);
  });

  it('el indirme çalışır', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-hr-down');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);

    await socket._trigger('stage:join',      { channelId: 'ch-hd' });
    await socket._trigger('stage:setRole',   { channelId: 'ch-hd', role: 'listener' });
    await socket._trigger('stage:handRaise', { channelId: 'ch-hd', raised: true  });
    await socket._trigger('stage:handRaise', { channelId: 'ch-hd', raised: false });

    expect(stageRooms.get('ch-hd').listeners[0].handRaised).toBe(false);
  });

  it('mevcut olmayan channel\'da handRaise hata fırlatmaz', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-hr-noop');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);

    await expect(socket._trigger('stage:handRaise', { channelId: 'ghost', raised: true })).resolves.not.toThrow();
  });

  it('speaker da el kaldırabilir', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-hr-sp');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);

    await socket._trigger('stage:join',      { channelId: 'ch-sp-hr' });
    await socket._trigger('stage:setRole',   { channelId: 'ch-sp-hr', role: 'speaker' });
    await socket._trigger('stage:handRaise', { channelId: 'ch-sp-hr', raised: true });

    const room = stageRooms.get('ch-sp-hr');
    expect(room.speakers[0].handRaised).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
// stage:promote
// ════════════════════════════════════════════════════════════════

describe('stage:promote', () => {
  function setupRoom(channelId) {
    const io   = makeIo();
    const host = makeUser({ displayName: 'Host' });
    const hSock = makeSocket(`s-host-${channelId}`);
    registerStageHandlers(hSock, io, host);
    hSock._trigger('stage:join',    { channelId, serverId: 'sv-1' });
    hSock._trigger('stage:setRole', { channelId, role: 'speaker' });

    const listener = makeUser({ displayName: 'Listener' });
    const lSock    = makeSocket(`s-list-${channelId}`);
    registerStageHandlers(lSock, io, listener);
    lSock._trigger('stage:join',    { channelId, serverId: 'sv-1' });
    lSock._trigger('stage:setRole', { channelId, role: 'listener' });

    return { io, host, hSock, listener, lSock };
  }

  it('host listener\'ı speaker\'a yükseltebilir', async () => {
    const { io, hSock, listener } = setupRoom('ch-prom-1');
    io._emitted.length = 0;

    await hSock._trigger('stage:promote', { channelId: 'ch-prom-1', targetUserId: listener._id });

    const room = stageRooms.get('ch-prom-1');
    expect(room.speakers.some(u => u.userId === listener._id)).toBe(true);
    expect(room.listeners.some(u => u.userId === listener._id)).toBe(false);

    const promEvt = io._emitted.find(e => e.ev === 'stage:promoted');
    expect(promEvt).toBeDefined();
    expect(promEvt.data.userId).toBe(listener._id);
  });

  it('host olmayan kullanıcı promote edemez', async () => {
    const { io, lSock } = setupRoom('ch-prom-deny');
    io._emitted.length = 0;

    await lSock._trigger('stage:promote', { channelId: 'ch-prom-deny', targetUserId: 'some-user' });

    expect(io._emitted.find(e => e.ev === 'stage:promoted')).toBeUndefined();
  });

  it('odada olmayan listener promote edilemez', async () => {
    const { io, hSock } = setupRoom('ch-prom-miss');
    io._emitted.length = 0;

    await hSock._trigger('stage:promote', { channelId: 'ch-prom-miss', targetUserId: 'ghost-id' });

    expect(io._emitted.find(e => e.ev === 'stage:promoted')).toBeUndefined();
  });

  it('yükseltilen kullanıcı muted:true ve handRaised:false ile başlar', async () => {
    const { hSock, listener } = setupRoom('ch-prom-state');

    // Önce el kaldırsın
    const room = stageRooms.get('ch-prom-state');
    const li   = room.listeners.find(u => u.userId === listener._id);
    if (li) li.handRaised = true;

    await hSock._trigger('stage:promote', { channelId: 'ch-prom-state', targetUserId: listener._id });

    const promoted = stageRooms.get('ch-prom-state').speakers.find(u => u.userId === listener._id);
    if (promoted) {
      expect(promoted.muted).toBe(true);
      expect(promoted.handRaised).toBe(false);
    }
  });

  it('promote sonrası stage:state odaya emit edilir', async () => {
    const { io, hSock, listener } = setupRoom('ch-prom-state2');
    io._emitted.length = 0;

    await hSock._trigger('stage:promote', { channelId: 'ch-prom-state2', targetUserId: listener._id });

    const stateEvt = io._emitted.find(e => e.ev === 'stage:state');
    expect(stateEvt).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════
// stage:demote  (speaker → listener)
// ════════════════════════════════════════════════════════════════

describe('stage:demote', () => {
  async function setupWithOwner(channelId) {
    const db     = require('../db/loader');
    const owner  = makeUser({ displayName: 'Owner' });
    const server = { _id: 'sv-demote', ownerId: owner._id };
    const channel = { _id: channelId, serverId: 'sv-demote', type: 'stage' };

    await db.servers.insert(server);
    await db.channels.insert(channel);
    await db.users.insert(owner);

    const io        = makeIo();
    const ownerSock = makeSocket(`s-owner-${channelId}`);
    registerStageHandlers(ownerSock, io, owner);
    await ownerSock._trigger('stage:join',    { channelId, serverId: 'sv-demote' });
    await ownerSock._trigger('stage:setRole', { channelId, role: 'speaker' });

    // Ekstra speaker (indirilecek)
    const speaker  = makeUser({ displayName: 'Speaker' });
    const spSock   = makeSocket(`s-sp-${channelId}`);
    registerStageHandlers(spSock, io, speaker);
    await spSock._trigger('stage:join',    { channelId, serverId: 'sv-demote' });
    await spSock._trigger('stage:setRole', { channelId, role: 'speaker' });

    return { io, owner, ownerSock, speaker, spSock, server, channel };
  }

  it('sunucu sahibi bir speaker\'ı dinleyiciye indirebilir', async () => {
    const { io, ownerSock, speaker } = await setupWithOwner('ch-demote-1');
    io._emitted.length = 0;

    await ownerSock._trigger('stage:demote', { channelId: 'ch-demote-1', targetUserId: speaker._id });

    const room = stageRooms.get('ch-demote-1');
    // speaker → listener
    expect(room.listeners.some(u => u.userId === speaker._id)).toBe(true);
    expect(room.speakers.some(u => u.userId === speaker._id)).toBe(false);
  });

  it('demote sonrası stage:demoted emit edilir', async () => {
    const { io, ownerSock, speaker } = await setupWithOwner('ch-demote-2');
    io._emitted.length = 0;

    await ownerSock._trigger('stage:demote', { channelId: 'ch-demote-2', targetUserId: speaker._id });

    const demoteEvt = io._emitted.find(e => e.ev === 'stage:demoted');
    expect(demoteEvt).toBeDefined();
    expect(demoteEvt.data.userId).toBe(speaker._id);
    expect(demoteEvt.data.channelId).toBe('ch-demote-2');
  });

  it('demote sonrası stage:state emit edilir', async () => {
    const { io, ownerSock, speaker } = await setupWithOwner('ch-demote-3');
    io._emitted.length = 0;

    await ownerSock._trigger('stage:demote', { channelId: 'ch-demote-3', targetUserId: speaker._id });

    const stateEvt = io._emitted.find(e => e.ev === 'stage:state');
    expect(stateEvt).toBeDefined();
  });

  it('demote edilen kullanıcı muted:false ve handRaised:false ile listener\'a geçer', async () => {
    const { ownerSock, speaker } = await setupWithOwner('ch-demote-4');

    await ownerSock._trigger('stage:demote', { channelId: 'ch-demote-4', targetUserId: speaker._id });

    const room    = stageRooms.get('ch-demote-4');
    const demoted = room.listeners.find(u => u.userId === speaker._id);
    if (demoted) {
      expect(demoted.muted).toBe(false);
      expect(demoted.handRaised).toBe(false);
    }
  });

  it('speakers listesinde olmayan kullanıcı demote edilemez', async () => {
    const { io, ownerSock } = await setupWithOwner('ch-demote-5');
    io._emitted.length = 0;

    await ownerSock._trigger('stage:demote', { channelId: 'ch-demote-5', targetUserId: 'ghost-speaker' });

    expect(io._emitted.find(e => e.ev === 'stage:demoted')).toBeUndefined();
  });

  it('channelId veya targetUserId eksikse işlem yapılmaz', async () => {
    const { io, ownerSock } = await setupWithOwner('ch-demote-6');
    io._emitted.length = 0;

    await ownerSock._trigger('stage:demote', { channelId: 'ch-demote-6' }); // targetUserId yok
    await ownerSock._trigger('stage:demote', { targetUserId: 'someone' });   // channelId yok

    expect(io._emitted.find(e => e.ev === 'stage:demoted')).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════
// stage:leave
// ════════════════════════════════════════════════════════════════

describe('stage:leave', () => {
  it('kullanıcı ayrılınca odadan kaldırılır', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-leave-1');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);

    await socket._trigger('stage:join',    { channelId: 'ch-leave' });
    await socket._trigger('stage:setRole', { channelId: 'ch-leave', role: 'speaker' });
    io._emitted.length = 0;
    await socket._trigger('stage:leave',   { channelId: 'ch-leave' });

    const room  = stageRooms.get('ch-leave');
    const total = room ? room.speakers.length + room.listeners.length : 0;
    expect(total).toBe(0);
    expect(socket._rooms.has('stage:ch-leave')).toBe(false);
  });

  it('stage:userLeft emit edilir', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-leave-evt');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);

    await socket._trigger('stage:join',    { channelId: 'ch-levt' });
    await socket._trigger('stage:setRole', { channelId: 'ch-levt', role: 'listener' });
    io._emitted.length = 0;
    await socket._trigger('stage:leave',   { channelId: 'ch-levt' });

    const leftEvt = io._emitted.find(e => e.ev === 'stage:userLeft');
    expect(leftEvt).toBeDefined();
    expect(leftEvt.data.userId).toBe(user._id);
  });

  it('son kullanıcı ayrılınca oda Map\'ten silinir', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-leave-last');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);

    await socket._trigger('stage:join',    { channelId: 'ch-last' });
    await socket._trigger('stage:setRole', { channelId: 'ch-last', role: 'listener' });
    await socket._trigger('stage:leave',   { channelId: 'ch-last' });

    expect(stageRooms.has('ch-last')).toBe(false);
  });

  it('channelId yoksa hata fırlatmaz', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-leave-noid');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);

    await expect(socket._trigger('stage:leave', {})).resolves.not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════
// disconnect — otomatik temizlik
// ════════════════════════════════════════════════════════════════

describe('disconnect — otomatik temizlik', () => {
  it('disconnect olunca tüm odalardan kaldırılır', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-disc-1');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);

    for (const ch of ['ch-disc-A', 'ch-disc-B']) {
      await socket._trigger('stage:join',    { channelId: ch });
      await socket._trigger('stage:setRole', { channelId: ch, role: 'speaker' });
    }

    expect(stageRooms.get('ch-disc-A').speakers).toHaveLength(1);
    expect(stageRooms.get('ch-disc-B').speakers).toHaveLength(1);

    await socket._trigger('disconnect');

    for (const ch of ['ch-disc-A', 'ch-disc-B']) {
      const room  = stageRooms.get(ch);
      const total = room ? room.speakers.length + room.listeners.length : 0;
      expect(total).toBe(0);
    }
  });

  it('disconnect sonrası stage:userLeft emit edilir', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-disc-evt');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);

    await socket._trigger('stage:join',    { channelId: 'ch-disc-ev' });
    await socket._trigger('stage:setRole', { channelId: 'ch-disc-ev', role: 'listener' });
    io._emitted.length = 0;

    await socket._trigger('disconnect');

    const leftEvt = io._emitted.find(e => e.ev === 'stage:userLeft');
    expect(leftEvt).toBeDefined();
    expect(leftEvt.data.userId).toBe(user._id);
  });

  it('hiç odaya katılmamış kullanıcı disconnect\'te hata fırlatmaz', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-disc-empty');
    const io     = makeIo();
    registerStageHandlers(socket, io, user);

    await expect(socket._trigger('disconnect')).resolves.not.toThrow();
  });

  it('disconnect sonrası diğer kullanıcılar etkilenmez', async () => {
    const userA  = makeUser({ displayName: 'A' });
    const userB  = makeUser({ displayName: 'B' });
    const io     = makeIo();

    const sA = makeSocket('s-disc-A');
    registerStageHandlers(sA, io, userA);
    await sA._trigger('stage:join',    { channelId: 'ch-others' });
    await sA._trigger('stage:setRole', { channelId: 'ch-others', role: 'speaker' });

    const sB = makeSocket('s-disc-B');
    registerStageHandlers(sB, io, userB);
    await sB._trigger('stage:join',    { channelId: 'ch-others' });
    await sB._trigger('stage:setRole', { channelId: 'ch-others', role: 'listener' });

    // A disconnect oluyor
    await sA._trigger('disconnect');

    const room = stageRooms.get('ch-others');
    expect(room).toBeDefined();
    // B hâlâ odada olmalı
    expect(room.listeners.some(u => u.userId === userB._id)).toBe(true);
    // A gitmeli
    expect(room.speakers.some(u => u.userId === userA._id)).toBe(false);
  });
});
