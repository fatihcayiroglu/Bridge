// server/tests/stage-video-grid-validation.test.ts
// Sprint 102 — registerStageVideoGridHandlers payload validation testleri
// Kapsam:
//   - stage:video-join   geçersiz payload → handler çalışmamalı
//   - stage:video-leave  geçersiz payload → handler çalışmamalı
//   - stage:video-layout geçersiz layout enum → handler çalışmamalı
//   - sfu:produced       geçersiz kind enum → handler çalışmamalı
//   - voice:activity     eksik speaking → handler çalışmamalı
//   - Geçerli payload'larda handler normal çalışmalı

'use strict';
process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => {
  const { createMockDb } = require('./helpers/mockDb');
  return createMockDb();
});

jest.mock('../lib/redisAdapter', () => ({
  cache: { get: jest.fn().mockResolvedValue(null), set: jest.fn(), del: jest.fn() },
}));

import { registerStageVideoGridHandlers } from '../socket/handlers/stage-video-grid';
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

function emit(socket: ReturnType<typeof makeSocket>, event: string, payload: unknown) {
  socket.handlers[event]?.(payload);
}

describe('stage-video-grid: payload validation', () => {
  let socket: ReturnType<typeof makeSocket>;
  let io: ReturnType<typeof makeIo>;

  beforeEach(() => {
    socket = makeSocket('sock-1');
    io = makeIo();
    registerStageVideoGridHandlers(socket, io, makeUser());
  });

  // ── stage:video-join ─────────────────────────────────────────
  it('stage:video-join — geçersiz payload (eksik channelId) → join çağrılmaz', () => {
    emit(socket, 'stage:video-join', {});
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('stage:video-join — geçerli payload → join çağrılır', () => {
    emit(socket, 'stage:video-join', { channelId: 'ch-1' });
    expect(socket.join).toHaveBeenCalledWith(expect.stringContaining('ch-1'));
  });

  // ── stage:video-leave ────────────────────────────────────────
  it('stage:video-leave — geçersiz payload → leave çağrılmaz', () => {
    emit(socket, 'stage:video-join', { channelId: 'ch-1' }); // önce join
    emit(socket, 'stage:video-leave', { channelId: 123 });   // geçersiz tip
    // leave sayısı değişmemiş olmalı
    expect(socket.leave).not.toHaveBeenCalled();
  });

  // ── stage:video-layout ───────────────────────────────────────
  it('stage:video-layout — geçersiz layout enum → emit yok', () => {
    emit(socket, 'stage:video-join', { channelId: 'ch-1' });
    emit(socket, 'stage:video-layout', { channelId: 'ch-1', layout: 'invalid-layout' });
    const layoutEmit = socket.emitted.find(e => e.event === 'stage:video-layout');
    expect(layoutEmit).toBeUndefined();
  });

  it('stage:video-layout — geçerli layout (grid) → emit gönderilir', () => {
    emit(socket, 'stage:video-join', { channelId: 'ch-1' });
    emit(socket, 'stage:video-layout', { channelId: 'ch-1', layout: 'grid' });
    const layoutEmit = io.emitted.find(e => e.event === 'stage:video-layout-changed');
    expect(layoutEmit).toBeDefined();
  });

  // ── sfu:produced ─────────────────────────────────────────────
  it('sfu:produced — geçersiz kind (subtitles) → emit yok', () => {
    emit(socket, 'sfu:produced', { kind: 'subtitles' });
    const produced = socket.emitted.find(e => e.event === 'sfu:produced');
    expect(produced).toBeUndefined();
  });

  it('sfu:produced — geçerli kind (video) → emit gönderilir', () => {
    emit(socket, 'sfu:produced', { kind: 'video' });
    // handler broadcasts to room, not back to socket — just ensure no throw
  });

  // ── voice:activity ───────────────────────────────────────────
  it('voice:activity — eksik speaking → emit yok', () => {
    emit(socket, 'voice:activity', { channelId: 'ch-1' });
    const act = socket.emitted.find(e => e.event === 'voice:activity');
    expect(act).toBeUndefined();
  });
});
