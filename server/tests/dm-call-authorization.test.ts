// server/tests/dm-call-authorization.test.ts
// FAZ G5 — 1:1 DM ARAMA OLAYLARINDA KATILIMCI DENETİMİ.
//
// ════════════════════════════════════════════════════════════════════════════
// BULUNAN KUSUR
// ════════════════════════════════════════════════════════════════════════════
// Faz C4'te GRUP DM arama olayları (`gdm:call:*`) için "herhangi bir kimliği
// doğrulanmış kullanıcı başkasının aramasını sonlandırabiliyor" kusuru
import type { SocketListener } from './helpers/socketDoubles';
import { EmittedLog, findEmitted, requireEmitted, requireEmittedData } from './helpers/socketDoubles';
// düzeltilmişti. 1:1 DM eşdeğerleri ATLANMIŞTI:
//
//   · `dm:call:end`      — katılımcı denetimi YOK. `callId`yi ele geçiren
//                          herkes başkasının görüşmesini kapatabiliyordu.
//   · `dm:call:decline`  — aynı.
//   · `dm:call:offer`    — HİÇBİR denetim yok: payload'daki `targetUserId`ye
//   · `dm:call:answer`     doğrudan sinyal iletiliyordu. Yani herhangi bir
//   · `dm:call:ice`        kullanıcı, herhangi bir kullanıcıya İSTENMEYEN
//                          WebRTC teklifi/ICE adayı enjekte edebiliyordu —
//                          ortada bir arama olmasa bile.
//
// `dm:call:accept` ZATEN korunuyordu (`call.calleeId !== user._id`), bu da
// eksikliğin bilinçli bir tasarım değil, gözden kaçma olduğunu gösterir.
//
// POZİTİF KONTROL KURALI: her "engellenmeli" iddiasının yanında meşru akışın
// GERÇEKTEN çalıştığını gösteren kontrol vardır.

'use strict';
process.env.NODE_ENV = 'test';

import { createMockDb, makeUser } from './helpers/mockDb';
import type { MockDb } from './helpers/mockDb';

let db: MockDb;

jest.mock('../db/loader', () => {
  const { createMockDb } = require('./helpers/mockDb');
  db = createMockDb();
  return db;
});

jest.mock('../routes/dm', () => ({
  getDmId: (a: string, b: string) => [a, b].sort().join('_'),
  router:  require('express').Router(),
}));

import { registerDmHandlers } from '../socket/handlers/dm';

function makeSocket(id: string) {
  const handlers: Record<string, unknown> = {};
  const emitted: EmittedLog = [];
  const rooms    = new Set([id]);
  return {
    id, rooms,
    on(event: string, fn: SocketListener)  { handlers[event] = fn; },
    emit(ev: string, data: unknown) { emitted.push({ ev, data }); },
    join(room: string)     { rooms.add(room); },
    leave(room: string)    { rooms.delete(room); },
    to(room: string) { return { emit(ev: string, data: unknown) { emitted.push({ ev, data, _room: room }); } }; },
    _handlers: handlers,
    _emitted:  emitted,
    async _trigger(event: string, data: unknown) {
      const fn = handlers[event];
      if (typeof fn === 'function') await (fn as (payload: unknown) => unknown)(data);
    },
  };
}

function makeIo() {
  const emitted: EmittedLog = [];
  return {
    _emitted: emitted,
    to(target: string) { return { emit(ev: string, data: unknown) { emitted.push({ ev, data, _target: target }); } }; },
  };
}

beforeEach(async () => {
  db = createMockDb();
  Object.assign(require('../db/loader'), db);
});

/** Alice → Bob araması kurar ve callId'yi döndürür. */
async function startCall() {
  const alice = makeUser({ displayName: 'Alice' });
  const bob   = makeUser({ displayName: 'Bob' });
  const mallory = makeUser({ displayName: 'Mallory' });   // SALDIRGAN
  await db.users.insert(alice);
  await db.users.insert(bob);
  await db.users.insert(mallory);

  const socketUsers = new Map([
    ['s-alice', alice], ['s-bob', bob], ['s-mallory', mallory],
  ]);
  const io = makeIo();

  const aliceSocket   = makeSocket('s-alice');
  const bobSocket     = makeSocket('s-bob');
  const mallorySocket = makeSocket('s-mallory');

  registerDmHandlers(aliceSocket,   io, alice,   socketUsers);
  registerDmHandlers(bobSocket,     io, bob,     socketUsers);
  registerDmHandlers(mallorySocket, io, mallory, socketUsers);

  await aliceSocket._trigger('dm:call:start', { toUserId: bob._id, type: 'voice' });
  const outgoing = requireEmittedData(aliceSocket._emitted, 'dm:call:outgoing');
  const callId = outgoing.callId;

  return { alice, bob, mallory, aliceSocket, bobSocket, mallorySocket, io, callId };
}

// ════════════════════════════════════════════════════════════════════════════
describe('dm:call:end — katılımcı denetimi', () => {
  it('POZİTİF KONTROL: gerçek katılımcı aramayı sonlandırabilir', async () => {
    const { aliceSocket, io, callId } = await startCall();
    io._emitted.length = 0;

    await aliceSocket._trigger('dm:call:end', { callId });

    // Karşı tarafa 'ended' gitmeli.
    expect(io._emitted.some(e => e.ev === 'dm:call:ended')).toBe(true);
  });

  it('ÜÇÜNCÜ KİŞİ başkasının aramasını SONLANDIRAMAZ', async () => {
    const { mallorySocket, io, callId } = await startCall();
    io._emitted.length = 0;

    await mallorySocket._trigger('dm:call:end', { callId });

    expect(io._emitted.some(e => e.ev === 'dm:call:ended')).toBe(false);
    expect(mallorySocket._emitted.some(e => e.ev === 'dm:call:ended')).toBe(false);
  });

  it('üçüncü kişinin denemesi aramayı BOZMAZ (katılımcı hâlâ bitirebilir)', async () => {
    const { aliceSocket, mallorySocket, io, callId } = await startCall();

    await mallorySocket._trigger('dm:call:end', { callId });
    io._emitted.length = 0;
    await aliceSocket._trigger('dm:call:end', { callId });

    // Saldırgan aramayı silememiş olmalı; meşru sonlandırma hâlâ çalışır.
    expect(io._emitted.some(e => e.ev === 'dm:call:ended')).toBe(true);
  });
});

describe('dm:call:decline — katılımcı denetimi', () => {
  it('POZİTİF KONTROL: aranan taraf reddedebilir', async () => {
    const { bobSocket, io, callId } = await startCall();
    io._emitted.length = 0;

    await bobSocket._trigger('dm:call:decline', { callId });

    expect(io._emitted.some(e => e.ev === 'dm:call:declined')).toBe(true);
  });

  it('ÜÇÜNCÜ KİŞİ başkasının aramasını REDDEDEMEZ', async () => {
    const { mallorySocket, io, callId } = await startCall();
    io._emitted.length = 0;

    await mallorySocket._trigger('dm:call:decline', { callId });

    expect(io._emitted.some(e => e.ev === 'dm:call:declined')).toBe(false);
  });
});

describe('dm:call:offer / answer / ice — sinyal enjeksiyonu', () => {
  it('POZİTİF KONTROL: katılımcı karşı tarafa teklif iletebilir', async () => {
    const { aliceSocket, bob, io, callId } = await startCall();
    io._emitted.length = 0;

    await aliceSocket._trigger('dm:call:offer', {
      callId, targetUserId: bob._id, offer: { sdp: 'v=0' },
    });

    const sent = requireEmitted(io._emitted, 'dm:call:offer');
    expect(sent).toBeDefined();
    // COK ORNEKLI TESLIMAT: hedef artik SOKET KIMLIGI degil `user:<id>`
    // ODASIDIR. Surec-yerel harita yalnizca ayni ornekteki soketleri gorur;
    // iki ornekli olcumde diger ornege bagli kullaniciya olay ULASMIYORDU.
    // Yetkilendirme sinirinin kendisi DEGISMEDI: hedef yine yalnizca
    // gorusmenin KARSI TARAFI olabilir (`signalPeer`).
    expect(sent._target).toBe(`user:${bob._id}`);
  });

  it('ÜÇÜNCÜ KİŞİ istenmeyen TEKLİF enjekte EDEMEZ', async () => {
    const { mallorySocket, bob, io, callId } = await startCall();
    io._emitted.length = 0;

    await mallorySocket._trigger('dm:call:offer', {
      callId, targetUserId: bob._id, offer: { sdp: 'KOTU' },
    });

    expect(io._emitted.some(e => e.ev === 'dm:call:offer')).toBe(false);
  });

  it('katılımcı sinyali ARAMA DIŞINDAKİ birine YÖNLENDİREMEZ', async () => {
    // Hedef, görüşmenin karşı tarafı OLMALIDIR. Aksi hâlde bir katılımcı,
    // aramayı üçüncü bir kişiye sinyal göndermek için kanal olarak kullanabilirdi.
    const { aliceSocket, mallory, io, callId } = await startCall();
    io._emitted.length = 0;

    await aliceSocket._trigger('dm:call:offer', {
      callId, targetUserId: mallory._id, offer: { sdp: 'v=0' },
    });

    expect(io._emitted.some(e => e.ev === 'dm:call:offer')).toBe(false);
  });

  it('ÜÇÜNCÜ KİŞİ ICE adayı enjekte EDEMEZ', async () => {
    const { mallorySocket, bob, io, callId } = await startCall();
    io._emitted.length = 0;

    await mallorySocket._trigger('dm:call:ice', {
      callId, targetUserId: bob._id, candidate: { candidate: 'kotu' },
    });

    expect(io._emitted.some(e => e.ev === 'dm:call:ice')).toBe(false);
  });

  it('ÜÇÜNCÜ KİŞİ answer enjekte EDEMEZ', async () => {
    const { mallorySocket, bob, io, callId } = await startCall();
    io._emitted.length = 0;

    await mallorySocket._trigger('dm:call:answer', {
      callId, targetUserId: bob._id, answer: { sdp: 'kotu' },
    });

    expect(io._emitted.some(e => e.ev === 'dm:call:answer')).toBe(false);
  });

  it('BİLİNMEYEN callId ile sinyal iletilmez', async () => {
    const { aliceSocket, bob, io } = await startCall();
    io._emitted.length = 0;

    await aliceSocket._trigger('dm:call:offer', {
      callId: 'olmayan-call-id', targetUserId: bob._id, offer: { sdp: 'v=0' },
    });

    expect(io._emitted.some(e => e.ev === 'dm:call:offer')).toBe(false);
  });
});
