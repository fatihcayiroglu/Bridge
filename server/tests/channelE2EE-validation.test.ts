// server/tests/channelE2EE-validation.test.ts
// Sprint 102 — registerChannelE2EEHandlers payload validation testleri
// Kapsam:
//   - channel:e2ee:status  eksik/geçersiz channelId → işlem yapılmaz
//   - channel:e2ee:keys:get geçersiz payload → işlem yapılmaz
//   - channel:e2ee:keys:add (setup gerektirmez, sadece erken çıkış)
//   - Geçerli payload'larda handler normal çalışmalı
import { findEmitted, requireEmitted } from './helpers/socketDoubles';

'use strict';
process.env.NODE_ENV      = 'test';
process.env.JWT_SECRET    = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';

jest.mock('../db/loader', () => {
  const { createMockDb } = require('./helpers/mockDb');
  return createMockDb();
});

jest.mock('../lib/redisAdapter', () => ({
  cache: {
    // Gercek adaptorde MEVCUT (lib/redisAdapter.ts) — mock'ta eksikti ve
    // `invalidateChannelMessages` her cagrida sessizce TypeError firlatiyordu.
    invalidatePattern: jest.fn().mockResolvedValue(undefined), get: jest.fn().mockResolvedValue(null), set: jest.fn(), del: jest.fn() },
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
    const errEmit = findEmitted(socket.emitted, 'channel:e2ee:error');
    // validation should block before any db call, no error emit expected
    expect(errEmit).toBeUndefined();
  });

  it('channel:e2ee:status — geçerli channelId → istemciye KESİN bir cevap döner', async () => {
    // VAKUMLUYDU (Final21 Faz 17): gövdesi yalnızca "// no crash expected" diyordu ve hiçbir
    // şey doğrulamıyordu. Oysa sözleşme sessiz kalmamaktır: istemci bu cevabı bekler ve
    // gelmezse kilit simgesi belirsiz kalır. Handler hiç cevap vermese de test GEÇİYORDU.
    emit(socket, 'channel:e2ee:status', { channelId: 'ch-e2ee-1' });
    await new Promise((r) => setTimeout(r, 20));

    const result = requireEmitted(socket.emitted, 'channel:e2ee:status:result');
    expect(result.data).toMatchObject({ channelId: 'ch-e2ee-1' });
    expect(typeof (result.data as { enabled?: unknown }).enabled).toBe('boolean');
  });

  // ── channel:e2ee:keys:get ────────────────────────────────────
  it('channel:e2ee:keys:get — eksik channelId → erken çıkış', async () => {
    emit(socket, 'channel:e2ee:keys:get', {});
    await new Promise(r => setTimeout(r, 10));
    const keysEmit = findEmitted(socket.emitted, 'channel:e2ee:keys');
    expect(keysEmit).toBeUndefined();
  });

  it('channel:e2ee:keys:get — channelId çok uzun (>64 karakter) → erken çıkış', async () => {
    emit(socket, 'channel:e2ee:keys:get', { channelId: 'x'.repeat(65) });
    await new Promise(r => setTimeout(r, 10));
    const keysEmit = findEmitted(socket.emitted, 'channel:e2ee:keys');
    expect(keysEmit).toBeUndefined();
  });

  // ── channel:e2ee:setup — no-payload event ───────────────────
  it('channel:e2ee:setup — payload gerektirmez, çağrı yapılabilir', () => {
    // setup has no payload schema requirement
    expect(() => emit(socket, 'channel:e2ee:setup', undefined)).not.toThrow();
  });
});
