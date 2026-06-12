// server/tests/webrtc-signaling-validation.test.ts
// Sprint 69 — WebRTC signaling event'leri için validation şema testleri
// Kapsam:
//   - dm:call:offer / dm:call:answer / dm:call:ice   — şu an validation YOK (bug)
//   - gdm:call:offer / gdm:call:answer / gdm:call:ice — şu an validation YOK (bug)
//   - Mevcut durum: handler'lar validateSocketPayload çağırmadan yönlendiriyor
//   - Bu testler regression koruması olarak çalışır; Sprint 75 ile tüm validation eklendi.
//     validation eklenince "guard" testleri yeşile döner.

'use strict';
process.env.NODE_ENV = 'test';

import { createMockDb, makeUser } from './helpers/mockDb';

let db: ReturnType<typeof createMockDb>;

jest.mock('../db/loader', () => {
  const { createMockDb } = require('./helpers/mockDb');
  db = createMockDb();
  return db;
});

jest.mock('../routes/dm', () => ({
  getDmId: (a: string, b: string) => [a, b].sort().join('_'),
  router:  require('express').Router(),
}));

import { registerDmHandlers, registerGroupDmHandlers } from '../socket/handlers/dm';

// ── Yardımcılar ───────────────────────────────────────────────

function makeSocket(id: string) {
  const handlers: Record<string, Function> = {};
  const emitted: Array<{ ev: string; data: unknown; _room?: string }> = [];
  const rooms = new Set([id]);

  const socket = {
    id,
    rooms,
    on(event: string, fn: Function)  { handlers[event] = fn; },
    emit(ev: string, data: unknown)  { emitted.push({ ev, data }); },
    join(room: string)               { rooms.add(room); },
    leave(room: string)              { rooms.delete(room); },
    to(room: string) {
      return { emit(ev: string, data: unknown) { emitted.push({ ev, data, _room: room }); } };
    },
    _handlers: handlers,
    _emitted:  emitted,
    async _trigger(event: string, data: unknown) {
      if (handlers[event]) await handlers[event](data);
    },
  };
  return socket;
}

function makeIo(socketUsers?: Map<string, unknown>) {
  const emitted: Array<{ ev: string; data: unknown; _target?: string }> = [];
  return {
    _emitted: emitted,
    to(target: string) {
      return { emit(ev: string, data: unknown) { emitted.push({ ev, data, _target: target }); } };
    },
  };
}

// ── Signaling payload tipleri ─────────────────────────────────────────────

interface EmittedEvent { ev: string; data: unknown; _target?: string; _room?: string }

interface OfferPayload   { offer: unknown; callId: string; fromSocketId: string }
interface AnswerPayload  { answer: unknown; fromSocketId: string }
interface IcePayload     { candidate: unknown; fromSocketId: string }
interface GdmOfferPayload  { offer: unknown; groupId: string; fromSocketId: string }
interface GdmAnswerPayload { answer: unknown; fromSocketId: string }
interface GdmIcePayload    { candidate: unknown; fromSocketId: string }


// ════════════════════════════════════════════════════════════════
// DM WebRTC signaling — offer / answer / ice
// ════════════════════════════════════════════════════════════════

describe('dm:call WebRTC sinyalleme — happy path', () => {
  let socket: ReturnType<typeof makeSocket>;
  let io: ReturnType<typeof makeIo>;
  let caller: ReturnType<typeof makeUser>;
  let callee: ReturnType<typeof makeUser>;
  let socketUsers: Map<string, ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    db._reset?.();
    caller = makeUser({ displayName: 'Caller' });
    callee = makeUser({ displayName: 'Callee' });
    await db.users.insert(caller);
    await db.users.insert(callee);

    socket      = makeSocket('s-caller');
    io          = makeIo();
    socketUsers = new Map([
      ['s-caller',  caller],
      ['s-callee',  callee],
    ]);
    registerDmHandlers(socket, io, caller, socketUsers);
  });

  it('dm:call:offer — offer geçerli alıcı soketine iletilir', async () => {
    const offer = { type: 'offer', sdp: 'v=0\r\no=- 12345 2 IN IP4 127.0.0.1\r\n' };

    await socket._trigger('dm:call:offer', {
      callId: 'call-abc',
      targetUserId: callee._id,
      offer,
    });

    const fwd = io._emitted.find(e => e.ev === 'dm:call:offer' && (e as EmittedEvent)._target === 's-callee');
    expect(fwd).toBeDefined();
    expect((fwd!.data as OfferPayload).offer).toEqual(offer);
    expect((fwd!.data as OfferPayload).callId).toBe('call-abc');
    expect((fwd!.data as OfferPayload).fromSocketId).toBe('s-caller');
  });

  it('dm:call:answer — answer doğru soket'e yönlendirilir', async () => {
    const answer = { type: 'answer', sdp: 'v=0\r\no=- 99 2 IN IP4 127.0.0.1\r\n' };

    await socket._trigger('dm:call:answer', {
      callId: 'call-abc',
      targetUserId: callee._id,
      answer,
    });

    const fwd = io._emitted.find(e => e.ev === 'dm:call:answer' && (e as EmittedEvent)._target === 's-callee');
    expect(fwd).toBeDefined();
    expect((fwd!.data as AnswerPayload).answer).toEqual(answer);
    expect((fwd!.data as OfferPayload).fromSocketId).toBe('s-caller');
  });

  it('dm:call:ice — ICE candidate doğru soket'e yönlendirilir', async () => {
    const candidate = {
      candidate:     'candidate:0 1 UDP 2122252543 192.168.1.5 54321 typ host',
      sdpMid:        '0',
      sdpMLineIndex: 0,
    };

    await socket._trigger('dm:call:ice', {
      callId: 'call-abc',
      targetUserId: callee._id,
      candidate,
    });

    const fwd = io._emitted.find(e => e.ev === 'dm:call:ice' && (e as EmittedEvent)._target === 's-callee');
    expect(fwd).toBeDefined();
    expect((fwd!.data as IcePayload).candidate).toEqual(candidate);
    expect((fwd!.data as OfferPayload).fromSocketId).toBe('s-caller');
  });

  it('dm:call:offer — fromSocketId her zaman gönderenin ID\'si olur', async () => {
    await socket._trigger('dm:call:offer', {
      callId: 'call-xyz',
      targetUserId: callee._id,
      offer: { type: 'offer', sdp: 'stub' },
    });

    const fwd = io._emitted.find(e => e.ev === 'dm:call:offer');
    expect((fwd!.data as IcePayload).fromSocketId).toBe(socket.id);
    // Gönderenin kendi soket id'si inject edilmeli, payload'dan gelmemeli
    expect((fwd!.data as IcePayload).fromSocketId).not.toBe(callee._id);
  });

  it('dm:call:ice — callee offline ise hata fırlatmaz', async () => {
    // targetUserId socketUsers map'inde yok
    const offlineUser = makeUser();
    await db.users.insert(offlineUser);

    await expect(
      socket._trigger('dm:call:ice', {
        callId:       'call-offline',
        targetUserId: offlineUser._id,
        candidate:    { candidate: 'stub', sdpMid: '0', sdpMLineIndex: 0 },
      })
    ).resolves.not.toThrow();

    // Hiçbir event emit edilmemiş olmalı (hedef socket bulunamadı)
    const iceEvts = io._emitted.filter(e => e.ev === 'dm:call:ice');
    expect(iceEvts).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════
// DM WebRTC — validation EKSİKLİĞİ belgeleme testleri
// Handler'lar şu an payload doğrulaması yapmıyor.
// Bu testler mevcut davranışı belgeler; validation eklenince güncellenecek.
// ════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════
// DM WebRTC — validation testleri (Sprint 75: tüm handler'lara validation eklendi)
// ════════════════════════════════════════════════════════════════

describe('dm:call WebRTC sinyalleme — validation (Sprint 75 ile düzeltildi)', () => {
  let socket: ReturnType<typeof makeSocket>;
  let io: ReturnType<typeof makeIo>;
  let caller: ReturnType<typeof makeUser>;
  let callee: ReturnType<typeof makeUser>;

  beforeEach(async () => {
    db._reset?.();
    caller = makeUser({ displayName: 'Caller' });
    callee = makeUser({ displayName: 'Callee' });
    await db.users.insert(caller);
    await db.users.insert(callee);

    socket = makeSocket('s-caller2');
    io     = makeIo();
    registerDmHandlers(
      socket, io, caller,
      new Map([['s-caller2', caller], ['s-callee2', callee]])
    );
  });

  it('dm:call:offer — callId eksikse iletilmez (validation blokladı)', async () => {
    await socket._trigger('dm:call:offer', {
      // callId eksik — validation fail etmeli
      targetUserId: callee._id,
      offer: { type: 'offer', sdp: 'stub' },
    });

    const fwd = io._emitted.find(e => e.ev === 'dm:call:offer');
    expect(fwd).toBeUndefined(); // Sprint 75: validation ile bloklandı
  });

  it('dm:call:ice — targetUserId eksikse iletilmez (validation blokladı)', async () => {
    await socket._trigger('dm:call:ice', {
      callId: 'call-bad',
      // targetUserId eksik — validation fail etmeli
    });

    const fwd = io._emitted.find(e => e.ev === 'dm:call:ice');
    expect(fwd).toBeUndefined(); // Sprint 75: validation ile bloklandı
  });

  it('dm:call:offer — offer nesnesi eksikse hata fırlatmıyor (null safety korundu)', async () => {
    // callId + targetUserId var ama offer yok — validation geçer, handler offer'ı undefined iletir
    await expect(
      socket._trigger('dm:call:offer', {
        callId: 'call-null',
        targetUserId: callee._id,
        // offer eksik — validation bu alanı zorunlu tutmuyor; handler güvenli
      })
    ).resolves.not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════
// GDM WebRTC signaling — offer / answer / ice
// ════════════════════════════════════════════════════════════════

describe('gdm:call WebRTC sinyalleme — happy path', () => {
  let socket: ReturnType<typeof makeSocket>;
  let io: ReturnType<typeof makeIo>;
  let user: ReturnType<typeof makeUser>;

  beforeEach(async () => {
    db._reset?.();
    user   = makeUser({ displayName: 'Alice' });
    await db.users.insert(user);
    socket = makeSocket('s-gdm-caller');
    io     = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map([['s-gdm-caller', user]]));
  });

  it('gdm:call:offer — targetSocketId\'ye offer iletilir', async () => {
    const offer = { type: 'offer', sdp: 'v=0\r\nstub' };

    await socket._trigger('gdm:call:offer', {
      groupId:        'grp-1',
      targetSocketId: 's-gdm-peer',
      offer,
    });

    const fwd = io._emitted.find(
      e => e.ev === 'gdm:call:offer' && (e as EmittedEvent)._target === 's-gdm-peer'
    );
    expect(fwd).toBeDefined();
    expect((fwd!.data as OfferPayload).offer).toEqual(offer);
    expect((fwd!.data as GdmOfferPayload).groupId).toBe('grp-1');
    expect((fwd!.data as IcePayload).fromSocketId).toBe('s-gdm-caller');
  });

  it('gdm:call:answer — targetSocketId\'ye answer iletilir', async () => {
    const answer = { type: 'answer', sdp: 'v=0\r\nstub' };

    await socket._trigger('gdm:call:answer', {
      groupId:        'grp-1',
      targetSocketId: 's-gdm-callee',
      answer,
    });

    const fwd = io._emitted.find(
      e => e.ev === 'gdm:call:answer' && (e as EmittedEvent)._target === 's-gdm-callee'
    );
    expect(fwd).toBeDefined();
    expect((fwd!.data as AnswerPayload).answer).toEqual(answer);
    expect((fwd!.data as IcePayload).fromSocketId).toBe('s-gdm-caller');
  });

  it('gdm:call:ice — ICE candidate peer\'e iletilir', async () => {
    const candidate = {
      candidate:     'candidate:1 1 UDP 2122252543 10.0.0.1 56789 typ host',
      sdpMid:        '1',
      sdpMLineIndex: 1,
    };

    await socket._trigger('gdm:call:ice', {
      groupId:        'grp-1',
      targetSocketId: 's-gdm-peer',
      candidate,
    });

    const fwd = io._emitted.find(
      e => e.ev === 'gdm:call:ice' && (e as EmittedEvent)._target === 's-gdm-peer'
    );
    expect(fwd).toBeDefined();
    expect((fwd!.data as IcePayload).candidate).toEqual(candidate);
    expect((fwd!.data as IcePayload).fromSocketId).toBe('s-gdm-caller');
  });

  it('gdm:call:offer — fromSocketId gönderenin gerçek socket id\'si', async () => {
    await socket._trigger('gdm:call:offer', {
      groupId:        'grp-2',
      targetSocketId: 's-other',
      offer: { type: 'offer', sdp: 'stub' },
    });

    const fwd = io._emitted.find(e => e.ev === 'gdm:call:offer');
    expect((fwd!.data as IcePayload).fromSocketId).toBe(socket.id);
  });

  it('gdm:call:ice — aynı anda birden fazla ICE candidate gönderilebilir', async () => {
    const candidates = [
      { candidate: 'candidate:0 1 UDP 1 192.168.1.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 },
      { candidate: 'candidate:1 1 TCP 1 192.168.1.1 5001 typ host', sdpMid: '0', sdpMLineIndex: 0 },
      { candidate: 'candidate:2 1 UDP 1 8.8.8.8 5002 typ srflx',    sdpMid: '0', sdpMLineIndex: 0 },
    ];

    for (const candidate of candidates) {
      await socket._trigger('gdm:call:ice', {
        groupId: 'grp-multi', targetSocketId: 's-peer-multi', candidate,
      });
    }

    const iceEvts = io._emitted.filter(e => e.ev === 'gdm:call:ice' && (e as EmittedEvent)._target === 's-peer-multi');
    expect(iceEvts).toHaveLength(3);
  });
});

// ════════════════════════════════════════════════════════════════
// GDM WebRTC — validation EKSİKLİĞİ belgeleme testleri
// ════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════
// GDM WebRTC — validation testleri (Sprint 75: validation eklendi)
// ════════════════════════════════════════════════════════════════

describe('gdm:call WebRTC sinyalleme — validation (Sprint 75 ile düzeltildi)', () => {
  let socket: ReturnType<typeof makeSocket>;
  let io: ReturnType<typeof makeIo>;
  let user: ReturnType<typeof makeUser>;

  beforeEach(async () => {
    db._reset?.();
    user   = makeUser();
    await db.users.insert(user);
    socket = makeSocket('s-gdm-val');
    io     = makeIo();
    registerGroupDmHandlers(socket, io, user, new Map([['s-gdm-val', user]]));
  });

  it('gdm:call:offer — groupId eksikse iletilmez (validation blokladı)', async () => {
    await socket._trigger('gdm:call:offer', {
      // groupId eksik — validation fail etmeli
      targetSocketId: 's-someone',
      offer: { type: 'offer', sdp: 'stub' },
    });

    const fwd = io._emitted.find(e => e.ev === 'gdm:call:offer');
    expect(fwd).toBeUndefined(); // Sprint 75: validation ile bloklandı
  });

  it('gdm:call:answer — targetSocketId null ise iletilmez (validation blokladı)', async () => {
    await socket._trigger('gdm:call:answer', {
      groupId:        'grp-bad',
      targetSocketId: null, // geçersiz — string required
      answer:         { type: 'answer', sdp: 'stub' },
    });

    const fwd = io._emitted.find(e => e.ev === 'gdm:call:answer');
    expect(fwd).toBeUndefined(); // Sprint 75: validation ile bloklandı
  });

  it('gdm:call:ice — tüm alanlar eksikse hata fırlatmıyor ve iletilmiyor', async () => {
    await expect(
      socket._trigger('gdm:call:ice', {})
    ).resolves.not.toThrow();

    const fwd = io._emitted.find(e => e.ev === 'gdm:call:ice');
    expect(fwd).toBeUndefined(); // validation drop etti
  });
});

// ════════════════════════════════════════════════════════════════
// Önerilen validation şemaları (kod olarak belgeleme)
// validate.ts'e eklenecek socketSchemas:
//
//   dmCallSignal: {
//     callId:       { type: 'string', required: true, min: 1, max: 64 },
//     targetUserId: { type: 'string', required: true, min: 1, max: 64 },
//   }
//
//   gdmCallSignal: {
//     groupId:        { type: 'string', required: true, min: 1, max: 64 },
//     targetSocketId: { type: 'string', required: true, min: 1, max: 64 },
//   }
//
// dm.ts handler'larında:
//   socket.on('dm:call:offer', (payload) => {
//     if (!validateSocketPayload(payload, socketSchemas.dmCallSignal).valid) return;
//     ...
//   });
// ════════════════════════════════════════════════════════════════

describe('Önerilen şema formatı — compile-time check', () => {
  it('validateSocketPayload string tipi kabul eder', () => {
    // validate.ts'in mevcut API'si test ediliyor (import olmadan, sadece kontrol)
    const { validateSocketPayload } = require('../middleware/validate');

    const schema = {
      callId:       { type: 'string' as const, required: true, min: 1, max: 64 },
      targetUserId: { type: 'string' as const, required: true, min: 1, max: 64 },
    };

    const good = validateSocketPayload({ callId: 'c-1', targetUserId: 'u-1' }, schema);
    expect(good.valid).toBe(true);

    const bad = validateSocketPayload({ callId: '', targetUserId: 'u-1' }, schema);
    expect(bad.valid).toBe(false);
    expect(bad.errors.length).toBeGreaterThan(0);
  });

  it('gdmCallSignal şema formatı doğru çalışır', () => {
    const { validateSocketPayload } = require('../middleware/validate');

    const schema = {
      groupId:        { type: 'string' as const, required: true, min: 1, max: 64 },
      targetSocketId: { type: 'string' as const, required: true, min: 1, max: 64 },
    };

    const good = validateSocketPayload({ groupId: 'grp-1', targetSocketId: 'sock-1' }, schema);
    expect(good.valid).toBe(true);

    const missingGroup = validateSocketPayload({ targetSocketId: 'sock-1' }, schema);
    expect(missingGroup.valid).toBe(false);
  });
});
