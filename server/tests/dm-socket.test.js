// server/tests/dm-socket.test.js
// registerDmHandlers socket entegrasyon testleri
// Test kapsamı:
//   - dm:call:start    (arama başlatma, ring, auto-cancel)
//   - dm:call:accept   (aramayı kabul etme, ready sinyali)
//   - dm:call:decline  (aramayı reddetme)
//   - dm:call:end      (aramayı bitirme)
//   - dm:call:offer / answer / ice  (WebRTC sinyalleme)
//   - dm:send          (mesaj gönderme, E2E, uzunluk limiti)
//   - dm:join          (oda katılımı)

'use strict';
process.env.NODE_ENV = 'test';

const { createMockDb, makeUser } = require('./helpers/mockDb');

let db;

jest.mock('../db/loader', () => {
  const { createMockDb } = require('./helpers/mockDb');
  db = createMockDb();
  return db;
});

// getDmId'ye ihtiyaç var — dm route'ından
jest.mock('../routes/dm', () => ({
  getDmId: (a, b) => [a, b].sort().join('_'),
  router:  require('express').Router(),
}));

const { registerDmHandlers } = require('../socket/handlers/dm');

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
    async _trigger(event, data) {
      if (handlers[event]) await handlers[event](data);
    },
  };
  return socket;
}

// socketUsers Map — io.to(sid) yerine doğrudan soketi bulmak için
function makeIo(socketUsers = new Map()) {
  const emitted = [];
  return {
    _emitted: emitted,
    _socketStore: new Map(), // sid → socket nesnesi
    to(target) {
      return { emit(ev, data) { emitted.push({ ev, data, _target: target }); } };
    },
  };
}

beforeEach(async () => {
  db = createMockDb();
  Object.assign(require('../db/loader'), db);
});

// ════════════════════════════════════════════════════════════════
// dm:call:start
// ════════════════════════════════════════════════════════════════

describe('dm:call:start', () => {
  it('arayan taraf gdm:call:outgoing alır', async () => {
    const caller = makeUser({ displayName: 'Alice' });
    const callee = makeUser({ displayName: 'Bob' });
    await db.users.insert(caller);
    await db.users.insert(callee);

    const callerSocket = makeSocket('s-caller');
    const socketUsers  = new Map([['s-caller', caller], ['s-callee', callee]]);
    const io           = makeIo(socketUsers);

    registerDmHandlers(callerSocket, io, caller, socketUsers);

    await callerSocket._trigger('dm:call:start', { toUserId: callee._id, type: 'voice' });

    const outgoing = callerSocket._emitted.find(e => e.ev === 'dm:call:outgoing');
    expect(outgoing).toBeDefined();
    expect(outgoing.data.toUserId).toBe(callee._id);
    expect(outgoing.data.type).toBe('voice');
    expect(outgoing.data.callId).toBeDefined();
  });

  it('aranan taraf dm:call:incoming alır', async () => {
    const caller = makeUser({ displayName: 'Alice' });
    const callee = makeUser({ displayName: 'Bob' });
    await db.users.insert(caller);
    await db.users.insert(callee);

    const callerSocket = makeSocket('s-caller-2');
    const socketUsers  = new Map([['s-caller-2', caller], ['s-callee-2', callee]]);
    const io           = makeIo(socketUsers);

    registerDmHandlers(callerSocket, io, caller, socketUsers);

    await callerSocket._trigger('dm:call:start', { toUserId: callee._id, type: 'voice' });

    // io.to('s-callee-2').emit('dm:call:incoming', ...) çağrılmış olmalı
    const incoming = io._emitted.find(e => e.ev === 'dm:call:incoming' && e._target === 's-callee-2');
    expect(incoming).toBeDefined();
    expect(incoming.data.callerId).toBe(caller._id);
    expect(incoming.data.callerDisplayName).toBe(caller.displayName);
    expect(incoming.data.type).toBe('voice');
  });

  it('geçersiz type reddedilir', async () => {
    const caller = makeUser();
    const callee = makeUser();
    await db.users.insert(caller);
    await db.users.insert(callee);

    const socket      = makeSocket('s-badtype');
    const socketUsers = new Map([['s-badtype', caller]]);
    const io          = makeIo(socketUsers);

    registerDmHandlers(socket, io, caller, socketUsers);

    await socket._trigger('dm:call:start', { toUserId: callee._id, type: 'screenshare' });

    expect(socket._emitted.find(e => e.ev === 'dm:call:outgoing')).toBeUndefined();
    expect(io._emitted.find(e => e.ev === 'dm:call:incoming')).toBeUndefined();
  });

  it('toUserId eksikse işlem yapılmaz', async () => {
    const caller = makeUser();
    await db.users.insert(caller);

    const socket      = makeSocket('s-noid');
    const socketUsers = new Map([['s-noid', caller]]);
    const io          = makeIo(socketUsers);

    registerDmHandlers(socket, io, caller, socketUsers);

    await socket._trigger('dm:call:start', { type: 'voice' });

    expect(socket._emitted.find(e => e.ev === 'dm:call:outgoing')).toBeUndefined();
  });

  it('video tipi de kabul edilir', async () => {
    const caller = makeUser();
    const callee = makeUser();
    await db.users.insert(caller);
    await db.users.insert(callee);

    const socket      = makeSocket('s-video-start');
    const socketUsers = new Map([['s-video-start', caller], ['s-callee-v', callee]]);
    const io          = makeIo(socketUsers);

    registerDmHandlers(socket, io, caller, socketUsers);

    await socket._trigger('dm:call:start', { toUserId: callee._id, type: 'video' });

    const outgoing = socket._emitted.find(e => e.ev === 'dm:call:outgoing');
    expect(outgoing).toBeDefined();
    expect(outgoing.data.type).toBe('video');
  });
});

// ════════════════════════════════════════════════════════════════
// dm:call:accept
// ════════════════════════════════════════════════════════════════

describe('dm:call:accept', () => {
  async function startCall() {
    const caller = makeUser({ displayName: 'Alice' });
    const callee = makeUser({ displayName: 'Bob' });
    await db.users.insert(caller);
    await db.users.insert(callee);

    const callerSocket = makeSocket('s-accept-caller');
    const calleeSocket = makeSocket('s-accept-callee');
    const socketUsers  = new Map([
      ['s-accept-caller', caller],
      ['s-accept-callee', callee],
    ]);
    const io = makeIo(socketUsers);

    registerDmHandlers(callerSocket, io, caller, socketUsers);
    registerDmHandlers(calleeSocket, io, callee, socketUsers);

    await callerSocket._trigger('dm:call:start', { toUserId: callee._id, type: 'voice' });
    const callId = callerSocket._emitted.find(e => e.ev === 'dm:call:outgoing').data.callId;

    return { caller, callee, callerSocket, calleeSocket, socketUsers, io, callId };
  }

  it('aranan taraf aramayı kabul edince dm:call:accepted arayana gönderilir', async () => {
    const { caller, callee, calleeSocket, io, callId } = await startCall();

    await calleeSocket._trigger('dm:call:accept', { callId });

    const accepted = io._emitted.find(e => e.ev === 'dm:call:accepted' && e._target === 's-accept-caller');
    expect(accepted).toBeDefined();
    expect(accepted.data.callId).toBe(callId);
    expect(accepted.data.calleeDisplayName).toBe(callee.displayName);
  });

  it('her iki tarafa da dm:call:ready gönderilir', async () => {
    const { calleeSocket, io, callId } = await startCall();

    await calleeSocket._trigger('dm:call:accept', { callId });

    const readyToCaller = io._emitted.find(e => e.ev === 'dm:call:ready' && e._target === 's-accept-caller');
    const readyToCallee = calleeSocket._emitted.find(e => e.ev === 'dm:call:ready');

    expect(readyToCaller).toBeDefined();
    expect(readyToCallee).toBeDefined();

    // Roller doğru olmalı
    expect(readyToCaller.data.role).toBe('caller');
    expect(readyToCallee.data.role).toBe('callee');

    // Aynı callId ile
    expect(readyToCaller.data.callId).toBe(callId);
    expect(readyToCallee.data.callId).toBe(callId);
  });

  it('callId yoksa ya da callee değilse işlem yapılmaz', async () => {
    const { callerSocket, io, callId } = await startCall();

    // Caller kendisi kabul etmeye çalışıyor
    await callerSocket._trigger('dm:call:accept', { callId });

    const accepted = io._emitted.find(e => e.ev === 'dm:call:accepted');
    expect(accepted).toBeUndefined();
  });

  it('geçersiz callId reddedilir', async () => {
    const { calleeSocket } = await startCall();

    await calleeSocket._trigger('dm:call:accept', { callId: 'nonexistent-call' });

    const ready = calleeSocket._emitted.find(e => e.ev === 'dm:call:ready');
    expect(ready).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════
// dm:call:decline
// ════════════════════════════════════════════════════════════════

describe('dm:call:decline', () => {
  it('reddetme arayana dm:call:declined gönderir', async () => {
    const caller = makeUser();
    const callee = makeUser();
    await db.users.insert(caller);
    await db.users.insert(callee);

    const callerSocket = makeSocket('s-decline-caller');
    const calleeSocket = makeSocket('s-decline-callee');
    const socketUsers  = new Map([
      ['s-decline-caller', caller],
      ['s-decline-callee', callee],
    ]);
    const io = makeIo(socketUsers);

    registerDmHandlers(callerSocket, io, caller, socketUsers);
    registerDmHandlers(calleeSocket, io, callee, socketUsers);

    await callerSocket._trigger('dm:call:start', { toUserId: callee._id, type: 'voice' });
    const callId = callerSocket._emitted.find(e => e.ev === 'dm:call:outgoing').data.callId;

    await calleeSocket._trigger('dm:call:decline', { callId });

    const declined = io._emitted.find(e => e.ev === 'dm:call:declined' && e._target === 's-decline-caller');
    expect(declined).toBeDefined();
    expect(declined.data.callId).toBe(callId);
  });

  it('geçersiz callId sessizce reddedilir', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-decline-noop');
    const io     = makeIo(new Map([['s-decline-noop', user]]));

    registerDmHandlers(socket, io, user, new Map());

    await expect(socket._trigger('dm:call:decline', { callId: 'ghost' })).resolves.not.toThrow();
    expect(io._emitted.find(e => e.ev === 'dm:call:declined')).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════
// dm:call:end
// ════════════════════════════════════════════════════════════════

describe('dm:call:end', () => {
  async function activeCall() {
    const caller = makeUser();
    const callee = makeUser();
    await db.users.insert(caller);
    await db.users.insert(callee);

    const callerSocket = makeSocket('s-end-caller');
    const calleeSocket = makeSocket('s-end-callee');
    const socketUsers  = new Map([
      ['s-end-caller', caller],
      ['s-end-callee', callee],
    ]);
    const io = makeIo(socketUsers);

    registerDmHandlers(callerSocket, io, caller, socketUsers);
    registerDmHandlers(calleeSocket, io, callee, socketUsers);

    await callerSocket._trigger('dm:call:start', { toUserId: callee._id, type: 'voice' });
    const callId = callerSocket._emitted.find(e => e.ev === 'dm:call:outgoing').data.callId;
    await calleeSocket._trigger('dm:call:accept', { callId });

    return { caller, callee, callerSocket, calleeSocket, io, callId };
  }

  it('caller aramayi bitirince diğer tarafa dm:call:ended gider', async () => {
    const { callerSocket, io, callId } = await activeCall();

    io._emitted.length = 0;
    callerSocket._emitted.length = 0;

    await callerSocket._trigger('dm:call:end', { callId });

    const endedToCallee = io._emitted.find(e => e.ev === 'dm:call:ended' && e._target === 's-end-callee');
    expect(endedToCallee).toBeDefined();
    expect(endedToCallee.data.callId).toBe(callId);
  });

  it('caller kendisi de dm:call:ended alır', async () => {
    const { callerSocket, callId } = await activeCall();
    callerSocket._emitted.length = 0;

    await callerSocket._trigger('dm:call:end', { callId });

    const selfEnded = callerSocket._emitted.find(e => e.ev === 'dm:call:ended');
    expect(selfEnded).toBeDefined();
    expect(selfEnded.data.callId).toBe(callId);
  });

  it('callee de aramayi bitirebilir', async () => {
    const { calleeSocket, io, callId } = await activeCall();

    io._emitted.length = 0;

    await calleeSocket._trigger('dm:call:end', { callId });

    const endedToCaller = io._emitted.find(e => e.ev === 'dm:call:ended' && e._target === 's-end-caller');
    expect(endedToCaller).toBeDefined();
  });

  it('geçersiz callId sessizce reddedilir', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-end-noop');
    const io     = makeIo();

    registerDmHandlers(socket, io, user, new Map());

    await expect(socket._trigger('dm:call:end', { callId: 'ghost' })).resolves.not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════
// WebRTC sinyalleme — offer / answer / ice
// ════════════════════════════════════════════════════════════════

describe('WebRTC sinyalleme', () => {
  async function setup() {
    const user   = makeUser();
    const target = makeUser();
    await db.users.insert(user);
    await db.users.insert(target);

    const socket      = makeSocket('s-rtc-1');
    const targetSid   = 's-rtc-target';
    const socketUsers = new Map([
      ['s-rtc-1', user],
      [targetSid, target],
    ]);
    const io = makeIo(socketUsers);

    registerDmHandlers(socket, io, user, socketUsers);
    return { user, target, socket, io, targetSid };
  }

  it('dm:call:offer hedef kullanıcının soketine iletilir', async () => {
    const { target, socket, io } = await setup();
    const offer = { type: 'offer', sdp: 'v=0...' };

    await socket._trigger('dm:call:offer', { callId: 'call-1', targetUserId: target._id, offer });

    const fwd = io._emitted.find(e => e.ev === 'dm:call:offer' && e._target === 's-rtc-target');
    expect(fwd).toBeDefined();
    expect(fwd.data.offer).toEqual(offer);
    expect(fwd.data.fromSocketId).toBe(socket.id);
    expect(fwd.data.callId).toBe('call-1');
  });

  it('dm:call:answer hedef kullanıcının soketine iletilir', async () => {
    const { target, socket, io } = await setup();
    const answer = { type: 'answer', sdp: 'v=0...' };

    await socket._trigger('dm:call:answer', { callId: 'call-1', targetUserId: target._id, answer });

    const fwd = io._emitted.find(e => e.ev === 'dm:call:answer' && e._target === 's-rtc-target');
    expect(fwd).toBeDefined();
    expect(fwd.data.answer).toEqual(answer);
    expect(fwd.data.fromSocketId).toBe(socket.id);
  });

  it('dm:call:ice hedef kullanıcının soketine iletilir', async () => {
    const { target, socket, io } = await setup();
    const candidate = { candidate: 'candidate:1...', sdpMid: '0', sdpMLineIndex: 0 };

    await socket._trigger('dm:call:ice', { callId: 'call-1', targetUserId: target._id, candidate });

    const fwd = io._emitted.find(e => e.ev === 'dm:call:ice' && e._target === 's-rtc-target');
    expect(fwd).toBeDefined();
    expect(fwd.data.candidate).toEqual(candidate);
  });

  it('hedef kullanıcı bağlı değilse hata fırlatmaz', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-rtc-noone');
    const io     = makeIo();
    registerDmHandlers(socket, io, user, new Map([['s-rtc-noone', user]]));

    await expect(
      socket._trigger('dm:call:offer', { callId: 'c1', targetUserId: 'offline-user', offer: {} })
    ).resolves.not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════
// dm:send
// ════════════════════════════════════════════════════════════════

describe('dm:send', () => {
  async function setupDmPair() {
    const userA = makeUser({ displayName: 'Alice' });
    const userB = makeUser({ displayName: 'Bob' });
    await db.users.insert(userA);
    await db.users.insert(userB);

    const socketA     = makeSocket('s-dm-a');
    const socketUsers = new Map([['s-dm-a', userA], ['s-dm-b', userB]]);
    const io          = makeIo(socketUsers);

    registerDmHandlers(socketA, io, userA, socketUsers);

    return { userA, userB, socketA, socketUsers, io };
  }

  it('mesaj her iki tarafa emit edilir', async () => {
    const { userB, socketA, io } = await setupDmPair();

    await socketA._trigger('dm:send', { toUserId: userB._id, content: 'Selam!' });

    // Gönderene
    const selfMsg = socketA._emitted.find(e => e.ev === 'dm:message');
    expect(selfMsg).toBeDefined();
    expect(selfMsg.data.content).toBe('Selam!');

    // Alıcıya
    const toB = io._emitted.find(e => e.ev === 'dm:message' && e._target === 's-dm-b');
    expect(toB).toBeDefined();
    expect(toB.data.content).toBe('Selam!');
  });

  it('mesaj veritabanına kaydedilir', async () => {
    const { userA, userB, socketA } = await setupDmPair();

    await socketA._trigger('dm:send', { toUserId: userB._id, content: 'DB test' });

    const saved = await db.dmMessages.findOne({ userId: userA._id });
    expect(saved).not.toBeNull();
    expect(saved.content).toBe('DB test');
  });

  it('boş içerik reddedilir', async () => {
    const { userB, socketA, io } = await setupDmPair();

    await socketA._trigger('dm:send', { toUserId: userB._id, content: '   ' });

    expect(socketA._emitted.find(e => e.ev === 'dm:message')).toBeUndefined();
    expect(io._emitted.find(e => e.ev === 'dm:message')).toBeUndefined();
  });

  it('2000 karakteri aşan normal mesaj reddedilir', async () => {
    const { userB, socketA } = await setupDmPair();

    await socketA._trigger('dm:send', { toUserId: userB._id, content: 'a'.repeat(2001) });

    expect(socketA._emitted.find(e => e.ev === 'dm:message')).toBeUndefined();
  });

  it('E2E mesajları 20KB\'a kadar kabul edilir', async () => {
    const { userB, socketA } = await setupDmPair();

    const e2eContent = '🔒e2e:' + 'x'.repeat(10_000);
    await socketA._trigger('dm:send', { toUserId: userB._id, content: e2eContent });

    const msg = socketA._emitted.find(e => e.ev === 'dm:message');
    expect(msg).toBeDefined();
    expect(msg.data.e2e).toBe(true);
  });

  it('E2E mesajı 20KB\'ı aşarsa reddedilir', async () => {
    const { userB, socketA } = await setupDmPair();

    const e2eContent = '🔒e2e:' + 'x'.repeat(20_001);
    await socketA._trigger('dm:send', { toUserId: userB._id, content: e2eContent });

    expect(socketA._emitted.find(e => e.ev === 'dm:message')).toBeUndefined();
  });

  it('var olmayan kullanıcıya mesaj reddedilir', async () => {
    const { socketA } = await setupDmPair();

    await socketA._trigger('dm:send', { toUserId: 'ghost-user', content: 'Test' });

    expect(socketA._emitted.find(e => e.ev === 'dm:message')).toBeUndefined();
  });

  it('DM konuşması yoksa oluşturulur', async () => {
    const { userA, userB, socketA } = await setupDmPair();

    const beforeCount = (await db.dmConversations.find({})).length;
    await socketA._trigger('dm:send', { toUserId: userB._id, content: 'İlk mesaj' });
    const afterCount  = (await db.dmConversations.find({})).length;

    expect(afterCount).toBeGreaterThan(beforeCount);
  });

  it('mevcut DM konuşması güncellenir, yenisi açılmaz', async () => {
    const { userA, userB, socketA } = await setupDmPair();

    await socketA._trigger('dm:send', { toUserId: userB._id, content: 'Birinci' });
    await socketA._trigger('dm:send', { toUserId: userB._id, content: 'İkinci' });

    const convs = await db.dmConversations.find({});
    expect(convs.length).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════
// dm:join
// ════════════════════════════════════════════════════════════════

describe('dm:join', () => {
  it('socket dm odasına katılır', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-dmjoin-1');
    const io     = makeIo();

    registerDmHandlers(socket, io, user, new Map([['s-dmjoin-1', user]]));

    await socket._trigger('dm:join', 'dm-room-abc');

    expect(socket._rooms.has('dm:dm-room-abc')).toBe(true);
  });

  it('yeni DM odasına katılınca eski DM odası terk edilir', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-dmjoin-2');
    const io     = makeIo();

    registerDmHandlers(socket, io, user, new Map([['s-dmjoin-2', user]]));

    await socket._trigger('dm:join', 'dm-room-1');
    expect(socket._rooms.has('dm:dm-room-1')).toBe(true);

    await socket._trigger('dm:join', 'dm-room-2');
    expect(socket._rooms.has('dm:dm-room-2')).toBe(true);
    expect(socket._rooms.has('dm:dm-room-1')).toBe(false);
  });
});
