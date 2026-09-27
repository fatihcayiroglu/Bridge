// server/tests/stage-video-grid-guard-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// SAHNE VİDEO IZGARASI — KORUMA DALLARI VE SPOTLIGHT TEMİZLİĞİ
// ════════════════════════════════════════════════════════════════════════════
//
// `stage-video-grid-lifecycle.test.ts` kabul edilen yolları ölçer. Burada
// REDDEDİLEN yollar ve temizlik dalları kapatılır; her biri gerçek bir
// arızaya karşılık gelir:
//
//   · IZGARA ÜYESİ OLMAYAN — odaya hiç girmemiş bir soket, konuşma/susturma
//     yayını üretememelidir; aksi hâlde sahnede olmayan biri "konuşuyor"
//     görünür.
//   · MEDYA OTORİTESİ — kamera/ekran varlığı YALNIZ mediasoup üreticisinden
//     okunur. Medya oturumu hiç yoksa her alan kapalı kabul edilir.
//   · SPOTLIGHT TEMİZLİĞİ — vurgulanan kişi ayrılırsa vurgu düşmeli ve düzen
//     ızgaraya dönmelidir; aksi hâlde herkes boş bir kareye bakar.
//   · ODA ÖMRÜ — son katılımcı ayrılınca oda tamamen silinir (sızıntı yok) ve
//     kalan katılımcı varsa "peer-left" yayınlanır.

'use strict';
process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../socket/handlers/mediasoup/rooms', () => ({ sfuPeers: new Map(), sfuRooms: new Map() }));

const isStageParticipant = jest.fn().mockResolvedValue(true);
const canManageStage = jest.fn().mockResolvedValue(true);
const isStageSpeaker = jest.fn().mockResolvedValue(true);
jest.mock('../socket/handlers/stage', () => ({
  stageRooms: new Map(),
  isStageParticipant: (...a: unknown[]) => isStageParticipant(...a),
  isStageSpeaker: (...a: unknown[]) => isStageSpeaker(...a),
  canManageStage: (...a: unknown[]) => canManageStage(...a),
  bindStageMediaClusterControl: jest.fn(),
  registerStageHandlers: jest.fn(),
}));
jest.mock('../lib/redisAdapter', () => ({
  cache: {
    invalidatePattern: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null), set: jest.fn(), del: jest.fn(),
  },
}));

import { registerVideoGridHandlers, videoGridRooms } from '../socket/handlers/stage-video-grid';
import { sfuPeers } from '../socket/handlers/mediasoup/rooms';
import type { Server as IOServer, Socket } from 'socket.io';

type Sent = { room?: string; event: string; data: unknown };

function makeSocket(id: string) {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  const emitted: Sent[] = [];
  const roomEmitted: Sent[] = [];
  return {
    id, handlers, emitted, roomEmitted,
    on(event: string, fn: (...args: unknown[]) => unknown) { handlers[event] = fn; },
    emit(event: string, data: unknown) { emitted.push({ event, data }); },
    to(room: string) { return { emit: (event: string, data: unknown) => { roomEmitted.push({ room, event, data }); } }; },
    join: jest.fn(),
    leave: jest.fn(async () => undefined),
  } as unknown as Socket & {
    handlers: Record<string, (...args: unknown[]) => unknown>;
    emitted: Sent[]; roomEmitted: Sent[]; join: jest.Mock; leave: jest.Mock;
  };
}

function makeIo() {
  const emitted: Sent[] = [];
  return {
    emitted,
    to: (room: string) => ({ emit: (event: string, data: unknown) => { emitted.push({ room, event, data }); } }),
  } as unknown as IOServer & { emitted: Sent[] };
}

const USER = { _id: 'u-1', displayName: 'Alice', avatarColor: '#abc' };
const OTHER = { _id: 'u-2', displayName: 'Bob', avatarColor: '#def' };
const CHANNEL = 'ch-1';

function seedPeer(socketId: string, channelId = CHANNEL, extra: Record<string, unknown> = {}) {
  (sfuPeers as Map<string, unknown>).set(socketId, {
    socketId, channelId, userId: USER._id,
    producers: new Map(), consumers: new Map(), transports: new Map(), ...extra,
  });
}

let socket: ReturnType<typeof makeSocket>;
let io: ReturnType<typeof makeIo>;

const fire = (target: ReturnType<typeof makeSocket>, event: string, payload?: unknown) =>
  target.handlers[event]?.(payload);

beforeEach(() => {
  (sfuPeers as Map<string, unknown>).clear();
  videoGridRooms.clear();
  isStageParticipant.mockReset().mockResolvedValue(true);
  canManageStage.mockReset().mockResolvedValue(true);
  isStageSpeaker.mockReset().mockResolvedValue(true);
  socket = makeSocket('sock-1');
  io = makeIo();
  seedPeer('sock-1');
  registerVideoGridHandlers(socket, io, USER);
});

describe('ızgara üyeliği olmayan yayın üretemez', () => {
  it('odaya hiç girmemiş soket konuşma durumu yayamaz', async () => {
    await fire(socket, 'voice:activity', { channelId: CHANNEL, speaking: true });

    expect(io.emitted).toEqual([]);
  });

  it('oda var ama soket katılımcı değilse konuşma yayını üretilmez', async () => {
    await fire(socket, 'stage:video-join', { channelId: CHANNEL });
    io.emitted.length = 0;
    videoGridRooms.get(CHANNEL)!.peers.delete('sock-1');

    await fire(socket, 'voice:activity', { channelId: CHANNEL, speaking: true });

    expect(io.emitted).toEqual([]);
  });

  it('sahne konuşmacısı olmayan konuşma durumu yayamaz', async () => {
    await fire(socket, 'stage:video-join', { channelId: CHANNEL });
    io.emitted.length = 0;
    isStageSpeaker.mockResolvedValue(false);

    await fire(socket, 'voice:activity', { channelId: CHANNEL, speaking: true });

    expect(io.emitted).toEqual([]);
    expect(videoGridRooms.get(CHANNEL)!.peers.get('sock-1')!.speaking).toBe(false);
  });

  it('medya oturumu başka kanaldaysa konuşma/durum yayını yapılmaz', async () => {
    await fire(socket, 'stage:video-join', { channelId: CHANNEL });
    io.emitted.length = 0;
    seedPeer('sock-1', 'baska-kanal');

    await fire(socket, 'voice:activity', { channelId: CHANNEL, speaking: true });
    await fire(socket, 'voice:state-update', { channelId: CHANNEL, muted: true, deafened: false, screensharing: false, video: false });

    expect(io.emitted).toEqual([]);
  });

  it('ızgaraya girmemiş soketin durum güncellemesi yayınlanmaz', async () => {
    await fire(socket, 'voice:state-update', { channelId: CHANNEL, muted: true, deafened: false, screensharing: false, video: false });

    expect(io.emitted).toEqual([]);
  });

  it('oda silindikten sonra gelen durum güncellemesi yayınlanmaz', async () => {
    await fire(socket, 'stage:video-join', { channelId: CHANNEL });
    videoGridRooms.clear();
    io.emitted.length = 0;

    await fire(socket, 'voice:state-update', { channelId: CHANNEL, muted: true, deafened: false, screensharing: false, video: false });

    expect(io.emitted).toEqual([]);
  });
});

describe('medya durumu otoritesi', () => {
  it('medya oturumu olmayan sokette her alan kapalı kabul edilir', async () => {
    (sfuPeers as Map<string, unknown>).delete('sock-1');

    await fire(socket, 'stage:video-join', { channelId: CHANNEL });

    expect(videoGridRooms.has(CHANNEL)).toBe(false);
    expect(socket.emitted[0]).toMatchObject({ event: 'stage:video-error' });
  });

  it('üretici yokken istemcinin iddiası kamera/ekran açmaz', async () => {
    seedPeer('sock-1', CHANNEL, { video: undefined, screensharing: undefined });
    await fire(socket, 'stage:video-join', { channelId: CHANNEL });
    io.emitted.length = 0;

    await fire(socket, 'voice:state-update', {
      channelId: CHANNEL, muted: false, deafened: false, screensharing: true, video: true,
    });

    const peer = videoGridRooms.get(CHANNEL)!.peers.get('sock-1')!;
    expect(peer.hasCamera).toBe(false);
    expect(peer.hasScreen).toBe(false);
    expect(io.emitted[0]!.data).toMatchObject({ type: 'state', hasCamera: false, hasScreen: false });
  });

  it('mediasoup üreticisi varsa kamera/ekran açık raporlanır', async () => {
    seedPeer('sock-1', CHANNEL, {
      video: undefined, screensharing: undefined,
      producers: new Map([['video', {}], ['screen', {}]]),
    });

    await fire(socket, 'stage:video-join', { channelId: CHANNEL });

    const peer = videoGridRooms.get(CHANNEL)!.peers.get('sock-1')!;
    expect(peer.hasCamera).toBe(true);
    expect(peer.hasScreen).toBe(true);
  });

  it('açık medya bayrakları üretici sorgusunun önüne geçer', async () => {
    seedPeer('sock-1', CHANNEL, { video: false, screensharing: false, producers: new Map([['video', {}]]) });

    await fire(socket, 'stage:video-join', { channelId: CHANNEL });

    const peer = videoGridRooms.get(CHANNEL)!.peers.get('sock-1')!;
    expect(peer.hasCamera).toBe(false);
    expect(peer.hasScreen).toBe(false);
  });
});

describe('ayrılma ve spotlight temizliği', () => {
  async function joinTwo(): Promise<ReturnType<typeof makeSocket>> {
    await fire(socket, 'stage:video-join', { channelId: CHANNEL });
    const second = makeSocket('sock-2');
    seedPeer('sock-2');
    registerVideoGridHandlers(second, io, OTHER);
    await fire(second, 'stage:video-join', { channelId: CHANNEL });
    io.emitted.length = 0;
    return second;
  }

  it('vurgulanan kişi ayrılınca vurgu düşer ve düzen ızgaraya döner', async () => {
    const second = await joinTwo();
    await fire(socket, 'stage:video-layout', { channelId: CHANNEL, layout: 'spotlight', spotlightId: 'sock-2' });
    expect(videoGridRooms.get(CHANNEL)!.spotlightId).toBe('sock-2');
    io.emitted.length = 0;

    await fire(second, 'disconnect');

    const room = videoGridRooms.get(CHANNEL)!;
    expect(room.spotlightId).toBeNull();
    expect(room.layout).toBe('grid');
    expect(io.emitted).toContainEqual({
      room: `video-grid:${CHANNEL}`, event: 'stage:video-update', data: { type: 'peer-left', socketId: 'sock-2' },
    });
  });

  it('son katılımcı ayrılınca oda tamamen silinir ve yayın yapılmaz', async () => {
    await fire(socket, 'stage:video-join', { channelId: CHANNEL });
    io.emitted.length = 0;

    await fire(socket, 'disconnect');

    expect(videoGridRooms.has(CHANNEL)).toBe(false);
    expect(io.emitted).toEqual([]);
  });

  it('ızgarada olmayan soketin bağlantısı koparsa hiçbir oda etkilenmez', async () => {
    await fire(socket, 'stage:video-join', { channelId: CHANNEL });
    const stranger = makeSocket('sock-yabanci');
    registerVideoGridHandlers(stranger, io, OTHER);
    io.emitted.length = 0;

    await fire(stranger, 'disconnect');

    expect(videoGridRooms.get(CHANNEL)!.peers.has('sock-1')).toBe(true);
    expect(io.emitted).toEqual([]);
  });

  it('vurgulanan kişi dışında biri ayrılırsa vurgu korunur', async () => {
    const second = await joinTwo();
    await fire(socket, 'stage:video-layout', { channelId: CHANNEL, layout: 'spotlight', spotlightId: 'sock-1' });
    io.emitted.length = 0;

    await fire(second, 'disconnect');

    expect(videoGridRooms.get(CHANNEL)!.spotlightId).toBe('sock-1');
    expect(videoGridRooms.get(CHANNEL)!.layout).toBe('spotlight');
  });
});
