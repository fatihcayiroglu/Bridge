// server/tests/channelE2EE-validation.test.ts
// Sprint 102 — registerChannelE2EEHandlers payload validation testleri
// Kapsam:
//   - channel:e2ee:status  eksik/geçersiz channelId → işlem yapılmaz
//   - channel:e2ee:keys:get geçersiz payload → işlem yapılmaz
//   - channel:e2ee:keys:add (setup gerektirmez, sadece erken çıkış)
//   - Geçerli payload'larda handler normal çalışmalı

'use strict';
process.env.NODE_ENV      = 'test';
process.env.JWT_SECRET    = 'test-jwt-secret';
process.env.REFRESH_SECRET = 'test-refresh-secret';

jest.mock('../db/loader', () => {
  const { createMockDb } = require('./helpers/mockDb');
  return createMockDb();
});

jest.mock('../lib/redisAdapter', () => ({
  cache: { get: jest.fn().mockResolvedValue(null), set: jest.fn(), del: jest.fn() },
}));

import { registerChannelE2EEHandlers } from '../socket/handlers/channelE2EEHandlers';
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
    to(_room: string) { return { emit: jest.fn() }; },
    join: jest.fn(),
  } as unknown as Socket & {
    handlers: Record<string, (...args: unknown[]) => void>;
    emitted: { event: string; data: unknown }[];
  };
}

function makeIo() {
  return { to: (_r: string) => ({ emit: jest.fn() }) } as unknown as IOServer;
}

function emit(socket: ReturnType<typeof makeSocket>, event: string, payload: unknown) {
  socket.handlers[event]?.(payload);
}

describe('channelE2EEHandlers: payload validation', () => {
  let socket: ReturnType<typeof makeSocket>;
  const user = { _id: 'u-e2ee', username: 'tester', roles: [] as string[] };

  beforeEach(() => {
    socket = makeSocket('sock-e2ee');
    registerChannelE2EEHandlers(socket, makeIo(), user);
  });

  // ── channel:e2ee:status ──────────────────────────────────────
  it('channel:e2ee:status — eksik channelId → error emit yok', async () => {
    emit(socket, 'channel:e2ee:status', {});
    await new Promise(r => setTimeout(r, 10));
    const errEmit = socket.emitted.find(e => e.event === 'channel:e2ee:error');
    // validation should block before any db call, no error emit expected
    expect(errEmit).toBeUndefined();
  });

  it('channel:e2ee:status — geçerli channelId → db sorgular (hata vermez)', async () => {
    // DB mock varsayılan olarak null döner; handler gracefully tamamlanmalı
    emit(socket, 'channel:e2ee:status', { channelId: 'ch-e2ee-1' });
    await new Promise(r => setTimeout(r, 20));
    // no crash expected
  });

  // ── channel:e2ee:keys:get ────────────────────────────────────
  it('channel:e2ee:keys:get — eksik channelId → erken çıkış', async () => {
    emit(socket, 'channel:e2ee:keys:get', {});
    await new Promise(r => setTimeout(r, 10));
    const keysEmit = socket.emitted.find(e => e.event === 'channel:e2ee:keys');
    expect(keysEmit).toBeUndefined();
  });

  it('channel:e2ee:keys:get — channelId çok uzun (>64 karakter) → erken çıkış', async () => {
    emit(socket, 'channel:e2ee:keys:get', { channelId: 'x'.repeat(65) });
    await new Promise(r => setTimeout(r, 10));
    const keysEmit = socket.emitted.find(e => e.event === 'channel:e2ee:keys');
    expect(keysEmit).toBeUndefined();
  });

  // ── channel:e2ee:setup — no-payload event ───────────────────
  it('channel:e2ee:setup — payload gerektirmez, çağrı yapılabilir', () => {
    // setup has no payload schema requirement
    expect(() => emit(socket, 'channel:e2ee:setup', undefined)).not.toThrow();
  });
});
