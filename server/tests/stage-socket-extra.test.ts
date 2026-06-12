// server/tests/stage-socket-extra.test.ts
// stage.ts handler — stage-socket.test.js'de eksik kalan üç event:
//   - stage:speaking  (VAD tabanlı konuşma indikatörü)
//   - stage:setTopic  (host konu güncelleme, yetki kontrolü)
//   - stage:setLive   (host CANLI badge toggle)

'use strict';
process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => {
  const { createMockDb } = require('./helpers/mockDb');
  return createMockDb();
});

import { registerStageHandlers, stageRooms } from '../socket/handlers/stage';

// ── Yardımcılar ─────────────────────────────────────────────────

function makeUser(overrides = {}) {
  return {
    _id:         `u-${Math.random().toString(36).slice(2)}`,
    displayName: 'StageUser',
    avatarColor: '#abc',
    ...overrides,
  };
}

function makeSocket(id) {
  const handlers: Record<string, unknown> = {};
  const emitted  = [];
  const rooms    = new Set();

  return {
    id,
    rooms,                         // disconnect handler socket.rooms üzerinden iterate eder
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

/** Bir kullanıcıyı verilen rolle odaya ekler */
async function addToStage(io, channelId, role, userOverrides = {}) {
  const user   = makeUser(userOverrides);
  const socket = makeSocket(`sock-${Math.random().toString(36).slice(2)}`);
  registerStageHandlers(socket, io, user);
  await socket._trigger('stage:join',    { channelId });
  await socket._trigger('stage:setRole', { channelId, role, displayName: user.displayName, avatarColor: user.avatarColor });
  if (role === 'speaker') {
    await socket._trigger('stage:updateMute', { channelId, muted: false });
  }
  return { user, socket };
}

function clearRooms() { stageRooms.clear(); }
beforeEach(() => clearRooms());
afterEach(()  => clearRooms());

// ════════════════════════════════════════════════════════════════
// stage:speaking
// ════════════════════════════════════════════════════════════════

describe('stage:speaking', () => {
  it('speaker konuşmaya başlarsa speaking:true yayınlanır', async () => {
    const io = makeIo();
    const { socket, user } = await addToStage(io, 'ch-sp', 'speaker');
    io._emitted.length = 0; // setup gürültüsünü temizle

    await socket._trigger('stage:speaking', { channelId: 'ch-sp', speaking: true });

    const ev = io._emitted.find(e => e.ev === 'stage:speaking');
    expect(ev).toBeDefined();
    expect(ev.data.userId).toBe(user._id);
    expect(ev.data.speaking).toBe(true);
    expect(ev._target).toBe('stage:ch-sp');
  });

  it('speaker konuşmayı bitirirse speaking:false yayınlanır', async () => {
    const io = makeIo();
    const { socket, user } = await addToStage(io, 'ch-sp2', 'speaker');
    await socket._trigger('stage:speaking', { channelId: 'ch-sp2', speaking: true });
    io._emitted.length = 0;

    await socket._trigger('stage:speaking', { channelId: 'ch-sp2', speaking: false });

    const ev = io._emitted.find(e => e.ev === 'stage:speaking');
    expect(ev).toBeDefined();
    expect(ev.data.speaking).toBe(false);
  });

  it('mute durumdaki speaker speaking:true gönderemez', async () => {
    const io = makeIo();
    const { socket } = await addToStage(io, 'ch-sp3', 'speaker');
    // Sessize al
    await socket._trigger('stage:updateMute', { channelId: 'ch-sp3', muted: true });
    io._emitted.length = 0;

    await socket._trigger('stage:speaking', { channelId: 'ch-sp3', speaking: true });

    // Mute olduğunda speaking emit edilmemeli
    const ev = io._emitted.find(e => e.ev === 'stage:speaking');
    expect(ev).toBeUndefined();
  });

  it('listener stage:speaking tetiklerse yayın yapılmaz', async () => {
    const io = makeIo();
    const { socket } = await addToStage(io, 'ch-sp4', 'listener');
    io._emitted.length = 0;

    await socket._trigger('stage:speaking', { channelId: 'ch-sp4', speaking: true });

    // Listener speakers listesinde değil → emit olmamalı
    const ev = io._emitted.find(e => e.ev === 'stage:speaking');
    expect(ev).toBeUndefined();
  });

  it('channelId yoksa hata fırlatmaz', async () => {
    const io   = makeIo();
    const user = makeUser();
    const sock = makeSocket('sock-sp-safe');
    registerStageHandlers(sock, io, user);
    await expect(sock._trigger('stage:speaking', { speaking: true })).resolves.not.toThrow();
  });

  it('mevcut olmayan kanalda speaking hata fırlatmaz', async () => {
    const io   = makeIo();
    const user = makeUser();
    const sock = makeSocket('sock-sp-noop');
    registerStageHandlers(sock, io, user);
    await expect(
      sock._trigger('stage:speaking', { channelId: 'no-such-channel', speaking: true })
    ).resolves.not.toThrow();
  });

  it('speaking state odadaki Room nesnesine yansır', async () => {
    const io = makeIo();
    const { socket, user } = await addToStage(io, 'ch-sp5', 'speaker');

    await socket._trigger('stage:speaking', { channelId: 'ch-sp5', speaking: true });

    const room = stageRooms.get('ch-sp5');
    const sp   = room.speakers.find(u => u.userId === user._id);
    expect(sp.speaking).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
// stage:setTopic
// ════════════════════════════════════════════════════════════════

describe('stage:setTopic', () => {
  it('host konu güncelleyebilir ve stage:topicUpdate yayınlanır', async () => {
    const io = makeIo();
    // İlk eklenen speaker → host (speakers[0])
    const { socket } = await addToStage(io, 'ch-topic', 'speaker');
    io._emitted.length = 0;

    await socket._trigger('stage:setTopic', { channelId: 'ch-topic', topic: 'Haftalık buluşma' });

    const ev = io._emitted.find(e => e.ev === 'stage:topicUpdate');
    expect(ev).toBeDefined();
    expect(ev.data.topic).toBe('Haftalık buluşma');
    expect(ev.data.channelId).toBe('ch-topic');
    expect(ev._target).toBe('stage:ch-topic');
  });

  it('host olmayan speaker konu güncelleyemez', async () => {
    const io = makeIo();
    await addToStage(io, 'ch-topic2', 'speaker'); // host
    const { socket: guestSock } = await addToStage(io, 'ch-topic2', 'speaker'); // misafir
    io._emitted.length = 0;

    await guestSock._trigger('stage:setTopic', { channelId: 'ch-topic2', topic: 'Değiştirilmemeli' });

    const ev = io._emitted.find(e => e.ev === 'stage:topicUpdate');
    expect(ev).toBeUndefined();
  });

  it('listener konu güncelleyemez', async () => {
    const io = makeIo();
    await addToStage(io, 'ch-topic3', 'speaker');
    const { socket: listenerSock } = await addToStage(io, 'ch-topic3', 'listener');
    io._emitted.length = 0;

    await listenerSock._trigger('stage:setTopic', { channelId: 'ch-topic3', topic: 'Deneme' });

    expect(io._emitted.find(e => e.ev === 'stage:topicUpdate')).toBeUndefined();
  });

  it('200 karakter sınırı uygulanır', async () => {
    const io = makeIo();
    const { socket } = await addToStage(io, 'ch-topic4', 'speaker');
    const longTopic  = 'A'.repeat(300);
    io._emitted.length = 0;

    await socket._trigger('stage:setTopic', { channelId: 'ch-topic4', topic: longTopic });

    const ev = io._emitted.find(e => e.ev === 'stage:topicUpdate');
    expect(ev).toBeDefined();
    expect(ev.data.topic.length).toBeLessThanOrEqual(200);
  });

  it('topic undefined/null → boş string olarak kaydedilir', async () => {
    const io = makeIo();
    const { socket } = await addToStage(io, 'ch-topic5', 'speaker');

    await socket._trigger('stage:setTopic', { channelId: 'ch-topic5', topic: null });

    const room = stageRooms.get('ch-topic5');
    expect(typeof room.topic).toBe('string');
    expect(room.topic.length).toBe(0);
  });

  it('channelId yoksa hata fırlatmaz', async () => {
    const io   = makeIo();
    const user = makeUser();
    const sock = makeSocket('sock-topic-safe');
    registerStageHandlers(sock, io, user);
    await expect(sock._trigger('stage:setTopic', { topic: 'test' })).resolves.not.toThrow();
  });

  it('güncel konu Room state\'e kaydedilir', async () => {
    const io = makeIo();
    const { socket } = await addToStage(io, 'ch-topic6', 'speaker');

    await socket._trigger('stage:setTopic', { channelId: 'ch-topic6', topic: 'Yeni konu' });

    expect(stageRooms.get('ch-topic6').topic).toBe('Yeni konu');
  });
});

// ════════════════════════════════════════════════════════════════
// stage:setLive
// ════════════════════════════════════════════════════════════════

describe('stage:setLive', () => {
  it('host canlı yayını açabilir ve stage:liveUpdate yayınlanır', async () => {
    const io = makeIo();
    const { socket } = await addToStage(io, 'ch-live', 'speaker');
    io._emitted.length = 0;

    await socket._trigger('stage:setLive', { channelId: 'ch-live', live: true });

    const ev = io._emitted.find(e => e.ev === 'stage:liveUpdate');
    expect(ev).toBeDefined();
    expect(ev.data.live).toBe(true);
    expect(ev.data.channelId).toBe('ch-live');
    expect(ev._target).toBe('stage:ch-live');
  });

  it('host canlı yayını kapatabilir', async () => {
    const io = makeIo();
    const { socket } = await addToStage(io, 'ch-live2', 'speaker');
    await socket._trigger('stage:setLive', { channelId: 'ch-live2', live: true });
    io._emitted.length = 0;

    await socket._trigger('stage:setLive', { channelId: 'ch-live2', live: false });

    const ev = io._emitted.find(e => e.ev === 'stage:liveUpdate');
    expect(ev).toBeDefined();
    expect(ev.data.live).toBe(false);
  });

  it('host olmayan kullanıcı live durumunu değiştiremez', async () => {
    const io = makeIo();
    await addToStage(io, 'ch-live3', 'speaker'); // host
    const { socket: guestSock } = await addToStage(io, 'ch-live3', 'speaker');
    io._emitted.length = 0;

    await guestSock._trigger('stage:setLive', { channelId: 'ch-live3', live: true });

    expect(io._emitted.find(e => e.ev === 'stage:liveUpdate')).toBeUndefined();
  });

  it('listener live durumunu değiştiremez', async () => {
    const io = makeIo();
    await addToStage(io, 'ch-live4', 'speaker');
    const { socket: lSock } = await addToStage(io, 'ch-live4', 'listener');
    io._emitted.length = 0;

    await lSock._trigger('stage:setLive', { channelId: 'ch-live4', live: true });

    expect(io._emitted.find(e => e.ev === 'stage:liveUpdate')).toBeUndefined();
  });

  it('live durum Room state\'e kaydedilir', async () => {
    const io = makeIo();
    const { socket } = await addToStage(io, 'ch-live5', 'speaker');

    await socket._trigger('stage:setLive', { channelId: 'ch-live5', live: true });

    expect(stageRooms.get('ch-live5').live).toBe(true);
  });

  it('live:false sonrası Room state güncellenir', async () => {
    const io = makeIo();
    const { socket } = await addToStage(io, 'ch-live6', 'speaker');
    await socket._trigger('stage:setLive', { channelId: 'ch-live6', live: true });

    await socket._trigger('stage:setLive', { channelId: 'ch-live6', live: false });

    expect(stageRooms.get('ch-live6').live).toBe(false);
  });

  it('channelId yoksa hata fırlatmaz', async () => {
    const io   = makeIo();
    const user = makeUser();
    const sock = makeSocket('sock-live-safe');
    registerStageHandlers(sock, io, user);
    await expect(sock._trigger('stage:setLive', { live: true })).resolves.not.toThrow();
  });

  it('mevcut olmayan kanalda setLive hata fırlatmaz', async () => {
    const io   = makeIo();
    const user = makeUser();
    const sock = makeSocket('sock-live-noop');
    registerStageHandlers(sock, io, user);
    await expect(
      sock._trigger('stage:setLive', { channelId: 'ghost-ch', live: true })
    ).resolves.not.toThrow();
  });

  // Entegrasyon: topic + live birlikte değiştirilebilir
  it('topic ve live aynı anda set edilebilir', async () => {
    const io = makeIo();
    const { socket } = await addToStage(io, 'ch-combo', 'speaker');
    io._emitted.length = 0;

    await socket._trigger('stage:setTopic', { channelId: 'ch-combo', topic: 'AMA Oturumu' });
    await socket._trigger('stage:setLive',  { channelId: 'ch-combo', live: true });

    const room = stageRooms.get('ch-combo');
    expect(room.topic).toBe('AMA Oturumu');
    expect(room.live).toBe(true);

    const topicEv = io._emitted.find(e => e.ev === 'stage:topicUpdate');
    const liveEv  = io._emitted.find(e => e.ev === 'stage:liveUpdate');
    expect(topicEv).toBeDefined();
    expect(liveEv).toBeDefined();
  });
});
