// server/tests/dm-socket.test.ts
// registerDmHandlers socket entegrasyon testleri
// Test kapsamı:
//   - dm:call:start    (arama başlatma, ring, auto-cancel)
//   - dm:call:accept   (aramayı kabul etme, ready sinyali)
//   - dm:call:decline  (aramayı reddetme)
//   - dm:call:end      (aramayı bitirme)
//   - dm:call:offer / answer / ice  (WebRTC sinyalleme)
import { EmittedLog, SocketDouble, dataOf, findEmitted, requireEmitted, requireEmittedData } from './helpers/socketDoubles';
//   - dm:send          (mesaj gönderme, E2E, uzunluk limiti)
//   - dm:join          (oda katılımı)

'use strict';
process.env.NODE_ENV = 'test';

import { createMockDb, makeUser, requireDoc } from './helpers/mockDb';
import type { MockDb } from './helpers/mockDb';

let db: MockDb;

jest.mock('../db/loader', () => {
  const { createMockDb } = require('./helpers/mockDb');
  db = createMockDb();
  return db;
});

// getDmId'ye ihtiyaç var — dm route'ından
jest.mock('../routes/dm', () => ({
  getDmId: (a: string, b: string) => [a, b].sort().join('_'),
  router:  require('express').Router(),
}));

import { registerDmHandlers } from '../socket/handlers/dm';
// Canonical deterministic DM id owner — the assertion below referenced `Dms`
// without ever importing it, so the test threw ReferenceError instead of
// checking that a nonce-rejected send creates no conversation row.
import DmRepository from '../db/repositories/DmRepository';

// ── Yardımcılar ────────────────────────────────────────────────

function makeSocket(id: string) {
  const handlers: Record<string, unknown> = {};
  const emitted: EmittedLog = [];
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
    async _trigger(event: string, data: unknown) {
      const fn = handlers[event];
      if (typeof fn === 'function') await (fn as (payload?: unknown) => unknown)(data);
    },
  } satisfies SocketDouble;
  return socket;
}

// socketUsers Map — io.to(sid) yerine doğrudan soketi bulmak için
function makeIo(socketUsers = new Map()) {
  const emitted: EmittedLog = [];
  return {
    _emitted: emitted,
    _socketStore: new Map(), // sid → socket nesnesi
    to(target: string) {
      return { emit(ev: string, data: unknown) { emitted.push({ ev, data, _target: target }); } };
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

    const outgoing = requireEmittedData(callerSocket._emitted, 'dm:call:outgoing');
    expect(outgoing).toBeDefined();
    expect(outgoing.toUserId).toBe(callee._id);
    expect(outgoing.type).toBe('voice');
    expect(outgoing.callId).toBeDefined();
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
    const incoming = requireEmittedData(io._emitted, 'dm:call:incoming', { target: `user:${callee._id}` });
    expect(incoming).toBeDefined();
    expect(incoming.callerId).toBe(caller._id);
    expect(incoming.callerDisplayName).toBe(caller.displayName);
    expect(incoming.type).toBe('voice');
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

    expect(findEmitted(socket._emitted, 'dm:call:outgoing')).toBeUndefined();
    expect(findEmitted(io._emitted, 'dm:call:incoming')).toBeUndefined();
  });

  it('toUserId eksikse işlem yapılmaz', async () => {
    const caller = makeUser();
    await db.users.insert(caller);

    const socket      = makeSocket('s-noid');
    const socketUsers = new Map([['s-noid', caller]]);
    const io          = makeIo(socketUsers);

    registerDmHandlers(socket, io, caller, socketUsers);

    await socket._trigger('dm:call:start', { type: 'voice' });

    expect(findEmitted(socket._emitted, 'dm:call:outgoing')).toBeUndefined();
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

    const outgoing = requireEmittedData(socket._emitted, 'dm:call:outgoing');
    expect(outgoing).toBeDefined();
    expect(outgoing.type).toBe('video');
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
    const callId = requireEmittedData(callerSocket._emitted, 'dm:call:outgoing').callId;

    return { caller, callee, callerSocket, calleeSocket, socketUsers, io, callId };
  }

  it('aranan taraf aramayı kabul edince dm:call:accepted arayana gönderilir', async () => {
    const { caller, callee, calleeSocket, io, callId } = await startCall();

    await calleeSocket._trigger('dm:call:accept', { callId });

    const accepted = requireEmittedData(io._emitted, 'dm:call:accepted', { target: `user:${caller._id}` });
    expect(accepted).toBeDefined();
    expect(accepted.callId).toBe(callId);
    expect(accepted.calleeDisplayName).toBe(callee.displayName);
  });

  it('her iki tarafa da dm:call:ready gönderilir', async () => {
    const { caller, calleeSocket, io, callId } = await startCall();

    await calleeSocket._trigger('dm:call:accept', { callId });

    const readyToCaller = requireEmittedData(io._emitted, 'dm:call:ready', { target: `user:${caller._id}` });
    const readyToCallee = requireEmittedData(calleeSocket._emitted, 'dm:call:ready');

    expect(readyToCaller).toBeDefined();
    expect(readyToCallee).toBeDefined();

    // Roller doğru olmalı
    expect(readyToCaller.role).toBe('caller');
    expect(readyToCallee.role).toBe('callee');

    // Aynı callId ile
    expect(readyToCaller.callId).toBe(callId);
    expect(readyToCallee.callId).toBe(callId);
  });

  it('callId yoksa ya da callee değilse işlem yapılmaz', async () => {
    const { callerSocket, io, callId } = await startCall();

    // Caller kendisi kabul etmeye çalışıyor
    await callerSocket._trigger('dm:call:accept', { callId });

    const accepted = findEmitted(io._emitted, 'dm:call:accepted');
    expect(accepted).toBeUndefined();
  });

  it('geçersiz callId reddedilir', async () => {
    const { calleeSocket } = await startCall();

    await calleeSocket._trigger('dm:call:accept', { callId: 'nonexistent-call' });

    const ready = findEmitted(calleeSocket._emitted, 'dm:call:ready');
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
    const callId = requireEmittedData(callerSocket._emitted, 'dm:call:outgoing').callId;

    await calleeSocket._trigger('dm:call:decline', { callId });

    const declined = requireEmittedData(io._emitted, 'dm:call:declined', { target: `user:${caller._id}` });
    expect(declined).toBeDefined();
    expect(declined.callId).toBe(callId);
  });

  it('geçersiz callId sessizce reddedilir', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-decline-noop');
    const io     = makeIo(new Map([['s-decline-noop', user]]));

    registerDmHandlers(socket, io, user, new Map());

    await expect(socket._trigger('dm:call:decline', { callId: 'ghost' })).resolves.not.toThrow();
    expect(findEmitted(io._emitted, 'dm:call:declined')).toBeUndefined();
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
    const callId = requireEmittedData(callerSocket._emitted, 'dm:call:outgoing').callId;
    await calleeSocket._trigger('dm:call:accept', { callId });

    return { caller, callee, callerSocket, calleeSocket, io, callId };
  }

  it('caller aramayi bitirince diğer tarafa dm:call:ended gider', async () => {
    const { callee, callerSocket, io, callId } = await activeCall();

    io._emitted.length = 0;
    callerSocket._emitted.length = 0;

    await callerSocket._trigger('dm:call:end', { callId });

    const endedToCallee = requireEmittedData(io._emitted, 'dm:call:ended', { target: `user:${callee._id}` });
    expect(endedToCallee).toBeDefined();
    expect(endedToCallee.callId).toBe(callId);
  });

  it('caller kendisi de dm:call:ended alır', async () => {
    const { callerSocket, callId } = await activeCall();
    callerSocket._emitted.length = 0;

    await callerSocket._trigger('dm:call:end', { callId });

    const selfEnded = requireEmittedData(callerSocket._emitted, 'dm:call:ended');
    expect(selfEnded).toBeDefined();
    expect(selfEnded.callId).toBe(callId);
  });

  it('callee de aramayi bitirebilir', async () => {
    const { caller, calleeSocket, io, callId } = await activeCall();

    io._emitted.length = 0;

    await calleeSocket._trigger('dm:call:end', { callId });

    const endedToCaller = requireEmitted(io._emitted, 'dm:call:ended', { target: `user:${caller._id}` });
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

    // FAZ G — GERCEK bir arama kurulur ve GERCEK callId kullanilir.
    //
    // Bu testler eskiden uydurma bir `callId: 'call-1'` ile sinyal
    // gonderiyordu ve GECIYORDU. Gecmesinin nedeni tam olarak guvenlik
    // kusuruydu: `dm:call:offer/answer/ice` hicbir arama baglamini
    // dogrulamiyor, payload'daki `targetUserId`ye korumasizca iletiyordu.
    // Yani bu testler kusurlu davranisi "beklenen" diye kayit altina
    // almisti. Artik once gercek bir arama baslatilir; boylece MESRU
    // sinyal yolu olculur, savunmasiz yol degil.
    await socket._trigger('dm:call:start', { toUserId: target._id, type: 'voice' });
    const outgoing = requireEmittedData(socket._emitted, 'dm:call:outgoing');
    const callId = outgoing.callId;
    io._emitted.length = 0;

    return { user, target, socket, io, targetSid, callId };
  }

  it('dm:call:offer hedef kullanıcının soketine iletilir', async () => {
    const { target, socket, io, callId } = await setup();
    const offer = { type: 'offer', sdp: 'v=0...' };

    await socket._trigger('dm:call:offer', { callId, targetUserId: target._id, offer });

    const fwd = requireEmittedData(io._emitted, 'dm:call:offer', { target: `user:${target._id}` });
    expect(fwd).toBeDefined();
    expect(fwd.offer).toEqual(offer);
    expect(fwd.fromSocketId).toBe(socket.id);
    expect(fwd.callId).toBe(callId);
  });

  it('dm:call:answer hedef kullanıcının soketine iletilir', async () => {
    const { target, socket, io, callId } = await setup();
    const answer = { type: 'answer', sdp: 'v=0...' };

    await socket._trigger('dm:call:answer', { callId, targetUserId: target._id, answer });

    const fwd = requireEmittedData(io._emitted, 'dm:call:answer', { target: `user:${target._id}` });
    expect(fwd).toBeDefined();
    expect(fwd.answer).toEqual(answer);
    expect(fwd.fromSocketId).toBe(socket.id);
  });

  it('dm:call:ice hedef kullanıcının soketine iletilir', async () => {
    const { target, socket, io, callId } = await setup();
    const candidate = { candidate: 'candidate:1...', sdpMid: '0', sdpMLineIndex: 0 };

    await socket._trigger('dm:call:ice', { callId, targetUserId: target._id, candidate });

    const fwd = requireEmittedData(io._emitted, 'dm:call:ice', { target: `user:${target._id}` });
    expect(fwd).toBeDefined();
    expect(fwd.candidate).toEqual(candidate);
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
    const selfMsg = requireEmittedData(socketA._emitted, 'dm:message');
    expect(selfMsg).toBeDefined();
    expect(selfMsg.content).toBe('Selam!');

    // Alıcıya
    const toB = requireEmittedData(io._emitted, 'dm:message', { target: `user:${userB._id}` });
    expect(toB).toBeDefined();
    expect(toB.content).toBe('Selam!');
  });

  it('mesaj veritabanına kaydedilir', async () => {
    const { userA, userB, socketA } = await setupDmPair();

    await socketA._trigger('dm:send', { toUserId: userB._id, content: 'DB test' });

    const saved = await requireDoc(db.dmMessages, { userId: userA._id });
    expect(saved.content).toBe('DB test');
  });

  it('boş içerik reddedilir', async () => {
    const { userB, socketA, io } = await setupDmPair();

    await socketA._trigger('dm:send', { toUserId: userB._id, content: '   ' });

    expect(findEmitted(socketA._emitted, 'dm:message')).toBeUndefined();
    expect(findEmitted(io._emitted, 'dm:message')).toBeUndefined();
  });

  it('2000 karakteri aşan normal mesaj reddedilir', async () => {
    const { userB, socketA } = await setupDmPair();

    await socketA._trigger('dm:send', { toUserId: userB._id, content: 'a'.repeat(2001) });

    expect(findEmitted(socketA._emitted, 'dm:message')).toBeUndefined();
  });

  it('E2E mesajları 20KB\'a kadar kabul edilir', async () => {
    const { userB, socketA } = await setupDmPair();

    const e2eContent = '🔒e2e:' + 'x'.repeat(10_000);
    await socketA._trigger('dm:send', { toUserId: userB._id, content: e2eContent });

    const msg = requireEmittedData(socketA._emitted, 'dm:message');
    expect(msg).toBeDefined();
    expect(msg.e2e).toBe(true);
  });

  it('E2E mesajı 20KB\'ı aşarsa reddedilir', async () => {
    const { userB, socketA } = await setupDmPair();

    const e2eContent = '🔒e2e:' + 'x'.repeat(20_001);
    await socketA._trigger('dm:send', { toUserId: userB._id, content: e2eContent });

    expect(findEmitted(socketA._emitted, 'dm:message')).toBeUndefined();
  });

  it('var olmayan kullanıcıya mesaj reddedilir', async () => {
    const { socketA } = await setupDmPair();

    await socketA._trigger('dm:send', { toUserId: 'ghost-user', content: 'Test' });

    expect(findEmitted(socketA._emitted, 'dm:message')).toBeUndefined();
  });

  it('aynı clientNonce retry tek DB mesajı üretir ve yalnız gönderene nonce döner', async () => {
    const { userA, userB, socketA, io } = await setupDmPair();
    const clientNonce = 'dm-nonce-retry-001';

    await socketA._trigger('dm:send', { toUserId: userB._id, content: 'Tek kez kaydet', clientNonce });
    await socketA._trigger('dm:send', { toUserId: userB._id, content: 'Tek kez kaydet', clientNonce });

    const saved = await db.dmMessages.find({ userId: userA._id, clientNonce });
    expect(saved).toHaveLength(1);

    const senderEchoes = socketA._emitted.filter(e => e.ev === 'dm:message' && dataOf(e).clientNonce === clientNonce);
    expect(senderEchoes).toHaveLength(2);
    expect(dataOf(senderEchoes[0])._id).toBe(dataOf(senderEchoes[1])._id);

    const peerMessages = io._emitted.filter(e => e.ev === 'dm:message' && e._target === `user:${userB._id}`);
    expect(peerMessages).toHaveLength(1);
    expect(dataOf(peerMessages[0]).clientNonce).toBeUndefined();
  });

  it('aynı clientNonce başka DM için yeniden kullanılamaz', async () => {
    const { userA, userB, socketA, socketUsers, io } = await setupDmPair();
    const userC = makeUser({ displayName: 'Carol' });
    await db.users.insert(userC);
    socketUsers.set('s-dm-c', userC);
    const clientNonce = 'dm-nonce-conflict-001';

    await socketA._trigger('dm:send', { toUserId: userB._id, content: 'B mesajı', clientNonce });
    await socketA._trigger('dm:send', { toUserId: userC._id, content: 'C mesajı', clientNonce });

    const errors = socketA._emitted.filter(e => e.ev === 'error:message' && dataOf(e).clientNonce === clientNonce);
    expect(errors).toHaveLength(1);
    expect(dataOf(errors[0]).code).toBe('NONCE_CONFLICT');
    expect(findEmitted(io._emitted, 'dm:message', { target: `user:${userC._id}` })).toBeUndefined();
    expect(await db.dmMessages.find({ userId: userA._id, clientNonce })).toHaveLength(1);
    const rejectedConversationId = DmRepository.buildDmId(userA._id, userC._id);
    expect(await db.dmConversations.findOne({ _id: rejectedConversationId })).toBeNull();
  });

  it('reddedilen gönderim clientNonce ile tam bir kez hata üretir', async () => {
    const { userB, socketA } = await setupDmPair();
    const clientNonce = 'dm-nonce-error-001';

    await socketA._trigger('dm:send', { toUserId: userB._id, content: '   ', clientNonce });

    const errors = socketA._emitted.filter(e => e.ev === 'error:message' && dataOf(e).clientNonce === clientNonce);
    expect(errors).toHaveLength(1);
    expect(errors[0].data).toEqual(expect.objectContaining({ event: 'dm:send', code: 'EMPTY_MESSAGE', clientNonce }));
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

    await db.dmConversations.insert({ _id: 'dm-room-abc', participants: [user._id, 'other-user'] });

    registerDmHandlers(socket, io, user, new Map([['s-dmjoin-1', user]]));

    await socket._trigger('dm:join', 'dm-room-abc');

    expect(socket._rooms.has('dm:dm-room-abc')).toBe(true);
  });

  it('yeni DM odasına katılınca eski DM odası terk edilir', async () => {
    const user   = makeUser();
    const socket = makeSocket('s-dmjoin-2');
    const io     = makeIo();

    await db.dmConversations.insert({ _id: 'dm-room-1', participants: [user._id, 'other-user'] });
    await db.dmConversations.insert({ _id: 'dm-room-2', participants: [user._id, 'other-user'] });

    registerDmHandlers(socket, io, user, new Map([['s-dmjoin-2', user]]));

    await socket._trigger('dm:join', 'dm-room-1');
    expect(socket._rooms.has('dm:dm-room-1')).toBe(true);

    await socket._trigger('dm:join', 'dm-room-2');
    expect(socket._rooms.has('dm:dm-room-2')).toBe(true);
    expect(socket._rooms.has('dm:dm-room-1')).toBe(false);
  });
});
