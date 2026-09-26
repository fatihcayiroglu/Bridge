import type { SocketListener } from './helpers/socketDoubles';
import { EmittedLog, requireEmitted } from './helpers/socketDoubles';
import type { ClusterServerDouble } from './helpers/socketDoubles';
'use strict';
process.env.NODE_ENV = 'test';

jest.mock('../music', () => ({
  readMusicQueue: jest.fn(async () => ({ current: null, queue: [] })),
  getVideoInfo: jest.fn(),
  getStreamUrl: jest.fn(),
  mutateMusicQueue: jest.fn(async (_channelId: string, fn: (queue: { current: unknown; queue: unknown[] }) => unknown) => fn({ current: null, queue: [] })),
  skipSharedMusicQueue: jest.fn(async () => null),
  clearSharedMusicQueue: jest.fn(async () => undefined),
}));
// eslint-disable-next-line no-var
var _scDb: ReturnType<typeof import('./helpers/mockDb').createMockDb>;
jest.mock('../db/loader', () => {
  _scDb = require('./helpers/mockDb').createMockDb();
  return _scDb;
});
jest.mock('../db/index', () => require('../db/loader'));

import { registerVoiceHandlers } from '../socket/handlers/voice';
import { registerStageHandlers } from '../socket/handlers/stage';
import { registerMusicHandlers } from '../socket/handlers/music';

function makeSocket(id: string = 'sock-contract') {
  const handlers: Record<string, unknown> = {};
  const rooms = new Set<string>();
  return {
    id,
    rooms,
    on(event: string, fn: SocketListener) { handlers[event] = fn; },
    emit() {},
    join(room: string) { rooms.add(room); },
    leave(room: string) { rooms.delete(room); },
    to() { return { emit() {} }; },
    _trigger(event: string, payload: unknown) {
      const fn = handlers[event];
      return typeof fn === 'function' ? (fn as (data: unknown) => unknown)(payload) : undefined;
    },
  };
}

function makeIo() {
  const emitted: EmittedLog = [];
  return {
    _emitted: emitted,
    to(target: string) {
      return {
        emit(ev: string, data: unknown) {
          emitted.push({ ev, data, target });
        },
      };
    },
    // `registerStageHandlers` `ClusterServer` ister: sahne medya yetkisi Redis
    // adapter'i uzerinden DIGER dugumlere tasinir. Ikiz bu yuzeyi tasimadan
    // sozlesmeye uyamiyordu.
    on(_event: string, _listener: (...args: never[]) => unknown) { return undefined; },
    serverSideEmit(_event: string, ..._args: unknown[]) { return undefined; },
  } satisfies ClusterServerDouble;
}

// FAZ G6 — YETKI FIKSTURU.
//
// `voice:join` artik uyelik + VIEW_CHANNELS + CONNECT dogrular ve payload'daki
// `serverId`nin kanalin GERCEK sunucusu oldugunu denetler. Bu sozlesme testi
// daha once hicbir fikstur kurmuyordu; cunku eski handler HICBIR SEY
// dogrulamiyordu. Sozlesme (payload sekli) hala ayni sekilde olculur — yalniz
// artik MESRU bir kullaniciyla.
beforeEach(async () => {
  await _scDb.servers.insert({ _id: 'sv1', name: 'S', ownerId: 'o', createdAt: 1 });
  await _scDb.channels.insert({ _id: 'c1', serverId: 'sv1', name: 'sesli', type: 'voice', createdAt: 1 });
  await _scDb.members.insert({ userId: 'u1', serverId: 'sv1', roles: [], joinedAt: 1 });
});

describe('socket event contracts', () => {
  it('voice:room-update payload shape is stable', async () => {
    const io = makeIo();
    const user = { _id: 'u1', displayName: 'A', avatarColor: '#aaa' };
    const socket = makeSocket('s1');
    registerVoiceHandlers(socket, io, user);

    await socket._trigger('voice:join', { channelId: 'c1', serverId: 'sv1' });

    const evt = requireEmitted(io._emitted, 'voice:room-update');
    expect(evt.data).toEqual(expect.objectContaining({
      channelId: expect.any(String),
      peers: expect.any(Array),
    }));
  });

  it('stage:state payload includes required keys', async () => {
    const db = require('../db/loader');
    // EKSİK FIXTURE: `_stageAccess` -> `resolvePermissions` ilk iş olarak
    // `Servers.findById` yapar; satır yoksa 0 izin döner ve `stage:join`
    // sessizce reddedilir (bu yüzden `stage:state` hiç yayınlanmıyordu).
    await db.servers.insert({ _id: 'sv-contract', name: 'Contract', ownerId: 'sc-owner', createdAt: 1 });
    await db.channels.insert({ _id: 'st-1', serverId: 'sv-contract', type: 'stage', name: 'Stage' });
    await db.members.insert({ _id: 'member-u2', userId: 'u2', serverId: 'sv-contract' });
    const io = makeIo();
    const user = { _id: 'u2', displayName: 'B', avatarColor: '#bbb' };
    const socket = makeSocket('s2');
    registerStageHandlers(socket, io, user);

    await socket._trigger('stage:join', { channelId: 'st-1' });
    await socket._trigger('stage:setRole', { channelId: 'st-1', role: 'speaker' });

    const evt = requireEmitted(io._emitted, 'stage:state');
    expect(evt.data).toEqual(expect.objectContaining({
      channelId: 'st-1',
      speakers: expect.any(Array),
      listeners: expect.any(Array),
    }));
  });

  it('music:play payload includes channel and track', async () => {
    const io = makeIo();
    const socket = makeSocket('s3');
    const user = { _id: 'u3', displayName: 'C' };
    registerMusicHandlers(socket, io, user);

    const { skipSharedMusicQueue } = require('../music');
    skipSharedMusicQueue.mockResolvedValueOnce({ title: 'Track 2' });

    // ── YENİ GÜVENLİK KOŞULU ─────────────────────────────────────────────
    // `music:ended` artık YALNIZCA o sesli kanalda BULUNAN soketten kabul
    // edilir (socket/handlers/music.ts:136-137). Aksi hâlde herhangi bir
    // istemci başkasının parçasını atlatabilirdi. Sözleşme testi bu ön koşulu
    // kurmalı; kurmazsa handler sessizce döner ve `music:play` hiç çıkmaz.
    (socket as unknown as { currentVoiceChannel?: string }).currentVoiceChannel = 'm-1';
    socket.join('voice:m-1');

    await socket._trigger('music:ended', { channelId: 'm-1' });

    const evt = requireEmitted(io._emitted, 'music:play');
    expect(evt.data).toEqual(expect.objectContaining({
      channelId: 'm-1',
      track: expect.objectContaining({ title: expect.any(String) }),
    }));
  });
});
