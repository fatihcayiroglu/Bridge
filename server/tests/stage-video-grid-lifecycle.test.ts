// server/tests/stage-video-grid-lifecycle.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// stage-video-grid — GRID UYELIGININ YASAM DONGUSU
// ════════════════════════════════════════════════════════════════════════════
// `stage-video-grid-validation.test.ts` yalnizca payload REDDINI olcer. Bu
// dosya kabul edilen yollarin ne YAPTIGINI olcer, cunku grid uyeligi bir
// YAYIN listesidir: odada kalan bir soket, ayrildiktan sonra bile duzen ve
import { findEmitted, requireEmitted } from './helpers/socketDoubles';
// katilimci meta verisi ALMAYA devam eder.
//
// Olculen dort sinif:
//
// 1. KATILIM. Yalnizca AYNI kanalda aktif bir SFU eslesi olan ve sahne
//    katilimcisi olan soket girebilir. Aksi hâlde bir kullanici, uyesi
//    olmadigi bir sahnenin kamera durumunu izleyebilirdi.
//
// 2. AYRILMA. Uc ayri yol vardir — acik `stage:video-leave`, kanonik
//    `sfu:leave` ve `disconnect`. Ucu de uyeligi DUSURMELIDIR. Kanonik
//    istemci yalnizca `sfu:leave` gonderir; ozellige ozel ikinci bir olayi
//    hatirlamak zorunda DEGILDIR. Bu, olculmus bir kusurdu: `sfu:leave`
//    `sfuPeers` kaydini once silince eski koruma soketi odada BIRAKIYORDU.
//
// 3. DUZEN (layout). Yalnizca sahneyi yonetebilen degistirebilir ve spotlight
//    hedefi GERCEKTEN odada olmalidir.
//
// 4. DURUM YAYINI. Konusma/susturma guncellemeleri yalnizca odadaki bir
//    esten kabul edilir.
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
    to(room: string) {
      return { emit: (event: string, data: unknown) => { roomEmitted.push({ room, event, data }); } };
    },
    join: jest.fn(),
    leave: jest.fn(async () => undefined),
  } as unknown as Socket & {
    handlers: Record<string, (...args: unknown[]) => unknown>;
    emitted: Sent[]; roomEmitted: Sent[];
    join: jest.Mock; leave: jest.Mock;
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
const CHANNEL = 'ch-1';

function seedPeer(socketId: string, channelId = CHANNEL, extra: Record<string, unknown> = {}) {
  (sfuPeers as Map<string, unknown>).set(socketId, {
    socketId, channelId, userId: USER._id,
    producers: new Map(), consumers: new Map(), transports: new Map(), ...extra,
  });
}

let socket: ReturnType<typeof makeSocket>;
let io: ReturnType<typeof makeIo>;

const fire = (event: string, payload: unknown) => socket.handlers[event]?.(payload);

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

describe('joining the grid requires a matching, authorised media session', () => {
  it('admits a stage participant and hands back the room state', async () => {
    await fire('stage:video-join', { channelId: CHANNEL });

    expect(socket.join).toHaveBeenCalledWith(`video-grid:${CHANNEL}`);
    const state = requireEmitted(socket.emitted, 'stage:video-state');
    expect(state).toBeDefined();
    expect((state!.data as { peers: unknown[] }).peers).toHaveLength(1);
    // Odadakilere yeni katilimci duyurulur.
    expect(socket.roomEmitted.some(e => e.event === 'stage:video-update')).toBe(true);
  });

  it('reflects the live media state at join time', async () => {
    (sfuPeers as Map<string, unknown>).clear();
    seedPeer('sock-1', CHANNEL, { video: true, screensharing: true, muted: true, deafened: false });
    await fire('stage:video-join', { channelId: CHANNEL });

    const peer = (findEmitted(socket.emitted, 'stage:video-state')!
      .data as { peers: Array<Record<string, unknown>> }).peers[0];
    expect(peer).toEqual(expect.objectContaining({
      hasCamera: true, hasScreen: true, muted: true, deafened: false, speaking: false,
    }));
  });

  it('refuses a socket whose media session is in another channel', async () => {
    (sfuPeers as Map<string, unknown>).clear();
    seedPeer('sock-1', 'baska-kanal');
    await fire('stage:video-join', { channelId: CHANNEL });

    expect(socket.join).not.toHaveBeenCalled();
    expect(socket.emitted.some(e => e.event === 'stage:video-error')).toBe(true);
  });

  it('refuses a socket with no media session at all', async () => {
    (sfuPeers as Map<string, unknown>).clear();
    await fire('stage:video-join', { channelId: CHANNEL });
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('refuses somebody who is not a stage participant', async () => {
    isStageParticipant.mockResolvedValue(false);
    await fire('stage:video-join', { channelId: CHANNEL });
    // Sahnede olmayan biri kamera durumlarini izleyemez.
    expect(socket.join).not.toHaveBeenCalled();
    expect(socket.emitted.some(e => e.event === 'stage:video-error')).toBe(true);
  });
});

describe('every departure path drops grid membership', () => {
  beforeEach(async () => { await fire('stage:video-join', { channelId: CHANNEL }); });

  it('removes the peer on an explicit leave', async () => {
    await fire('stage:video-leave', { channelId: CHANNEL });
    expect(socket.leave).toHaveBeenCalledWith(`video-grid:${CHANNEL}`);
    expect(videoGridRooms.get(CHANNEL)?.peers.has('sock-1') ?? false).toBe(false);
  });

  it('removes the peer on the canonical sfu:leave even after the media index is gone', async () => {
    // Olculmus kusur: `sfu:leave` once `sfuPeers` kaydini siliyordu ve eski
    // koruma soketi odada BIRAKIYORDU — ayrilmis kullanici yayin almaya
    // devam ediyordu.
    (sfuPeers as Map<string, unknown>).delete('sock-1');
    await fire('sfu:leave', { channelId: CHANNEL });

    expect(socket.leave).toHaveBeenCalledWith(`video-grid:${CHANNEL}`);
    expect(videoGridRooms.get(CHANNEL)?.peers.has('sock-1') ?? false).toBe(false);
  });

  it('ignores an sfu:leave that names no channel or an over-long one', async () => {
    await fire('sfu:leave', {});
    await fire('sfu:leave', { channelId: 'x'.repeat(65) });
    expect(socket.leave).not.toHaveBeenCalled();
    expect(videoGridRooms.get(CHANNEL)?.peers.has('sock-1')).toBe(true);
  });

  it('removes the peer from every room on disconnect', async () => {
    await fire('disconnect', undefined);
    expect(videoGridRooms.get(CHANNEL)?.peers.has('sock-1') ?? false).toBe(false);
  });
});

describe('layout changes are authorised and target-checked', () => {
  beforeEach(async () => { await fire('stage:video-join', { channelId: CHANNEL }); });

  it('switches to grid and broadcasts the change', async () => {
    await fire('stage:video-layout', { channelId: CHANNEL, layout: 'grid' });
    const room = videoGridRooms.get(CHANNEL)!;
    expect(room.layout).toBe('grid');
    expect(room.spotlightId).toBeNull();
    expect(io.emitted.some(e => e.event === 'stage:video-layout-changed')).toBe(true);
  });

  it('spotlights the requester when no explicit target is given', async () => {
    await fire('stage:video-layout', { channelId: CHANNEL, layout: 'spotlight' });
    expect(videoGridRooms.get(CHANNEL)!.spotlightId).toBe('sock-1');
  });

  it('refuses a spotlight target that is not in this room', async () => {
    io.emitted.length = 0;
    await fire('stage:video-layout', { channelId: CHANNEL, layout: 'spotlight', spotlightId: 'yabanci-soket' });

    expect(socket.emitted.some(e => e.event === 'stage:video-error')).toBe(true);
    expect(io.emitted).toHaveLength(0);
    expect(videoGridRooms.get(CHANNEL)!.layout).not.toBe('spotlight');
  });

  it('refuses a member without stage management permission', async () => {
    canManageStage.mockResolvedValue(false);
    io.emitted.length = 0;
    await fire('stage:video-layout', { channelId: CHANNEL, layout: 'grid' });

    expect(socket.emitted.some(e => e.event === 'stage:video-error')).toBe(true);
    expect(io.emitted).toHaveLength(0);
  });

  it('ignores a layout change from a socket that never joined the grid', async () => {
    videoGridRooms.get(CHANNEL)!.peers.delete('sock-1');
    io.emitted.length = 0;
    await fire('stage:video-layout', { channelId: CHANNEL, layout: 'grid' });
    expect(io.emitted).toHaveLength(0);
  });
});

describe('state updates only come from a peer inside the room', () => {
  beforeEach(async () => { await fire('stage:video-join', { channelId: CHANNEL }); });

  it('broadcasts a speaking change', async () => {
    io.emitted.length = 0;
    await fire('voice:activity', { channelId: CHANNEL, speaking: true });

    expect(videoGridRooms.get(CHANNEL)!.peers.get('sock-1')!.speaking).toBe(true);
    expect(io.emitted.some(e =>
      e.event === 'stage:video-update' && (e.data as { type: string }).type === 'speaking')).toBe(true);
  });

  it('broadcasts a mute/camera change taken from the SFU, not from the client payload', async () => {
    // KANONIK: kamera/ekran/susturma varligi YALNIZCA gercek mediasoup
    // eslesinden okunur. Istemci booleanlari kabul edilseydi, bir kullanici
    // sahnede sahte kamera/ekran durumu boyayabilirdi.
    const sfu = sfuPeers.get('sock-1')!;
    sfu.muted = true; sfu.deafened = true; sfu.screensharing = true; sfu.video = false;

    io.emitted.length = 0;
    await fire('voice:state-update', {
      // Istemci payload'i BILEREK yetkili durumun TERSINI iddia eder.
      channelId: CHANNEL, muted: false, deafened: false, screensharing: false, video: true,
    });

    const peer = videoGridRooms.get(CHANNEL)!.peers.get('sock-1')!;
    expect(peer).toEqual(expect.objectContaining({
      muted: true, deafened: true, hasScreen: true, hasCamera: false,
    }));
    expect(io.emitted.some(e =>
      e.event === 'stage:video-update' && (e.data as { type: string }).type === 'state')).toBe(true);
  });

  it('a non-speaker is forced muted and stripped of media regardless of SFU producers', async () => {
    isStageSpeaker.mockResolvedValue(false);
    const sfu = sfuPeers.get('sock-1')!;
    sfu.muted = false; sfu.deafened = false; sfu.screensharing = true; sfu.video = true;

    io.emitted.length = 0;
    await fire('voice:state-update', {
      channelId: CHANNEL, muted: false, deafened: false, screensharing: true, video: true,
    });

    const peer = videoGridRooms.get(CHANNEL)!.peers.get('sock-1')!;
    expect(peer).toEqual(expect.objectContaining({
      muted: true, hasScreen: false, hasCamera: false, speaking: false,
    }));
  });

  it.each([
    ['voice:activity', { channelId: 'baska', speaking: true }],
    ['voice:state-update', { channelId: 'baska', muted: true, deafened: false, screensharing: false, video: false }],
  ])('ignores %s naming a different channel', async (event, payload) => {
    io.emitted.length = 0;
    await fire(event, payload);
    expect(io.emitted).toHaveLength(0);
  });

  it('syncs and broadcasts when a video producer appears', async () => {
    io.emitted.length = 0;
    await fire('sfu:produced', { kind: 'video' });
    expect(io.emitted.some(e => e.event === 'stage:video-update')).toBe(true);
  });

  it('syncs without broadcasting for a plain audio producer', async () => {
    io.emitted.length = 0;
    await fire('sfu:produced', { kind: 'audio' });
    // Ses uretimi grid gorunumunu degistirmez; gereksiz yayin yapilmaz.
    expect(io.emitted).toHaveLength(0);
  });
});
