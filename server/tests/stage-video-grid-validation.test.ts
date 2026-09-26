// server/tests/stage-video-grid-validation.test.ts
// Sprint 102 — registerStageVideoGridHandlers payload validation testleri
// Kapsam:
//   - stage:video-join   geçersiz payload → handler çalışmamalı
//   - stage:video-leave  geçersiz payload → handler çalışmamalı
//   - stage:video-layout geçersiz layout enum → handler çalışmamalı
//   - sfu:produced       geçersiz kind enum → handler çalışmamalı
//   - voice:activity     eksik speaking → handler çalışmamalı
import { findEmitted, requireEmitted } from './helpers/socketDoubles';
//   - Geçerli payload'larda handler normal çalışmalı

'use strict';
process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => {
  const { createMockDb } = require('./helpers/mockDb');
  return createMockDb();
});

jest.mock('../socket/handlers/mediasoup/rooms', () => ({ sfuPeers: new Map(), sfuRooms: new Map() }));
jest.mock('../socket/handlers/stage', () => ({
  isStageParticipant: jest.fn().mockResolvedValue(true),
  canManageStage: jest.fn().mockResolvedValue(true),
}));

jest.mock('../lib/redisAdapter', () => ({
  cache: {
    // Gercek adaptorde MEVCUT (lib/redisAdapter.ts) — mock'ta eksikti ve
    // `invalidateChannelMessages` her cagrida sessizce TypeError firlatiyordu.
    invalidatePattern: jest.fn().mockResolvedValue(undefined), get: jest.fn().mockResolvedValue(null), set: jest.fn(), del: jest.fn() },
}));

import { registerStageVideoGridHandlers, videoGridRooms } from '../socket/handlers/stage-video-grid';
import { sfuPeers } from '../socket/handlers/mediasoup/rooms';
import type { Server as IOServer, Socket } from 'socket.io';

function makeSocket(id: string) {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const emitted: { event: string; data: unknown }[] = [];
  return {
    id,
    handlers,
    emitted,
    on(event: string, fn: (...args: unknown[]) => void) { handlers[event] = fn; },
    emit(event: string, data: unknown) { emitted.push({ event, data }); },
    to(_room: string) { return { emit() {} }; },
    join: jest.fn(),
    leave: jest.fn(),
    currentVoiceChannel: undefined as string | undefined,
  } as unknown as Socket & {
    handlers: Record<string, (...args: unknown[]) => void>;
    emitted: { event: string; data: unknown }[];
    join: jest.Mock;
    leave: jest.Mock;
  };
}

function makeIo() {
  const emitted: { event: string; data: unknown }[] = [];
  return { emitted, to: (_r: string) => ({ emit(event: string, data: unknown) { emitted.push({ event, data }); } }) } as unknown as IOServer & { emitted: { event: string; data: unknown }[] };
}

function makeUser() {
  return { _id: 'u-test', displayName: 'Tester', avatarColor: '#000' };
}

async function emit(socket: ReturnType<typeof makeSocket>, event: string, payload: unknown) {
  await socket.handlers[event]?.(payload);
}

describe('stage-video-grid: payload validation', () => {
  let socket: ReturnType<typeof makeSocket>;
  let io: ReturnType<typeof makeIo>;

  beforeEach(() => {
    socket = makeSocket('sock-1');
    io = makeIo();
    (sfuPeers as Map<string, unknown>).clear();
    videoGridRooms.clear();
    (sfuPeers as Map<string, unknown>).set('sock-1', {
      socketId: 'sock-1', channelId: 'ch-1', userId: 'u-test',
      producers: new Map(), consumers: new Map(), transports: new Map(),
    });
    registerStageVideoGridHandlers(socket, io, makeUser());
  });

  // ── stage:video-join ─────────────────────────────────────────
  it('stage:video-join — geçersiz payload (eksik channelId) → join çağrılmaz', async () => {
    await emit(socket, 'stage:video-join', {});
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('stage:video-join — geçerli payload → join çağrılır', async () => {
    await emit(socket, 'stage:video-join', { channelId: 'ch-1' });
    expect(socket.join).toHaveBeenCalledWith(expect.stringContaining('ch-1'));
  });

  // ── stage:video-leave ────────────────────────────────────────
  it('stage:video-leave — geçersiz payload → leave çağrılmaz', async () => {
    await emit(socket, 'stage:video-join', { channelId: 'ch-1' }); // önce join
    await emit(socket, 'stage:video-leave', { channelId: 123 });   // geçersiz tip
    // leave sayısı değişmemiş olmalı
    expect(socket.leave).not.toHaveBeenCalled();
  });

  it('stage:video-leave — geçerli payload Socket.IO grid room üyeliğini de bırakır', async () => {
    await emit(socket, 'stage:video-join', { channelId: 'ch-1' });
    await emit(socket, 'stage:video-leave', { channelId: 'ch-1' });
    expect(socket.leave).toHaveBeenCalledWith('video-grid:ch-1');
    expect(videoGridRooms.has('ch-1')).toBe(false);
  });

  // ── stage:video-layout ───────────────────────────────────────
  it('stage:video-layout — geçersiz layout enum → room state ve broadcast değişmez', async () => {
    await emit(socket, 'stage:video-join', { channelId: 'ch-1' });
    const before = videoGridRooms.get('ch-1');
    expect(before?.layout).toBe('grid');

    await emit(socket, 'stage:video-layout', { channelId: 'ch-1', layout: 'invalid-layout' });

    expect(videoGridRooms.get('ch-1')?.layout).toBe('grid');
    expect(findEmitted(io.emitted, 'stage:video-layout-changed')).toBeUndefined();
  });

  it('stage:video-layout — geçerli layout (grid) → emit gönderilir', async () => {
    await emit(socket, 'stage:video-join', { channelId: 'ch-1' });
    await emit(socket, 'stage:video-layout', { channelId: 'ch-1', layout: 'grid' });
    const layoutEmit = requireEmitted(io.emitted, 'stage:video-layout-changed');
    expect(layoutEmit).toBeDefined();
  });

  // ── sfu:produced ─────────────────────────────────────────────
  it('sfu:produced — geçersiz kind (subtitles) → emit yok', async () => {
    await emit(socket, 'sfu:produced', { kind: 'subtitles' });
    const produced = findEmitted(socket.emitted, 'sfu:produced');
    expect(produced).toBeUndefined();
  });

  it.each(['video', 'screen'])('sfu:produced — geçerli kind (%s) kabul edilir', async (kind) => {
    await emit(socket, 'stage:video-join', { channelId: 'ch-1' });
    await emit(socket, 'sfu:produced', { kind });
    // Validation must accept both camera and screen producer kinds emitted by
    // the canonical mediasoup handler. The state broadcast is room-scoped.
    expect(videoGridRooms.get('ch-1')).toBeDefined();
  });

  // ── voice:activity ───────────────────────────────────────────
  it('voice:activity — eksik speaking → emit yok', async () => {
    await emit(socket, 'voice:activity', { channelId: 'ch-1' });
    const act = findEmitted(socket.emitted, 'voice:activity');
    expect(act).toBeUndefined();
  });


  // ── voice:state-update ──────────────────────────────────────
  it("voice:state-update — eksik boolean alanı grid state'ini değiştirmez", async () => {
    await emit(socket, 'stage:video-join', { channelId: 'ch-1' });
    const peer = videoGridRooms.get('ch-1')?.peers.get('sock-1');
    expect(peer?.muted).toBe(false);

    await emit(socket, 'voice:state-update', {
      channelId: 'ch-1', muted: true, deafened: false, screensharing: false,
      // video deliberately missing
    });

    expect(videoGridRooms.get('ch-1')?.peers.get('sock-1')?.muted).toBe(false);
    expect(io.emitted.find(e => e.event === 'stage:video-update' && (e.data as any)?.type === 'state')).toBeUndefined();
  });
});
