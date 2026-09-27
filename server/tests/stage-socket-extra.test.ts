// server/tests/stage-socket-extra.test.ts
// stage.ts handler — stage-socket.test.js'de eksik kalan üç event:
//   - stage:speaking  (VAD tabanlı konuşma indikatörü)
//   - stage:setTopic  (host konu güncelleme, yetki kontrolü)
//   - stage:setLive   (host CANLI badge toggle)
import { present } from './helpers/narrow';
import { ClusterServerDouble, EmittedLog, SocketDouble, dataOf, findEmitted, readString, requireEmitted } from './helpers/socketDoubles';

'use strict';
process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => {
  const { createMockDb } = require('./helpers/mockDb');
  return createMockDb();
});

import { registerStageHandlers as registerStageHandlersProduction, stageRooms } from '../socket/handlers/stage';
import type { AuthenticatedUser } from '../socket/handlers/stage';
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

// ── Yardımcılar ─────────────────────────────────────────────────

/** Sahne handler'larinin kullanicidan okudugu yuzey (`AuthenticatedUser`). */
interface StageUserDouble { _id: string; displayName?: string; avatarColor?: string }

function makeUser(overrides: Partial<StageUserDouble> = {}): StageUserDouble {
  return {
    _id:         `u-${Math.random().toString(36).slice(2)}`,
    displayName: 'StageUser',
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
    async _trigger(event: string, data?: unknown) {
      // Yuk GUVENILMEZDIR; alanlar dogrulanarak okunur.
      const channelId = readString(data, 'channelId');
      if (event === 'stage:join' && channelId) {
        await ensureStageFixture(channelId, stageSocketUsers.get(socket)!, readString(data, 'serverId'));
      }
      const handler = handlers[event];
      if (typeof handler === 'function') await handler(data);
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

/** Bir kullanıcıyı verilen rolle odaya ekler */
async function addToStage(
  io: ClusterServerDouble,
  channelId: string,
  role: 'speaker' | 'listener' | 'moderator',
  userOverrides: Partial<AuthenticatedUser> = {},
) {
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

    const ev = requireEmitted(io._emitted, 'stage:speaking');
    expect(ev).toBeDefined();
    expect(dataOf(ev).userId).toBe(user._id);
    expect(dataOf(ev).speaking).toBe(true);
    expect(ev._target).toBe('stage:ch-sp');
  });

  it('speaker konuşmayı bitirirse speaking:false yayınlanır', async () => {
    const io = makeIo();
    const { socket, user } = await addToStage(io, 'ch-sp2', 'speaker');
    await socket._trigger('stage:speaking', { channelId: 'ch-sp2', speaking: true });
    io._emitted.length = 0;

    await socket._trigger('stage:speaking', { channelId: 'ch-sp2', speaking: false });

    const ev = requireEmitted(io._emitted, 'stage:speaking');
    expect(ev).toBeDefined();
    expect(dataOf(ev).speaking).toBe(false);
  });

  it('mute durumdaki speaker speaking:true gönderemez', async () => {
    const io = makeIo();
    const { socket } = await addToStage(io, 'ch-sp3', 'speaker');
    // Sessize al
    await socket._trigger('stage:updateMute', { channelId: 'ch-sp3', muted: true });
    io._emitted.length = 0;

    await socket._trigger('stage:speaking', { channelId: 'ch-sp3', speaking: true });

    // Mute olduğunda speaking emit edilmemeli
    const ev = findEmitted(io._emitted, 'stage:speaking');
    expect(ev).toBeUndefined();
  });

  it('listener stage:speaking tetiklerse yayın yapılmaz', async () => {
    const io = makeIo();
    const { socket } = await addToStage(io, 'ch-sp4', 'listener');
    io._emitted.length = 0;

    await socket._trigger('stage:speaking', { channelId: 'ch-sp4', speaking: true });

    // Listener speakers listesinde değil → emit olmamalı
    const ev = findEmitted(io._emitted, 'stage:speaking');
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

    const room = present(stageRooms.get('ch-sp5'), 'stage odasi');
    const sp   = present(room.speakers.find(u => u.userId === user._id), 'konusmaci');
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

    const ev = requireEmitted(io._emitted, 'stage:topicUpdate');
    expect(ev).toBeDefined();
    expect(dataOf(ev).topic).toBe('Haftalık buluşma');
    expect(dataOf(ev).channelId).toBe('ch-topic');
    expect(ev._target).toBe('stage:ch-topic');
  });

  it('host olmayan speaker konu güncelleyemez', async () => {
    const io = makeIo();
    await addToStage(io, 'ch-topic2', 'speaker'); // host
    const { socket: guestSock } = await addToStage(io, 'ch-topic2', 'speaker'); // misafir
    io._emitted.length = 0;

    await guestSock._trigger('stage:setTopic', { channelId: 'ch-topic2', topic: 'Değiştirilmemeli' });

    const ev = findEmitted(io._emitted, 'stage:topicUpdate');
    expect(ev).toBeUndefined();
  });

  it('listener konu güncelleyemez', async () => {
    const io = makeIo();
    await addToStage(io, 'ch-topic3', 'speaker');
    const { socket: listenerSock } = await addToStage(io, 'ch-topic3', 'listener');
    io._emitted.length = 0;

    await listenerSock._trigger('stage:setTopic', { channelId: 'ch-topic3', topic: 'Deneme' });

    expect(findEmitted(io._emitted, 'stage:topicUpdate')).toBeUndefined();
  });

  it('200 karakteri aşan konu doğrulamada reddedilir', async () => {
    const io = makeIo();
    const { socket } = await addToStage(io, 'ch-topic4', 'speaker');
    const longTopic  = 'A'.repeat(300);
    io._emitted.length = 0;

    await socket._trigger('stage:setTopic', { channelId: 'ch-topic4', topic: longTopic });

    const ev = findEmitted(io._emitted, 'stage:topicUpdate');
    expect(ev).toBeUndefined();
    expect(present(stageRooms.get('ch-topic4'), 'stage odasi').topic).toBe('');
  });

  it('topic undefined/null → boş string olarak kaydedilir', async () => {
    const io = makeIo();
    const { socket } = await addToStage(io, 'ch-topic5', 'speaker');

    await socket._trigger('stage:setTopic', { channelId: 'ch-topic5', topic: null });

    const room = present(stageRooms.get('ch-topic5'), 'stage odasi');
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

    expect(present(stageRooms.get('ch-topic6'), 'stage odasi').topic).toBe('Yeni konu');
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

    const ev = requireEmitted(io._emitted, 'stage:liveUpdate');
    expect(ev).toBeDefined();
    expect(dataOf(ev).live).toBe(true);
    expect(dataOf(ev).channelId).toBe('ch-live');
    expect(ev._target).toBe('stage:ch-live');
  });

  it('host canlı yayını kapatabilir', async () => {
    const io = makeIo();
    const { socket } = await addToStage(io, 'ch-live2', 'speaker');
    await socket._trigger('stage:setLive', { channelId: 'ch-live2', live: true });
    io._emitted.length = 0;

    await socket._trigger('stage:setLive', { channelId: 'ch-live2', live: false });

    const ev = requireEmitted(io._emitted, 'stage:liveUpdate');
    expect(ev).toBeDefined();
    expect(dataOf(ev).live).toBe(false);
  });

  it('host olmayan kullanıcı live durumunu değiştiremez', async () => {
    const io = makeIo();
    await addToStage(io, 'ch-live3', 'speaker'); // host
    const { socket: guestSock } = await addToStage(io, 'ch-live3', 'speaker');
    io._emitted.length = 0;

    await guestSock._trigger('stage:setLive', { channelId: 'ch-live3', live: true });

    expect(findEmitted(io._emitted, 'stage:liveUpdate')).toBeUndefined();
  });

  it('listener live durumunu değiştiremez', async () => {
    const io = makeIo();
    await addToStage(io, 'ch-live4', 'speaker');
    const { socket: lSock } = await addToStage(io, 'ch-live4', 'listener');
    io._emitted.length = 0;

    await lSock._trigger('stage:setLive', { channelId: 'ch-live4', live: true });

    expect(findEmitted(io._emitted, 'stage:liveUpdate')).toBeUndefined();
  });

  it('live durum Room state\'e kaydedilir', async () => {
    const io = makeIo();
    const { socket } = await addToStage(io, 'ch-live5', 'speaker');

    await socket._trigger('stage:setLive', { channelId: 'ch-live5', live: true });

    expect(present(stageRooms.get('ch-live5'), 'stage odasi').live).toBe(true);
  });

  it('live:false sonrası Room state güncellenir', async () => {
    const io = makeIo();
    const { socket } = await addToStage(io, 'ch-live6', 'speaker');
    await socket._trigger('stage:setLive', { channelId: 'ch-live6', live: true });

    await socket._trigger('stage:setLive', { channelId: 'ch-live6', live: false });

    expect(present(stageRooms.get('ch-live6'), 'stage odasi').live).toBe(false);
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

    const room = present(stageRooms.get('ch-combo'), 'stage odasi');
    expect(room.topic).toBe('AMA Oturumu');
    expect(room.live).toBe(true);

    const topicEv = requireEmitted(io._emitted, 'stage:topicUpdate');
    const liveEv  = requireEmitted(io._emitted, 'stage:liveUpdate');
    expect(topicEv).toBeDefined();
    expect(liveEv).toBeDefined();
  });
});
